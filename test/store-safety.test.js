import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeFinancialStoreWrite, chooseSaferStore, hasConnectedFinancialData } from '../src/lib/store-safety.js';

const linked = { items: [{ id: 'item-1', demo: false }], accounts: [{ id: 'account-1', demo: false }] };
const empty = { items: [], accounts: [] };

test('an ordinary write cannot replace linked financial data with an empty store', () => {
  assert.equal(hasConnectedFinancialData(linked), true);
  assert.throws(() => assertSafeFinancialStoreWrite(linked, empty), /Refusing to replace connected financial data/);
});

test('an explicit final unlink can clear a linked store', () => {
  assert.doesNotThrow(() => assertSafeFinancialStoreWrite(linked, empty, { allowEmptyConnectedStore: true }));
});

test('demo-only records do not block a normal cleanup write', () => {
  assert.equal(hasConnectedFinancialData({ items: [{ demo: true }], accounts: [{ demo: true }] }), false);
  assert.doesNotThrow(() => assertSafeFinancialStoreWrite({ items: [{ demo: true }], accounts: [] }, empty));
});

test('a populated encrypted mirror wins over an empty database row and can heal it', () => {
  assert.equal(chooseSaferStore(empty, linked), linked);
  assert.equal(chooseSaferStore(linked, empty), linked);
});
