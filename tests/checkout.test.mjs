import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, DEFAULT_STRIPE_PRICE_ID, DEFAULT_DOMAIN } from '../server.mjs';

test('checkout: configuração, parâmetros, erros e proteção de arquivos', async () => {
  process.env.DOMAIN = 'https://omnipdv.example';
  process.env.STRIPE_PRICE_ID = 'price_test_fixture';
  let params, fail = false;
  const stripe = { checkout: { sessions: { async create(input) {
    if (fail) throw new Error('private Stripe details');
    params = input; return { url: 'https://checkout.stripe.com/c/pay/test_fixture' };
  } } } };
  const server = createApp(stripe);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await fetch(`${base}/api/create-checkout-session`, { method: 'POST' });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).url, 'https://checkout.stripe.com/c/pay/test_fixture');
    assert.deepEqual(params, {
      ui_mode: 'hosted_page', mode: 'subscription', billing_address_collection: 'auto',
      phone_number_collection: { enabled: false }, automatic_tax: { enabled: false },
      allow_promotion_codes: false, payment_method_collection: 'always', submit_type: 'auto',
      integration_identifier: 'hosted_web_0001', origin_context: 'web',
      success_url: 'https://omnipdv.example/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://omnipdv.example/?checkout=cancelled#assinatura',
      line_items: [{ price: 'price_test_fixture', quantity: 1 }],
    });
    assert.equal((await fetch(`${base}/api/create-checkout-session`)).status, 405);
    assert.equal((await fetch(`${base}/api/create-checkout-session`, {method:'POST',headers:{Origin:'https://other.example'}})).status, 403);
    fail = true;
    const error = await fetch(`${base}/api/create-checkout-session`, {method:'POST'});
    assert.equal(error.status, 502);
    assert.ok(!(await error.text()).includes('private Stripe details'));
    delete process.env.STRIPE_PRICE_ID;
    fail = false;
    assert.equal((await fetch(`${base}/api/create-checkout-session`, {method:'POST'})).status, 200);
    assert.equal(params.line_items[0].price, DEFAULT_STRIPE_PRICE_ID);
    delete process.env.DOMAIN;
    assert.equal((await fetch(`${base}/api/create-checkout-session`, {method:'POST'})).status, 200);
    assert.equal(params.cancel_url, `${DEFAULT_DOMAIN}/?checkout=cancelled#assinatura`);
    for (const file of ['/.env', '/server.mjs', '/package-lock.json', '/.git/config']) assert.equal((await fetch(base+file)).status,404);
    assert.equal((await fetch(base+'/')).status,200);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('checkout sem chave retorna indisponibilidade', async () => {
  const server = createApp(null);
  await new Promise(resolve=>server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/create-checkout-session`, {method:'POST'});
    assert.equal(response.status, 503);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
