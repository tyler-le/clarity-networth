const API_ROOT = 'https://api.marketdata.app/v1';

function dayFromUnix(timestamp) {
  return new Date(Number(timestamp) * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function normalizeCandles(payload) {
  if (payload?.s !== 'ok' || !Array.isArray(payload.t) || !Array.isArray(payload.c)) return {};
  return Object.fromEntries(payload.t.map((timestamp, index) => [dayFromUnix(timestamp), Number(payload.c[index])]).filter(([, close]) => Number.isFinite(close) && close > 0));
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function loadHistoricalPrices({ symbol, securityType, from, to }) {
  const token = process.env.MARKETDATA_API_TOKEN;
  if (!token || !symbol) return {};
  const collection = securityType === 'mutual fund' ? 'funds' : 'stocks';
  const url = new URL(`${API_ROOT}/${collection}/candles/D/${encodeURIComponent(symbol)}/`);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  if (collection === 'stocks') {
    url.searchParams.set('adjustsplits', 'false');
    url.searchParams.set('adjustdividends', 'false');
  }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      if ([200, 203].includes(response.status)) {
        const candles = normalizeCandles(await response.json());
        return candles;
      }
      const retriable = response.status === 429 || response.status >= 500;
      lastError = new Error(`Historical prices unavailable for ${symbol}.`);
      if (!retriable) throw lastError;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await wait(400 * (attempt + 1));
  }
  throw lastError || new Error(`Historical prices unavailable for ${symbol}.`);
}
