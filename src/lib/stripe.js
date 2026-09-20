import crypto from 'node:crypto';
import Stripe from 'stripe';

function configured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function stripeBillingConfigured() {
  return configured(process.env.STRIPE_SECRET_KEY)
    && configured(process.env.STRIPE_WEBHOOK_SECRET)
    && configured(process.env.STRIPE_PLUS_PRICE_ID)
    && configured(process.env.PUBLIC_APP_URL);
}

// Keep Stripe behind one client factory so requests use the current SDK,
// retries, and API version rather than hand-rolled authenticated fetch calls.
export function stripeClient(secretKey = process.env.STRIPE_SECRET_KEY) {
  if (!configured(secretKey)) throw new Error('Stripe billing is not configured.');
  return new Stripe(secretKey, {
    apiVersion: '2026-08-26.dahlia',
    maxNetworkRetries: 2,
    timeout: 15_000
  });
}

export function stripeWebhookIsValid(rawBody, signatureHeader, secret = process.env.STRIPE_WEBHOOK_SECRET, now = Date.now()) {
  if (!Buffer.isBuffer(rawBody) || !configured(secret) || typeof signatureHeader !== 'string') return false;
  const parts = signatureHeader.split(',').map((part) => part.trim());
  const timestamp = Number(parts.find((part) => part.startsWith('t='))?.slice(2));
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp * 1000) > 5 * 60_000 || !signatures.length) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
  return signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature) || signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  });
}
