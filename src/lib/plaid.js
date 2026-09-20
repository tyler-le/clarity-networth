const baseUrls = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com'
};
const PLAID_REQUEST_TIMEOUT_MS = 15_000;

function baseUrl() {
  return baseUrls[process.env.PLAID_ENV || 'sandbox'] || baseUrls.sandbox;
}

export function plaidConfigured() {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

// Fetch an entire bounded window before publishing any ledger changes. A
// failed later page must never look like a complete historical download.
export async function investmentLedgerPages(body, post = plaidPost) {
  const transactions = new Map();
  const securities = new Map();
  let expected = null;
  let offset = 0;
  do {
    const data = await post('/investments/transactions/get', {
      ...body, options: { ...body.options, count: 500, offset, ...(offset ? { async_update: false } : {}) }
    });
    const total = data.total_investment_transactions;
    const rows = data.investment_transactions;
    if (!Number.isSafeInteger(total) || total < 0 || total > 100_000 || !Array.isArray(rows)
      || (expected != null && total !== expected) || (!rows.length && offset < total)) {
      throw new Error('Investment activity changed or was incomplete during download. It will be retried.');
    }
    expected = total;
    for (const row of rows) {
      if (!row.investment_transaction_id || transactions.has(row.investment_transaction_id)) throw new Error('Investment activity pages overlapped. It will be retried.');
      transactions.set(row.investment_transaction_id, row);
    }
    for (const row of data.securities || []) securities.set(row.security_id, row);
    offset += rows.length;
  } while (offset < expected);
  if (transactions.size !== expected) throw new Error('Investment activity download was incomplete.');
  return { investment_transactions: [...transactions.values()], securities: [...securities.values()] };
}

export async function plaidPost(path, body = {}) {
  if (!plaidConfigured()) throw new Error('Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to .env.');
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A stuck dependency must not tie up a request or sync worker forever.
      // The caller already maps failures to a safe retry state.
      signal: AbortSignal.timeout(PLAID_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        ...body
      })
    });
    const data = await response.json();
    if (!response.ok) {
      const err = new Error(data.error_message || data.display_message || `Plaid request failed: ${response.status}`);
      err.plaid = data;
      err.status = response.status;
      throw err;
    }
    return data;
  } catch (error) {
    throw error;
  }
}
