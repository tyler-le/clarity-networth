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

// Keep Stripe behind one client factory so requests use the current SDK and
// retries rather than hand-rolled authenticated fetch calls. Managed Payments
// requires the preview API version specified by the integration blueprint.
export function stripeClient(secretKey = process.env.STRIPE_SECRET_KEY) {
  if (!configured(secretKey)) throw new Error('Stripe billing is not configured.');
  return new Stripe(secretKey, {
    apiVersion: '2026-02-25.preview',
    maxNetworkRetries: 2,
    timeout: 15_000
  });
}

// Promotion codes are created and governed in Stripe. Keeping redemption in
// Checkout means code validity, product restrictions, and redemption limits
// are enforced by Stripe instead of being duplicated in our application.
export function subscriptionCheckoutSessionFields({
  appUrl,
  userKey,
  priceId,
  integrationIdentifier,
  customerId,
  customerEmail
}) {
  const fields = {
    mode: 'subscription',
    // Let members experience Plus without entering billing details up front.
    // They can add a payment method during the trial before choosing to
    // continue as a paid subscriber.
    payment_method_collection: 'if_required',
    integration_identifier: integrationIdentifier,
    client_reference_id: userKey,
    success_url: `${appUrl}/?billing=success`,
    cancel_url: `${appUrl}/?billing=cancelled`,
    // This makes Stripe Checkout show its promotion-code entry. It must not be
    // combined with a pre-applied discount on the same Checkout Session.
    allow_promotion_codes: true,
    // The sandbox Product is classified with the blueprint's eligible
    // digital-service tax code. Stripe owns tax calculation and collection
    // for this Managed Payments Checkout flow.
    managed_payments: { enabled: true },
    metadata: { user_key: userKey },
    subscription_data: { trial_period_days: 14, metadata: { user_key: userKey } },
    line_items: [{ price: priceId, quantity: 1 }]
  };
  if (customerId) fields.customer = customerId;
  else if (customerEmail) fields.customer_email = customerEmail;
  return fields;
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
