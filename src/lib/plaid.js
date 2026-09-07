const baseUrls = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com'
};

function baseUrl() {
  return baseUrls[process.env.PLAID_ENV || 'sandbox'] || baseUrls.sandbox;
}

export function plaidConfigured() {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

export async function plaidPost(path, body = {}) {
  if (!plaidConfigured()) throw new Error('Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to .env.');
  const response = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
}
