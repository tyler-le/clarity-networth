// Membership is persisted with the member's encrypted store so every API
// surface evaluates the same plan state. Billing is intentionally separate:
// a future billing webhook only needs to update this small, auditable record.
export const FREE_CONNECTED_INSTITUTION_LIMIT = 2;

const PLANS = new Set(['free', 'plus', 'trial']);
const SUBSCRIPTION_STATUSES = new Set(['none', 'active', 'canceled', 'past_due']);

export function freemiumEnabled() {
  return String(process.env.FREEMIUM_ENABLED || '').toLowerCase() === 'true';
}

function validDate(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function normalizeMembership(value = {}) {
  const plan = PLANS.has(value?.plan) ? value.plan : 'free';
  const subscriptionStatus = SUBSCRIPTION_STATUSES.has(value?.subscription_status)
    ? value.subscription_status
    : 'none';
  const trialEndsAt = validDate(value?.trial_ends_at);
  const subscriptionEndsAt = validDate(value?.subscription_ends_at);
  return {
    plan,
    trial_ends_at: trialEndsAt,
    subscription_status: subscriptionStatus,
    subscription_ends_at: subscriptionEndsAt
  };
}

export function connectedInstitutionCount(store = {}) {
  // Unlinking removes the Item from the store. Count only live, non-demo
  // Items—not account rows or historical records—so a removed institution
  // frees a Free-plan slot immediately.
  return (store.items || []).filter((item) => item && !item.demo).length;
}

export function hasPaidAccess(membership = {}, now = Date.now()) {
  const normalized = normalizeMembership(membership);
  if (normalized.plan === 'trial') {
    const trialEndsAt = Date.parse(normalized.trial_ends_at || '');
    return Number.isFinite(trialEndsAt) && trialEndsAt > now;
  }
  if (normalized.plan !== 'plus' || !['active', 'canceled'].includes(normalized.subscription_status)) return false;
  const subscriptionEndsAt = Date.parse(normalized.subscription_ends_at || '');
  return !Number.isFinite(subscriptionEndsAt) || subscriptionEndsAt > now;
}

export function entitlementsForStore(store = {}, now = Date.now(), enabled = freemiumEnabled()) {
  const membership = normalizeMembership(store.settings?.membership);
  const paid = hasPaidAccess(membership, now);
  const linkedInstitutionCount = connectedInstitutionCount(store);
  if (!enabled) {
    // A disabled flag is a true product kill switch. Existing behaviour keeps
    // working and no plan, purchase, or feature block is exposed to members.
    return {
      enabled: false,
      plan: null,
      membership,
      linkedInstitutionCount,
      linkedInstitutionLimit: null,
      canConnectInstitution: true,
      canUseFullHistory: true,
      canExportData: true,
      canUseRetirementScenarios: true
    };
  }
  const linkedInstitutionLimit = paid ? null : FREE_CONNECTED_INSTITUTION_LIMIT;
  const canConnectInstitution = paid || linkedInstitutionCount < FREE_CONNECTED_INSTITUTION_LIMIT;

  return {
    enabled: true,
    plan: paid ? 'plus' : 'free',
    membership,
    linkedInstitutionCount,
    linkedInstitutionLimit,
    canConnectInstitution,
    // Central checks for the subsequent paid surfaces. They are deliberately
    // not enforced yet; this change only gates institution connections.
    canUseFullHistory: paid,
    canExportData: paid,
    canUseRetirementScenarios: paid
  };
}
