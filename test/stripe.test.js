import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { stripeWebhookIsValid, subscriptionCheckoutSessionFields } from '../src/lib/stripe.js';

test('Stripe webhooks require a current signed raw payload', () => {
  const secret = 'whsec_test_secret';
  const timestamp = 1_790_000_000;
  const rawBody = Buffer.from('{"id":"evt_test"}');
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
  assert.equal(stripeWebhookIsValid(rawBody, `t=${timestamp},v1=${signature}`, secret, timestamp * 1000), true);
  assert.equal(stripeWebhookIsValid(rawBody, `t=${timestamp},v1=${'0'.repeat(64)}`, secret, timestamp * 1000), false);
  assert.equal(stripeWebhookIsValid(Buffer.from('{"id":"changed"}'), `t=${timestamp},v1=${signature}`, secret, timestamp * 1000), false);
  assert.equal(stripeWebhookIsValid(rawBody, `t=${timestamp},v1=${signature}`, secret, (timestamp + 301) * 1000), false);
});

test('subscription Checkout exposes Stripe-managed promotion-code entry', () => {
  const fields = subscriptionCheckoutSessionFields({
    appUrl: 'https://clarity.example.test',
    userKey: 'a'.repeat(64),
    priceId: 'price_plus',
    integrationIdentifier: 'clarity_plus_abcdefgh',
    customerId: 'cus_existing',
    customerEmail: 'member@example.test'
  });

  assert.equal(fields.allow_promotion_codes, true);
  assert.equal(fields.discounts, undefined);
  assert.equal(fields.customer, 'cus_existing');
  assert.equal(fields.customer_email, undefined);
  assert.deepEqual(fields.line_items, [{ price: 'price_plus', quantity: 1 }]);
  assert.equal(fields.subscription_data.trial_period_days, 14);
});

test('subscription Checkout uses email only when no Stripe customer exists', () => {
  const fields = subscriptionCheckoutSessionFields({
    appUrl: 'https://clarity.example.test',
    userKey: 'b'.repeat(64),
    priceId: 'price_plus',
    integrationIdentifier: 'clarity_plus_hgfedcba',
    customerEmail: 'new-member@example.test'
  });

  assert.equal(fields.customer, undefined);
  assert.equal(fields.customer_email, 'new-member@example.test');
});
