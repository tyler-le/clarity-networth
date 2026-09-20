// This file is deliberately usable by both the browser and the server. It is
// the only catalog allowed to turn a dependency failure into customer copy.
// Codes describe a recovery path, never a vendor implementation detail.
const catalog = Object.freeze({
  session_expired: { message: 'Your session has expired. Please sign in again.', recovery: 'sign_in' },
  offline: { message: 'You’re offline. Reconnect to continue.', recovery: 'retry_when_online' },
  rate_limited: { message: 'Please wait before trying again.', recovery: 'wait' },
  institution_limit_reached: { message: 'Your Free plan includes two connected institutions. Unlink one to connect another.', recovery: 'manage_connections' },
  subscription_required: { message: 'Start your free trial to continue using Clarity.', recovery: 'upgrade' },
  reconnect_required: { message: 'Your institution needs you to sign in again to resume updates.', recovery: 'reconnect' },
  institution_unavailable: { message: 'Your institution is temporarily unavailable. Please try again later.', recovery: 'retry_later' },
  data_preparing: { message: 'Your institution is still preparing this data. We’ll keep trying automatically.', recovery: 'automatic_retry' },
  connection_unavailable: { message: 'We could not start a secure connection right now. Please try again shortly.', recovery: 'retry_later' },
  financial_data_unavailable: { message: 'We couldn’t reach your financial data right now. Your saved data is still here—please try again shortly.', recovery: 'retry_later' },
  action_unavailable: { message: 'We couldn’t complete that right now. Please try again shortly.', recovery: 'retry_later' }
});

export function customerError(code, options = {}) {
  const base = catalog[code] || catalog.action_unavailable;
  const retryAfterSeconds = Number(options.retryAfterSeconds);
  const hasRetryAfter = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0;
  const wait = hasRetryAfter
    ? ` Try again in ${retryAfterSeconds >= 60 ? `${Math.ceil(retryAfterSeconds / 60)} minute${Math.ceil(retryAfterSeconds / 60) === 1 ? '' : 's'}` : `${Math.ceil(retryAfterSeconds)} seconds`}.`
    : '';
  return {
    code: catalog[code] ? code : 'action_unavailable',
    message: `${options.message || base.message}${base.recovery === 'wait' ? wait : ''}`,
    recovery: base.recovery,
    retryAfterSeconds: hasRetryAfter ? Math.ceil(retryAfterSeconds) : null
  };
}

export function publicErrorPayload(code, options = {}) {
  const error = customerError(code, options);
  return {
    error: error.message,
    error_code: error.code,
    recovery: error.recovery,
    ...(error.retryAfterSeconds ? { retry_after_seconds: error.retryAfterSeconds } : {})
  };
}

export function plaidErrorCode(errorCode) {
  const code = String(errorCode || '').toUpperCase();
  if (code === 'ITEM_LOGIN_REQUIRED') return 'reconnect_required';
  if (['INSTITUTION_NOT_RESPONDING', 'INSTITUTION_DOWN'].includes(code)) return 'institution_unavailable';
  if (code === 'PRODUCT_NOT_READY') return 'data_preparing';
  if (['RATE_LIMIT_EXCEEDED', 'TOO_MANY_REQUESTS'].includes(code)) return 'rate_limited';
  return 'connection_unavailable';
}

export function httpErrorCode({ status, errorCode } = {}) {
  if (catalog[errorCode]) return errorCode;
  if (Number(status) === 401) return 'session_expired';
  if (Number(status) === 429) return 'rate_limited';
  if (Number(status) >= 500) return 'financial_data_unavailable';
  return 'action_unavailable';
}
