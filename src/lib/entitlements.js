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

function stripeId(value, prefix) {
  const id = String(value || '');
  return new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(id) ? id : null;
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
    subscription_ends_at: subscriptionEndsAt,
    stripe_customer_id: stripeId(value?.stripe_customer_id, 'cus'),
    stripe_subscription_id: stripeId(value?.stripe_subscription_id, 'sub'),
    stripe_event_created_at: Number.isInteger(value?.stripe_event_created_at) && value.stripe_event_created_at > 0
      ? value.stripe_event_created_at
      : 0
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
  // Stripe provides the current period end for subscription lifecycle events.
  // If it is absent or malformed, do not silently grant indefinite paid
  // access—provider data must be complete before it expands an entitlement.
  return Number.isFinite(subscriptionEndsAt) && subscriptionEndsAt > now;
}

export function entitlementsForStore(store = {}, now = Date.now(), enabled = freemiumEnabled()) {
  const membership = normalizeMembership(store.settings?.membership);
  const paid = hasPaidAccess(membership, now);
  const demo = Boolean(store.settings?.demo_mode) || (store.items || []).some((item) => item?.demo);
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
      canUseRetirementScenarios: true,
      canUseApp: true,
      requiresSubscription: false
    };
  }
  const hasProductAccess = paid || demo;
  const requiresSubscription = !hasProductAccess;
  const linkedInstitutionLimit = paid ? null : FREE_CONNECTED_INSTITUTION_LIMIT;
  const canConnectInstitution = hasProductAccess;
  const plan = paid ? (membership.plan === 'trial' ? 'trial' : 'plus') : 'free';

  return {
    enabled: true,
    plan,
    membership,
    linkedInstitutionCount,
    linkedInstitutionLimit,
    canConnectInstitution,
    // A trial and an active subscription unlock the complete product. The
    // Free state is retained as the pre-subscription state shown by the gate.
    canUseFullHistory: hasProductAccess,
    canExportData: hasProductAccess,
    canUseRetirementScenarios: hasProductAccess,
    canUseApp: hasProductAccess,
    requiresSubscription
  };
}
