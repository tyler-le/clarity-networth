import test from 'node:test';
import assert from 'node:assert/strict';
import { customerError, httpErrorCode, plaidErrorCode, publicErrorPayload } from '../public/customer-error.js';

test('dependency errors expose a recovery path without provider diagnostics', () => {
  assert.equal(plaidErrorCode('ITEM_LOGIN_REQUIRED'), 'reconnect_required');
  assert.equal(plaidErrorCode('INSTITUTION_NOT_RESPONDING'), 'institution_unavailable');
  assert.equal(plaidErrorCode('PRODUCT_NOT_READY'), 'data_preparing');
  assert.equal(plaidErrorCode('an_internal_provider_code'), 'connection_unavailable');

  const safe = customerError(plaidErrorCode('an_internal_provider_code'));
  assert.equal(safe.message, 'We could not start a secure connection right now. Please try again shortly.');
  assert.equal(safe.recovery, 'retry_later');
  assert.doesNotMatch(safe.message, /provider|internal|code/i);
});

test('rate-limit errors preserve an actionable wait time for the interface', () => {
  assert.equal(httpErrorCode({ status: 429 }), 'rate_limited');
  const payload = publicErrorPayload('rate_limited', { retryAfterSeconds: 90 });
  assert.deepEqual(payload, {
    error: 'Please wait before trying again. Try again in 2 minutes.',
    error_code: 'rate_limited',
    recovery: 'wait',
    retry_after_seconds: 90
  });
});

test('a Free-plan institution limit directs the member to unlink instead of exposing billing internals', () => {
  assert.equal(httpErrorCode({ status: 403, errorCode: 'institution_limit_reached' }), 'institution_limit_reached');
  assert.deepEqual(publicErrorPayload('institution_limit_reached'), {
    error: 'Your Free plan includes two connected institutions. Unlink one to connect another.',
    error_code: 'institution_limit_reached',
    recovery: 'manage_connections'
  });
});

test('a Free-plan history limit points to Plus without exposing billing internals', () => {
  assert.deepEqual(publicErrorPayload('full_history_required'), {
    error: 'All available history is included with Clarity Plus.',
    error_code: 'full_history_required',
    recovery: 'upgrade'
  });
});
