// A linked financial store must never silently become empty because a caller
// loaded a fallback/normalized store after an operational failure. Explicit
// account deletion is the only workflow allowed to cross that boundary.
export function hasConnectedFinancialData(store = {}) {
  return [...(store.items || []), ...(store.accounts || [])]
    .some((record) => record && !record.demo);
}

export function assertSafeFinancialStoreWrite(previous, next, { allowEmptyConnectedStore = false } = {}) {
  if (allowEmptyConnectedStore || !hasConnectedFinancialData(previous) || hasConnectedFinancialData(next)) return;
  throw new Error('Refusing to replace connected financial data with an empty store.');
}

export function chooseSaferStore(primary, mirror) {
  return hasConnectedFinancialData(mirror) && !hasConnectedFinancialData(primary) ? mirror : primary || mirror;
}
