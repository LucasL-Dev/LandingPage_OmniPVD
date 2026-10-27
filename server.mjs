import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Stripe from 'stripe';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
export function createApp(stripe) {
return http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/create-checkout-session') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.writeHead(405).end(JSON.stringify({ error: 'Método não permitido.' })); return; }
      if (!stripe || !process.env.DOMAIN || !process.env.STRIPE_PRICE_ID) {
        res.writeHead(503).end(JSON.stringify({ error: 'A assinatura está sendo configurada. Tente novamente em breve.' })); return;
      }
      try {
        const domain = new URL(process.env.DOMAIN).origin;
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
          line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
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
  const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  createApp(stripe).listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`OmniPDV iniciado na porta ${process.env.PORT || 3000}`));
}
