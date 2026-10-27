import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Stripe from 'stripe';
import { loadEnvFile } from 'node:process';
import { billingRuntime } from './billing/runtime.mjs';

export const DEFAULT_DOMAIN = 'https://mediumslateblue-falcon-614408.hostingersite.com';
export const DEFAULT_STRIPE_PRICE_ID = 'price_1UVCotRyOKs2Cpl0wvQXsmAi';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
export function createApp(stripe, billing = null) {
return http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
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
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.writeHead(405).end(JSON.stringify({ error: 'Método não permitido.' })); return; }
      if (!stripe) {
        res.writeHead(503).end(JSON.stringify({ error: 'A assinatura está sendo configurada. Tente novamente em breve.' })); return;
      }
      try {
        const domain = new URL(process.env.DOMAIN || DEFAULT_DOMAIN).origin;
        if (req.headers.origin && req.headers.origin !== domain) {
          res.writeHead(403).end(JSON.stringify({ error: 'Origem não permitida.' })); return;
        }
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
    // Somente arquivos públicos: nunca servir .env, Git, dependências ou código do servidor.
    if (!['/', '/index.html', '/styles.css', '/app.js', '/assets/omnipdv.png', '/assets/omnipdv-app.png'].includes(pathname)) {
      res.writeHead(404).end('Página não encontrada'); return;
    }
    const filename = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(filename);
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }).end(body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Página não encontrada'); }
});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  const billing = billingRuntime(stripe, root, process.env.STRIPE_PRICE_ID || DEFAULT_STRIPE_PRICE_ID);
  if (billing) {
    const tick = () => billing.runQueue().catch(() => console.error('Fila indisponível; verifique a configuração privada.'));
    setInterval(tick, 30_000).unref();
    tick();
  }
  createApp(stripe, billing).listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`OmniPDV iniciado na porta ${process.env.PORT || 3000}`));
}
