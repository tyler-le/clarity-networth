import test from 'node:test';
import assert from 'node:assert/strict';
import { investmentAccountGroups, holdingMarketChange, investmentClassColor } from '../public/investment-view.js';

test('holdings stay under their provider account, including repeated securities', () => {
  const accounts = [{ account_id: 'retirement' }, { account_id: 'brokerage' }, { account_id: 'awaiting' }];
  const positions = [
    { id: 'a', account_id: 'retirement', ticker: 'FUND', value: 70 },
    { id: 'b', account_id: 'brokerage', ticker: 'FUND', value: 30 },
    { id: 'c', account_id: 'retirement', ticker: 'CASH', value: 90 },
    { id: 'orphan', ticker: 'FUND', value: 1000 }
  ];
  const groups = investmentAccountGroups(accounts, positions);
  assert.deepEqual(groups.map((group) => group.positions.map((position) => position.id)), [['c', 'a'], ['b'], []]);
  assert.deepEqual(positions.map((position) => position.id), ['a', 'b', 'c', 'orphan']);
  assert.deepEqual(investmentAccountGroups([{}], [{ value: 20 }])[0].positions, []);
});

test('market changes require verified ready performance, not a balance increase or guessed zero', () => {
  for (const progress of [null, {}, { state: 'tracking', marketChange: 20 }, { state: 'ready', valueChange: 30 }, { state: 'ready', marketChange: 'not available' }]) {
    assert.equal(holdingMarketChange(progress), null);
  }
  assert.equal(holdingMarketChange({ state: 'ready', marketChange: -12 }), -12);
  assert.equal(holdingMarketChange({ state: 'ready', marketChange: 0 }), 0);
});

test('allocation uses reported classifications, including unknown and unclassified data', () => {
  assert.notEqual(investmentClassColor('Funds'), investmentClassColor('Cash'));
  assert.notEqual(investmentClassColor('Funds'), investmentClassColor('Fixed income'));
  assert.equal(investmentClassColor('Unreported'), investmentClassColor('Cash & unclassified'));
});
