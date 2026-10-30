import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, chmodSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { buildWelcomeEmail } from '../emails/render-welcome.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' ? value : value?.id;
const subscriptionId = invoice => id(invoice.parent?.subscription_details?.subscription || invoice.subscription);
const supported = new Set(['invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']);

export function createBilling({ stripe, resend, config, now = () => Date.now() }) {
  const allowed = sub => sub?.status === 'active' && sub.paid_until > Math.floor(now() / 1000);
  if (!config.dbPath || !path.isAbsolute(config.dbPath)) throw new Error('BILLING_DB_PATH deve ser absoluto e persistente.');
  mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });
  const projectRoot = realpathSync(config.projectRoot);
  const dbDirectory = realpathSync(path.dirname(config.dbPath));
  if (dbDirectory === projectRoot || dbDirectory.startsWith(projectRoot + path.sep)) throw new Error('Banco deve estar fora do checkout.');
  const db = new DatabaseSync(config.dbPath);
  chmodSync(config.dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, type TEXT NOT NULL, processed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL, paid_until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries(subscription_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, invoice_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      first_at INTEGER, lease_until INTEGER NOT NULL DEFAULT 0, payload TEXT, resend_id TEXT, last_error TEXT);
    CREATE TABLE IF NOT EXISTS downloads(token_hash TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, customer_id TEXT NOT NULL, expires_at INTEGER NOT NULL);`);

  async function snapshot(sid) {
    const sub = await stripe.subscriptions.retrieve(sid, { expand: ['customer', 'latest_invoice', 'items.data.price.product'] });
    const latest = typeof sub.latest_invoice === 'string' ? await stripe.invoices.retrieve(sub.latest_invoice) : sub.latest_invoice;
    const matches = sub.items?.data?.some(item => item.price?.id === config.priceId);
    const paid = latest?.status === 'paid' && latest?.paid !== false;
    const paidUntil = paid ? Math.max(0, ...(latest.lines?.data || []).map(line => Number(line.period?.end) || 0)) : 0;
    return { sub, record: { id: sid, customer_id: id(sub.customer), status: matches && paid && sub.status === 'active' ? 'active' : sub.status === 'canceled' ? 'canceled' : 'blocked', paid_until: paidUntil } };
  }
  function saveRecord(record) {
    db.prepare('INSERT INTO subscriptions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id,status=excluded.status,paid_until=excluded.paid_until').run(record.id, record.customer_id, record.status, record.paid_until);
  }
  async function receive(event) {
    if (event.livemode !== false) throw new Error('Somente eventos Stripe de teste são aceitos nesta etapa.');
    if (db.prepare('SELECT 1 FROM events WHERE id=?').get(event.id)) return;
    let state, invoice;
    if (supported.has(event.type)) {
      if (event.type.startsWith('invoice.')) {
        invoice = await stripe.invoices.retrieve(event.data.object.id);
        const sid = subscriptionId(invoice);
        if (sid) state = await snapshot(sid);
      } else state = await snapshot(event.data.object.id);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('SELECT 1 FROM events WHERE id=?').get(event.id)) {
        if (state) {
          saveRecord(state.record);
          if (event.type === 'invoice.paid' && invoice?.status === 'paid' && invoice?.paid !== false && invoice.billing_reason === 'subscription_create' && allowed(state.record)) {
            db.prepare('INSERT OR IGNORE INTO deliveries(subscription_id,customer_id,invoice_id) VALUES(?,?,?)').run(state.record.id, state.record.customer_id, invoice.id);
          }
        }
        db.prepare('INSERT INTO events VALUES(?,?,?)').run(event.id, event.type, now());
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function installerPath() {
    if (!config.downloadEnabled || !config.installerPath || !path.isAbsolute(config.installerPath)) throw new Error('Download privado não configurado.');
    const filename = await realpath(config.installerPath);
    const root = await realpath(config.projectRoot);
    if (filename === root || filename.startsWith(root + path.sep) || !filename.toLowerCase().endsWith('.exe')) throw new Error('Instalador deve estar fora do checkout.');
    const info = await stat(filename);
    if (!info.isFile() || info.size < 1 || info.size > (config.maxInstallerBytes || 2147483648)) throw new Error('Instalador indisponível.');
    const origin = new URL(config.downloadOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('DOWNLOAD_ORIGIN deve ser uma origem HTTPS.');
    return filename;
  }
  async function preparePayload(job, state) {
    const invoice = await stripe.invoices.retrieve(job.invoice_id);
    if (invoice.status !== 'paid' || invoice.paid === false || invoice.billing_reason !== 'subscription_create' || subscriptionId(invoice) !== job.subscription_id || id(invoice.customer) !== job.customer_id) throw new Error('Fatura inicial não autorizada.');
    const customer = typeof state.sub.customer === 'string' ? await stripe.customers.retrieve(state.sub.customer) : state.sub.customer;
    if (!customer?.email || customer.deleted) throw new Error('Cliente sem e-mail válido.');
    const price = state.sub.items.data.find(item => item.price.id === config.priceId)?.price;
    const recurring = price?.recurring;
    const units = { day: 'dia(s)', week: 'semana(s)', month: 'mês(es)', year: 'ano(s)' };
    if (!units[recurring?.interval]) throw new Error('Periodicidade não disponível.');
    const token = randomBytes(32).toString('base64url');
    const expires = now() + 48 * 60 * 60 * 1000;
    const downloadUrl = new URL('/api/download', config.downloadOrigin);
    downloadUrl.searchParams.set('token', token);
    const content = await buildWelcomeEmail({
      customerName: customer.name || 'Cliente OmniPVD',
      planName: price.product?.name || 'OmniPVD',
      price: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: invoice.currency.toUpperCase() }).format(invoice.amount_paid / 100),
      billingPeriod: `${recurring.interval_count} ${units[recurring.interval]}`,
      purchaseDate: new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(new Date((invoice.status_transitions?.paid_at || invoice.created) * 1000)),
      downloadUrl: downloadUrl.href, supportEmail: config.supportEmail,
    });
    const payload = { from: config.from, to: customer.email, replyTo: config.supportEmail, ...content };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO downloads VALUES(?,?,?,?)').run(hash(token), job.subscription_id, job.customer_id, expires);
      db.prepare('UPDATE deliveries SET payload=? WHERE subscription_id=?').run(JSON.stringify(payload), job.subscription_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return payload;
  }
  let busy = false, stopping = false;
  async function runQueue() {
    if (stopping || busy || !config.emailEnabled || !resend || !config.from || !config.supportEmail) return;
    busy = true;
    try {
      await installerPath(); // Nunca criar payload ou enviar com instalador indisponível.
      const jobs = db.prepare("SELECT * FROM deliveries WHERE status IN ('pending','retry','sending') AND next_at<=? AND lease_until<=? LIMIT 20").all(now(), now());
      for (const job of jobs) {
        if (stopping) break;
        if ((job.first_at && now() - job.first_at >= 23 * 60 * 60 * 1000) || job.attempts >= 8) {
          db.prepare("UPDATE deliveries SET status='manual_review',last_error='retry_window_exhausted' WHERE subscription_id=?").run(job.subscription_id); continue;
        }
        const claimed = db.prepare("UPDATE deliveries SET lease_until=?,status='sending' WHERE subscription_id=? AND lease_until<=?").run(now() + 5 * 60 * 1000, job.subscription_id, now());
        if (!claimed.changes) continue;
        try {
          const state = await snapshot(job.subscription_id);
          saveRecord(state.record);
          if (!allowed(state.record) || state.record.customer_id !== job.customer_id) {
            db.prepare("UPDATE deliveries SET status='retry',next_at=?,lease_until=0,last_error='subscription_not_authorized' WHERE subscription_id=?").run(now() + 60 * 1000, job.subscription_id); continue;
          }
          const payload = job.payload ? JSON.parse(job.payload) : await preparePayload(job, state);
          db.prepare('UPDATE deliveries SET attempts=attempts+1,first_at=COALESCE(first_at,?) WHERE subscription_id=?').run(now(), job.subscription_id);
          const result = await resend.emails.send(payload, { idempotencyKey: `omnipvd-welcome-${job.subscription_id}`, signal: AbortSignal.timeout(30_000) });
          if (result.error || !result.data?.id) {
            const failure=new Error('Envio não confirmado.');
            failure.deliveryCode=result.error?.name==='rate_limit_exceeded'?'provider_rate_limited':'provider_not_confirmed';throw failure;
          }
          db.prepare("UPDATE deliveries SET status='sent',resend_id=?,lease_until=0,last_error=NULL WHERE subscription_id=?").run(result.data.id, job.subscription_id);
        } catch (error) {
          const code=['provider_rate_limited','provider_not_confirmed'].includes(error.deliveryCode)?error.deliveryCode:'delivery_failed';
          db.prepare("UPDATE deliveries SET status='retry',next_at=?,lease_until=0,last_error=? WHERE subscription_id=?").run(now() + Math.min(3600, 30 * 2 ** job.attempts) * 1000, code, job.subscription_id);
        }
      }
    } finally { busy = false; }
  }
  let activeDownloads=0;
  async function download(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
    if(activeDownloads >= (config.maxDownloads || 4)){res.writeHead(503,{'Retry-After':'30'}).end('Tente novamente.');return;}
    activeDownloads++;let released=false;const release=()=>{if(!released){released=true;activeDownloads--;}};res.once('close',release);res.once('finish',release);
    try {
      const token = new URL(req.url, 'https://local.invalid').searchParams.get('token');
      const grant = token && token.length <= 100 && db.prepare('SELECT * FROM downloads WHERE token_hash=?').get(hash(token));
      if (!grant || grant.expires_at <= now()) { res.writeHead(403).end('Acesso expirado ou inválido.'); return; }
      const state = await snapshot(grant.subscription_id);
      saveRecord(state.record);
      if (!allowed(state.record) || state.record.customer_id !== grant.customer_id) { res.writeHead(403).end('Assinatura não autorizada.'); return; }
      const filename = await installerPath();
      const info = await stat(filename);
      if(res.destroyed)return;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="OmniPVD-Setup.exe"', 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff' });
      const stream = createReadStream(filename);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { if (!res.headersSent) res.writeHead(503).end('Download temporariamente indisponível.'); else res.destroy(); }
  }
  return { receive, runQueue, stopQueue:()=>{stopping=true;}, download, close: () => db.close(), db };
}
