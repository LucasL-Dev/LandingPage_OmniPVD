import Stripe from 'stripe';

export function testStripeClient(secret = process.env.STRIPE_SECRET_KEY, options = {}) {
  if (!secret) return null;
  if (!/^(sk|rk)_test_/.test(secret)) throw new Error('Somente chave Stripe de teste é permitida nesta etapa.');
  return new Stripe(secret, options);
}
