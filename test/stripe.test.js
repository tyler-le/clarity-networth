import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { stripeWebhookIsValid } from '../src/lib/stripe.js';

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
