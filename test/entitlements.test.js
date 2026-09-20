import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedInstitutionCount, entitlementsForStore, hasPaidAccess, normalizeMembership } from '../src/lib/entitlements.js';

const now = Date.parse('2026-09-19T12:00:00.000Z');
const currentItem = (id) => ({ id, demo: false });

test('Free state keeps the core product open and limits active institutions', () => {
  const store = { items: [currentItem('one'), currentItem('two')], settings: { membership: { plan: 'free' } } };
  const atLimit = entitlementsForStore(store, now, true);
  assert.equal(atLimit.enabled, true);
  assert.equal(atLimit.plan, 'free');
  assert.equal(atLimit.linkedInstitutionCount, 2);
  assert.equal(atLimit.linkedInstitutionLimit, 2);
  assert.equal(atLimit.canConnectInstitution, false);
  assert.equal(atLimit.canUseFullHistory, true);
  assert.equal(atLimit.canExportData, true);
  assert.equal(atLimit.canUseRetirementScenarios, false);
  assert.equal(atLimit.canUseCashFlowDetails, false);
  assert.equal(atLimit.canUseInvestmentDetails, false);
  assert.equal(atLimit.canUseApp, true);
  assert.equal(atLimit.requiresSubscription, false);

  store.items = [currentItem('two')];
  const afterUnlink = entitlementsForStore(store, now, true);
  assert.equal(afterUnlink.linkedInstitutionCount, 1);
  assert.equal(afterUnlink.canConnectInstitution, true);
  assert.equal(afterUnlink.canUseFullHistory, true);
  assert.equal(afterUnlink.canUseApp, true);
});

test('Plus and trial plans unlock retirement comparisons without changing the primary plan editor', () => {
  const plus = entitlementsForStore({ settings: { membership: { plan: 'plus', subscription_status: 'active', subscription_ends_at: '2026-10-01T00:00:00Z' } } }, now, true);
  const trial = entitlementsForStore({ settings: { membership: { plan: 'trial', trial_ends_at: '2026-09-20T00:00:00Z' } } }, now, true);
  assert.equal(plus.canUseRetirementScenarios, true);
  assert.equal(trial.canUseRetirementScenarios, true);
  assert.equal(plus.canUseCashFlowDetails, true);
  assert.equal(trial.canUseInvestmentDetails, true);
  assert.equal(plus.plan, 'plus');
  assert.equal(trial.plan, 'trial');
  assert.equal(plus.requiresSubscription, false);
  assert.equal(trial.requiresSubscription, false);
});

test('demo Items are excluded from freemium eligibility and never cap demo data', () => {
  const demoStore = {
    items: [{ id: 'demo-one', demo: true }, { id: 'demo-two', demo: true }, { id: 'demo-three', demo: true }],
    settings: { membership: { plan: 'free' }, demo_mode: true }
  };
  assert.equal(connectedInstitutionCount(demoStore), 0);
  const entitlements = entitlementsForStore(demoStore, now, true);
  assert.equal(entitlements.canConnectInstitution, true);
  assert.equal(entitlements.linkedInstitutionCount, 0);
  assert.equal(entitlements.requiresSubscription, false);
});

test('the global freemium switch leaves every product capability available when disabled', () => {
  const entitlements = entitlementsForStore({ items: [currentItem('one'), currentItem('two')] }, now, false);
  assert.deepEqual(
    {
      enabled: entitlements.enabled,
      plan: entitlements.plan,
      canConnectInstitution: entitlements.canConnectInstitution,
      canUseFullHistory: entitlements.canUseFullHistory,
      canExportData: entitlements.canExportData,
      canUseRetirementScenarios: entitlements.canUseRetirementScenarios
    },
    { enabled: false, plan: null, canConnectInstitution: true, canUseFullHistory: true, canExportData: true, canUseRetirementScenarios: true }
  );
});

test('paid and trial access are derived from valid membership state, including expiry', () => {
  assert.equal(hasPaidAccess({ plan: 'plus', subscription_status: 'active', subscription_ends_at: '2026-10-01T00:00:00Z' }, now), true);
  assert.equal(hasPaidAccess({ plan: 'plus', subscription_status: 'canceled', subscription_ends_at: '2026-10-01T00:00:00Z' }, now), true);
  assert.equal(hasPaidAccess({ plan: 'plus', subscription_status: 'past_due' }, now), false);
  assert.equal(hasPaidAccess({ plan: 'plus', subscription_status: 'active' }, now), false);
  assert.equal(hasPaidAccess({ plan: 'plus', subscription_status: 'active', subscription_ends_at: '2026-09-01T00:00:00Z' }, now), false);
  assert.equal(hasPaidAccess({ plan: 'trial', trial_ends_at: '2026-09-20T00:00:00Z' }, now), true);
  assert.equal(hasPaidAccess({ plan: 'trial', trial_ends_at: '2026-09-01T00:00:00Z' }, now), false);
  assert.deepEqual(normalizeMembership({ plan: 'not-a-plan', subscription_status: 'untrusted' }), {
    plan: 'free', trial_ends_at: null, subscription_status: 'none', subscription_ends_at: null,
    stripe_customer_id: null, stripe_subscription_id: null, stripe_event_created_at: 0
  });
});
