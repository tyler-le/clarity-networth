// Keep holdings attached only to the account identity supplied by the API.
// A missing account id is not evidence that a position belongs to another
// account, even when its name or ticker happens to match.
export function investmentAccountGroups(accounts = [], positions = []) {
  return accounts.map((account) => ({
    account,
    positions: positions.filter((position) => account.account_id != null
      && position.account_id === account.account_id)
      .sort((left, right) => Number(right.value || 0) - Number(left.value || 0))
  }));
}

export function holdingMarketChange(progress) {
  if (progress?.state !== 'ready' || progress.marketChange == null) return null;
  const value = Number(progress.marketChange);
  return Number.isFinite(value) ? value : null;
}

// Categories describe provider classifications; do not infer stock or bond
// exposure from a ticker or classify all ETFs as equities.
export function investmentClassColor(classification) {
  return ({ Equities: '#526eab', Funds: '#526eab', 'Fixed income': '#a07936',
    Cash: '#32808b', Crypto: '#8a648e', Other: '#7a847e',
    'Cash & unclassified': '#7a847e' })[classification] || '#7a847e';
}
