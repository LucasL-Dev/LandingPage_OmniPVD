import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { billingRuntime } from './billing/runtime.mjs';
import { authRuntime } from './auth/runtime.mjs';
import { deploymentOrigins, DEFAULT_SITE_ORIGIN } from './config/origins.mjs';
import { testStripeClient } from './config/stripe.mjs';

export const DEFAULT_DOMAIN = DEFAULT_SITE_ORIGIN;
export const DEFAULT_STRIPE_PRICE_ID = 'price_1UVCotRyOKs2Cpl0wvQXsmAi';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
export function createApp(stripe, billing = null, identity = null) {
return http.createServer(async (req, res) => {
  try {
    const origins = deploymentOrigins();
    const requestUrl = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(requestUrl.pathname);
    if (identity && await identity.handle(req, res, requestUrl)) return;
    if (!identity && (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/license/') || pathname === '/api/account/claim' || pathname === '/account/login' || pathname === '/.well-known/omnipvd-license-keys.json')) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"error":"licensing_unavailable"}'); return;
    }
    if (pathname === '/api/stripe/webhook') {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!stripe || !billing || !process.env.STRIPE_WEBHOOK_SECRET) { res.writeHead(503).end('Webhook indisponível.'); return; }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      let event;
      try {
        event = stripe.webhooks.constructEvent(Buffer.concat(chunks), req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
      } catch { res.writeHead(400).end('Assinatura inválida.'); return; }
      if (event.livemode !== false) { res.writeHead(400).end('Somente modo teste habilitado.'); return; }
      try {
        await billing.receive(event);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"received":true}');
      } catch { res.writeHead(503).end('Falha temporária; tente novamente.'); }
      return;
    }
    if (pathname === '/api/download') {
      if (!billing) { res.writeHead(503).end('Download indisponível.'); return; }
      await billing.download(req, res); return;
    }
    if (pathname === '/api/create-checkout-session') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      // The only browser cross-origin route. Auth, webhooks and downloads get no CORS headers.
      res.setHeader('Vary', 'Origin');
      const origin = req.headers.origin;
      if (origin && origin !== origins.site) {
        res.writeHead(403).end(JSON.stringify({ error: 'Origem não permitida.' })); return;
      }
      if (origin === origins.site) res.setHeader('Access-Control-Allow-Origin', origins.site);
      if (req.method === 'OPTIONS') {
        const method = req.headers['access-control-request-method'];
        const headers = (req.headers['access-control-request-headers'] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
        if (origin !== origins.site || method !== 'POST' || headers.some(value => value !== 'content-type')) {
          res.writeHead(403).end(JSON.stringify({ error: 'Preflight não permitido.' })); return;
        }
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.writeHead(204).end(); return;
      }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); res.writeHead(405).end(JSON.stringify({ error: 'Método não permitido.' })); return; }
      if (req.headers.cookie) { res.writeHead(400).end(JSON.stringify({ error: 'Checkout não utiliza cookies.' })); return; }
      if (!stripe) {
        res.writeHead(503).end(JSON.stringify({ error: 'A assinatura está sendo configurada. Tente novamente em breve.' })); return;
      }
      try {
        const domain = origins.site;
        const session = await stripe.checkout.sessions.create({
          ui_mode: 'hosted_page',
          mode: 'subscription',
          billing_address_collection: 'auto',
          phone_number_collection: { enabled: false },
          automatic_tax: { enabled: false },
          allow_promotion_codes: false,
          payment_method_collection: 'always',
          submit_type: 'auto',
          integration_identifier: 'hosted_web_0001',
          origin_context: 'web',
          success_url: `${domain}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${domain}/?checkout=cancelled#assinatura`,
          line_items: [{ price: process.env.STRIPE_PRICE_ID || DEFAULT_STRIPE_PRICE_ID, quantity: 1 }],
        });
        res.writeHead(200).end(JSON.stringify({ url: session.url }));
      } catch {
        res.writeHead(502).end(JSON.stringify({ error: 'Não foi possível abrir o pagamento. Tente novamente em instantes.' }));
      }
      return;
    }
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"status":"ok"}'); return;
    }
    if ((pathname === '/' || pathname === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(302, { Location: origins.site, 'Cache-Control': 'no-store' }).end(); return;
    }
    // Logo is required by the API-hosted account page. No commercial frontend or private files.
    if (pathname !== '/assets/omnipdv.png' || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404).end('Página não encontrada'); return;
    }
    const filename = path.join(root, 'assets', 'omnipdv.png');
    const body = await readFile(filename);
    res.writeHead(200, { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff' }).end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Página não encontrada'); }
});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  deploymentOrigins(); // Fail startup on malformed public URL configuration.
  const stripe = testStripeClient();
  const billing = billingRuntime(stripe, root, process.env.STRIPE_PRICE_ID || DEFAULT_STRIPE_PRICE_ID);
  if (billing) {
    const tick = () => billing.runQueue().catch(() => console.error('Fila indisponível; verifique a configuração privada.'));
    setInterval(tick, 30_000).unref();
    tick();
  }
  const identity = await authRuntime({stripe, billing, projectRoot: root, priceId: process.env.STRIPE_PRICE_ID || DEFAULT_STRIPE_PRICE_ID});
  createApp(stripe, billing, identity).listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.log(`OmniPDV iniciado na porta ${process.env.PORT || 3000}`));
}
