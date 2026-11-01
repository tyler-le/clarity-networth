import { test, expect } from '@playwright/test';

test.skip(Boolean(process.env.CODEX_SANDBOX_NETWORK_DISABLED), 'This workspace blocks browser loopback networking; GitHub CI runs the full browser suite.');

let nextTestClient = 90;
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': `198.51.100.${nextTestClient++}` });
});

async function expandInvestmentAccount(page, name = null) {
  const groups = page.getByTestId('investment-account-group');
  const group = name ? groups.filter({ hasText: name }).first() : groups.first();
  if (await group.getAttribute('open') == null) await group.locator('summary').click();
}

async function expandAccountCollections(page) {
  for (const button of await page.locator('[data-account-collapse]').all()) {
    if (await button.getAttribute('aria-expanded') === 'false') await button.click();
  }
}

async function goToView(page, view) {
  if (view === 'profile') return page.locator('#profileButton').click();
  const mobile = page.locator(`.mobile-nav [data-view="${view}"]`);
  if (await mobile.isVisible()) return mobile.click();
  return page.locator(`.sidebar [data-view="${view}"]`).click();
}

async function selectHoldingHistoryRange(page, range) {
  const control = page.locator(`#holdingHistoryRange [data-holding-history-range="${range}"]`);
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  await control.click();
  await expect(control).toHaveAttribute('aria-pressed', 'true');
}

// Uses the complete, realistic demo contract as a baseline, then makes one
// meaningful change for a member situation. The UI is real; only the service
// boundary is mocked. This catches rendering and interaction regressions
// without requiring Plaid, Google, or market-data calls in browser tests.
async function openSignedInScenario(page, transform = () => {}) {
  const response = await page.request.get('/api/demo-preview?range=1m');
  expect(response.ok()).toBe(true);
  const preview = await response.json();
  // A fresh member receives the unmodified product preview, while the
  // dashboard routes below model that member's own scenario. Keep these
  // contracts separate so a range fetch cannot silently escape the mock.
  const onboardingPreview = structuredClone(preview);
  const originalSnapshots = JSON.stringify(preview.investments.snapshots);
  const originalProgress = JSON.stringify(preview.investments.progress);
  transform(preview);
  // A transformed snapshot fixture must not keep the unrelated demo's
  // canonical dates. Explicitly supplied progress remains authoritative.
  if (JSON.stringify(preview.investments.snapshots) !== originalSnapshots
      && JSON.stringify(preview.investments.progress) === originalProgress) preview.investments.progress = null;
  preview.dashboard.demoMode = false;
  preview.dashboard.appearance = { theme: 'light' };
  preview.dashboard.plaidConfigured = true;
  preview.dashboard.user = { email: 'scenario@example.test', name: 'Scenario member' };

  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { user: { email: 'scenario@example.test', name: 'Scenario member' } } }));
  await page.route('**/api/dashboard', (route) => route.fulfill({ json: preview.dashboard }));
  await page.route(/\/api\/demo-preview(?:\?.*)?$/, (route) => route.fulfill({ json: onboardingPreview }));
  await page.route(/\/api\/spending(?:\?.*)?$/, (route) => route.fulfill({ json: preview.spending }));
  await page.route(/\/api\/investments(?:\?.*)?$/, (route) => {
    const requestedRange = new URL(route.request().url()).searchParams.get('range');
    // Mirror the endpoint contract: a range request returns a payload marked
    // for that same range. Returning a fixed initial range creates an
    // artificial client re-fetch loop and leaves the controls disabled.
    route.fulfill({ json: { ...preview.investments, ...(requestedRange ? { range: requestedRange } : {}) } });
  });
  await page.route('**/api/retirement', (route) => route.fulfill({ json: preview.retirement }));
  await page.route('**/api/settings/debt-strategy', (route) => route.fulfill({ json: preview.dashboard.debtPayoff || {} }));
  await page.goto('/');
  await expect(page.locator('#appShell')).toBeVisible();
  await expect(page.locator('#appShell')).toHaveAttribute('aria-busy', 'false');
}

test('movers have inset spacing, compact real charts and one active period @critical', async ({ page }) => {
  await openSignedInScenario(page);
  await goToView(page, 'investments');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  const card = page.locator('#investmentMoversCard');
  await expect(card).toBeVisible();
  const weekly = card.getByRole('tab', { name: 'Weekly', exact: true });
  const monthly = card.getByRole('tab', { name: 'Monthly', exact: true });
  await expect(weekly).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#investmentMonthlyMoverGroup')).toBeHidden();
  await expect(card.getByRole('heading', { name: 'Weekly movers', exact: true })).toBeVisible();
  await expect(card.getByText('Verified holding changes from your connected institutions.')).toHaveCount(0);
  await expect(page.locator('#investmentWeeklyMovers').getByRole('button').first()).toHaveAccessibleName(/^View /);
  await expect(card.getByText('Largest dollar changes', { exact: true })).toHaveCount(0);
  const metrics = await card.evaluate((element) => {
    const heading = element.querySelector('.investment-movers-heading');
    const row = element.querySelector('#investmentWeeklyMovers .investment-mover-row');
    const value = row.querySelector('.investment-mover-change');
    const chart = row.querySelector('svg');
    return { inset: heading.getBoundingClientRect().left - element.getBoundingClientRect().left, top: heading.getBoundingClientRect().top - element.getBoundingClientRect().top,
      height: row.getBoundingClientRect().height, chartHeight: chart.getBoundingClientRect().height,
      background: getComputedStyle(value).backgroundColor, padding: getComputedStyle(value).padding,
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(metrics.inset).toBeGreaterThanOrEqual(20);
  expect(metrics.top).toBeGreaterThanOrEqual(20);
  expect(metrics.height).toBeLessThan(180);
  expect(metrics.chartHeight).toBeLessThanOrEqual(36);
  expect(metrics.background).toBe('rgba(0, 0, 0, 0)');
  expect(metrics.padding).toBe('0px');
  expect(metrics.overflow).toBe(false);
  const next = card.getByRole('button', { name: 'Next movers', exact: true });
  if (await next.isEnabled()) {
    await next.click();
    await expect.poll(() => page.locator('#investmentWeeklyMovers').evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  }
  await monthly.click();
  await expect(monthly).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#investmentWeeklyMoverGroup')).toBeHidden();
  await expect(page.locator('#investmentMonthlyMoverGroup')).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Monthly movers', exact: true })).toBeVisible();
  await card.screenshot({ path: `/tmp/clarity-movers-${test.info().project.name}.png` });
});

test('a Free member can use the core product before choosing Plus', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    preview.dashboard.entitlements = {
      enabled: true,
      plan: 'free',
      billingAvailable: true,
      requiresSubscription: false,
      canUseApp: true,
      canConnectInstitution: false,
      linkedInstitutionCount: 0,
      linkedInstitutionLimit: 2
    };
  });

  await expect(page.locator('#overviewView')).toBeVisible();
  await expect(page.locator('#netWorthCard')).toBeVisible();
});

test('a Free member sees an in-context Plus prompt for deeper cash-flow detail', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    preview.dashboard.entitlements = {
      enabled: true,
      plan: 'free',
      billingAvailable: true,
      requiresSubscription: false,
      canUseApp: true,
      canUseConnectInstitution: true,
      canUseCashFlowDetails: false,
      canUseInvestmentDetails: false,
      canUseRetirementScenarios: false,
      linkedInstitutionCount: 1,
      linkedInstitutionLimit: 2
    };
  });

  await goToView(page, 'spending');
  const sankeyNode = page.locator('#cashflowSankey [data-cashflow-node]').first();
  await expect(sankeyNode).toBeVisible();
  await sankeyNode.click();
  await expect(page.locator('#cashflowDialog')).toBeVisible();
  await expect(page.locator('#cashflowDialog')).toContainText('Unlock transaction detail');
  await page.keyboard.press('Escape');
  await page.locator('#spendingTransactionsPanel summary').click();
  await expect(page.locator('#spendingTransactions')).toContainText('See the transactions behind each category');
  await page.locator('#spendingTransactions [data-plus-cta]').click();
  await expect(page.locator('#upgradeDialog')).toBeVisible();
  await expect(page.locator('#upgradeDialogTitle')).toHaveText('See the transactions behind your cash flow');
  await expect(page.locator('#upgradeDialog')).toContainText('No charge during your trial');
});

test('cash-flow transaction categories use the same income and spending editor in the list and Sankey detail', async ({ page }) => {
  let updateRequest;
  await page.route('**/api/transactions/*/category/preview', async (route) => {
    const request = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, updated: 2, matchedDuplicates: 1, category: { key: request.category, label: 'Fees' }, similarPeerPayments: null } });
  });
  await page.route('**/api/transactions/*/category', async (route) => {
    updateRequest = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, updated: 1, matchedDuplicates: 0, category: { key: updateRequest.category } } });
  });
  await openSignedInScenario(page, (preview) => {
    preview.dashboard.entitlements = { enabled: false, canUseCashFlowDetails: true };
  });

  await goToView(page, 'spending');
  await page.locator('#spendingTransactionsPanel summary').click();
  await expect(page.locator('#spendingTransactions [data-transaction-category]').first()).toBeVisible();
  const sankeyNode = page.locator('#cashflowSankey [data-cashflow-node]').first();
  await sankeyNode.click();
  await expect(page.locator('#cashflowDialogContent [data-transaction-category]').first()).toBeVisible();
  const incomeEditor = page.locator('#cashflowDialogContent [data-transaction-category]').filter({ has: page.locator('option[value="income_paychecks"]') }).first();
  if (await incomeEditor.count()) await incomeEditor.selectOption('income_business');
  else await page.locator('#cashflowDialogContent [data-transaction-category]').first().selectOption('fees');
  await expect(page.locator('#categoryChangeDialog')).toBeVisible();
  await expect(page.locator('#categoryChangeDialog')).toContainText(/matching transaction/i);
  await page.locator('#categoryChangeConfirm').click();
  await expect.poll(() => updateRequest?.category).toMatch(/^(income_business|fees)$/);
});

test('cash-flow activity keeps a remembered category visible without stretching the transaction list', async ({ page }) => {
  let forgotRule = false;
  await page.route('**/api/transaction-category-rules/*', async (route) => {
    forgotRule = route.request().method() === 'DELETE';
    await route.fulfill({ json: { ok: true } });
  });
  await openSignedInScenario(page, (preview) => {
    const transaction = preview.spending.transactions.find((row) => row.flowGroup === 'actual_spend');
    transaction.categoryRuleId = 'outflow:remembered-payment';
    preview.spending.categoryRules = [{ id: transaction.categoryRuleId, categoryKey: transaction.cashFlowCategory, categoryLabel: transaction.flowLabel, flow: 'outflow' }];
    preview.dashboard.entitlements = { enabled: false, canUseCashFlowDetails: true };
  });

  await goToView(page, 'spending');
  await page.locator('#spendingTransactionsPanel summary').click();
  await expect(page.locator('.spending-transaction-layout')).toBeVisible();
  await expect(page.locator('.spending-transaction-context')).toContainText('Clarity remembers');
  await page.locator('[data-cashflow-forget-rule]').click();
  await expect.poll(() => forgotRule).toBe(true);
});

test('cash-flow activity summary uses the same category label as its active transaction filter', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    preview.dashboard.entitlements = { enabled: false, canUseCashFlowDetails: true };
    for (const transaction of preview.spending.transactions) {
      if (transaction.flowGroup !== 'actual_spend') continue;
      transaction.flowKey = 'food_dining';
      transaction.flowLabel = 'Food & dining';
      transaction.category = 'Fixed costs';
    }
  });

  await goToView(page, 'spending');
  await page.locator('#spendingTransactionsPanel summary').click();
  await page.locator('#spendingCategoryFilter').selectOption('food_dining');
  await expect(page.locator('.spending-transaction-context .spending-context-stat')).toContainText('Food & dining');
  await expect(page.locator('.spending-transaction-context .spending-context-stat')).not.toContainText('Fixed costs');
});

test('cash-flow activity replaces a long filtered history one page at a time', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    const source = preview.spending.transactions.find((transaction) => transaction.flowGroup === 'actual_spend');
    preview.spending.transactions = Array.from({ length: 55 }, (_, index) => ({
      ...source,
      id: `long-history-${index}`,
      name: `Purchase ${index + 1}`,
      date: `2026-09-${String((index % 28) + 1).padStart(2, '0')}`
    }));
    preview.dashboard.entitlements = { enabled: false, canUseCashFlowDetails: true };
  });

  await goToView(page, 'spending');
  await page.locator('#spendingTransactionsPanel summary').click();
  await expect(page.locator('.spending-transaction-row')).toHaveCount(25);
  await expect(page.locator('.spending-transaction-pagination')).toContainText('Page 1 of 3');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.spending-transaction-row')).toHaveCount(25);
  await expect(page.locator('.spending-transaction-pagination')).toContainText('Page 2 of 3');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.spending-transaction-row')).toHaveCount(5);
  await expect(page.locator('.spending-transaction-pagination')).toContainText('Page 3 of 3');
});

test('a legacy Free entitlement payload does not hide investment history', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    preview.dashboard.entitlements = {
      enabled: true,
      plan: 'free',
      billingAvailable: true,
      requiresSubscription: false,
      canUseApp: true,
      canUseConnectInstitution: true,
      canUseCashFlowDetails: false,
      canUseInvestmentDetails: false,
      canUseRetirementScenarios: false,
      linkedInstitutionCount: 1,
      linkedInstitutionLimit: 2
    };
  });

  const history = await (await page.request.get('/api/demo-investments/history?account_id=demo-brokerage&range=all')).json();
  await page.route('**/api/investments/history**', route => route.fulfill({ json: history }));
  await goToView(page, 'investments');
  await expandInvestmentAccount(page);
  await page.locator('[data-investment-account-history]').first().click();
  const dialog = page.locator('#holdingHistoryDialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveClass(/plus-history-gate/);
  await expect(page.locator('#holdingHistoryChart svg')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Unlock investment history/i })).toHaveCount(0);
});

test('a newly signed-in member with no accounts gets a calm, truthful product preview', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    preview.dashboard.accounts = [];
    preview.dashboard.items = [];
    preview.dashboard.snapshots = [];
    preview.dashboard.connectionHealth = [];
    preview.dashboard.debtPayoff = null;
    preview.dashboard.goals = [];
    preview.dashboard.summary = { ...preview.dashboard.summary, netWorth: 0, assets: 0, liabilities: 0 };
    preview.investments = { ...preview.investments, total: 0, accounts: [], positions: [], allocation: [], snapshots: [], positionsAvailable: false, unclassifiedAccounts: [] };
  });

  await expect(page.locator('#onboardingPreviewBanner')).toBeVisible();
  await expect(page.locator('#onboardingPreviewBanner')).toContainText('Connect an account');
  await expect(page.locator('#connectButton')).toBeHidden();
  await expect(page.locator('#netWorthCard')).toBeVisible();
  // A first-run member has no debt evidence yet. Keep the preview focused on
  // its truthful connection invitation rather than suggesting a payoff plan.
  await expect(page.locator('#debtPayoffCard')).toBeHidden();
  await expect(page.locator('#netWorth')).toHaveText('Your net worth');
  await expect(page.locator('#netWorthMovementTitle')).toHaveText('Understand what changed');
  await goToView(page, 'spending');
  await expect(page.locator('#freshSpendingState')).toBeHidden();
  await expect(page.locator('#cashFlowOverviewCard')).toBeVisible();
  await expect(page.locator('#spendingView .onboarding-tab-cta')).toBeVisible();
  await expect(page.locator('#cashflowHeadline')).toHaveText('Money in, spending, and saving in one view');
  await goToView(page, 'investments');
  await expect(page.locator('#investmentsView .onboarding-tab-cta')).toBeVisible();
  await expect(page.locator('#investmentTotal')).toHaveText('Your portfolio');
  await goToView(page, 'retirement');
  await expect(page.locator('#retirementView .onboarding-tab-cta')).toBeVisible();
  await expect(page.locator('#retirementProjection')).toHaveText('Your retirement outlook');
  await goToView(page, 'accounts');
  await expect(page.locator('#accountsView .onboarding-tab-cta')).toBeVisible();
  // Product guidance remains legible; only the illustrative financial facts
  // are obscured. A loading-style blank bar would make this feel broken.
  await expect(page.locator('#investmentTotal')).toHaveCSS('filter', 'none');
  await expect(page.locator('#accountsSummary strong').first()).toHaveCSS('filter', 'blur(4px)');
  await goToView(page, 'profile');
  await expect(page.locator('#profileName')).toHaveText('Scenario member');
  await expect(page.locator('#profileEmail')).toHaveText('scenario@example.test');
  await expect(page.locator('.profile-settings-panel')).toBeVisible();
  await expect(page.locator('#signOutButton')).toBeVisible();
  const signOutIsLastProfileAction = await page.locator('#signOutButton').evaluate((button) => button.closest('.profile-settings-panel')?.lastElementChild?.contains(button));
  expect(signOutIsLastProfileAction).toBe(true);
  await expect(page.locator('#connectionsList')).toContainText('No connected institutions yet.');
});

test('a cash-only member sees a muted investment preview with one relevant connection action', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    const cashAccount = preview.dashboard.accounts.find((account) => account.type === 'depository');
    preview.dashboard.accounts = [cashAccount];
    preview.dashboard.items = preview.dashboard.items.filter((item) => item.id === cashAccount.item_id);
    preview.investments = { ...preview.investments, total: 0, accounts: [], positions: [], allocation: [], snapshots: [], positionsAvailable: false, unclassifiedAccounts: [] };
  });

  await expect(page.locator('#onboardingPreviewBanner')).toBeHidden();
  await goToView(page, 'investments');
  const investments = page.locator('#investmentsView');
  await expect(investments).toHaveClass(/investment-coverage-preview/);
  await expect(investments.locator('.onboarding-tab-cta')).toBeVisible();
  await expect(investments.locator('.onboarding-tab-cta')).toContainText('Connect an investment account');
  await expect(investments.locator('.portfolio-card')).toBeVisible();
  await expect(page.locator('#investmentTotal')).toHaveCSS('filter', 'blur(4px)');
  await expect(page.locator('#spendingView .onboarding-tab-cta')).toBeHidden();
  await expect(page.locator('#accountsView .onboarding-tab-cta')).toBeHidden();
});

test('a cash-first member sees what they have without being pushed into debt or investing features', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    const cash = preview.dashboard.accounts.filter((account) => account.type === 'depository').slice(0, 2);
    preview.dashboard.accounts = cash;
    preview.dashboard.items = preview.dashboard.items.filter((item) => cash.some((account) => account.item_id === item.id));
    preview.dashboard.debtPayoff = null;
    preview.dashboard.summary = { ...preview.dashboard.summary, netWorth: 17700, assets: 17700, liabilities: 0 };
  });

  await expect(page.locator('#netWorth')).toHaveText('$17,700');
  await goToView(page, 'accounts');
  await expect(page.locator('#accountGrid')).toContainText('Cash');
  await expect(page.locator('#accountGrid')).not.toContainText('Investments');
  await expect(page.locator('#debtPayoffCard')).toBeHidden();
  await expect(page.locator('#accountGrid .account-collection')).toHaveCount(2);
});

test('the development mock uses the same post-connection completion flow as Plaid Link', async ({ page }) => {
  await openSignedInScenario(page);
  await page.route('**/api/plaid/create_link_token', (route) => route.fulfill({ json: { development_mock: true } }));
  await page.route('**/api/plaid/development_mock_connect', (route) => route.fulfill({ json: { ok: true, already_linked: false } }));

  await page.locator('#connectButton').click();
  await expect(page.locator('#connectionOnboardingDialog')).toBeVisible();
  await expect(page.locator('#connectionOnboardingDialog')).toContainText('Your picture is ready to begin.');
  await expect(page.locator('#connectionOnboardingDialog')).toContainText('Today');
  await expect(page.locator('#connectionOnboardingDialog')).toContainText('Next few minutes');
});

test('a rate-limited connection gives a safe wait time and prevents repeated attempts', async ({ page }) => {
  await openSignedInScenario(page);
  await page.route('**/api/plaid/create_link_token', (route) => route.fulfill({
    status: 429,
    headers: { 'Retry-After': '90' },
    json: {
      error: 'Please wait before trying again. Try again in 2 minutes.',
      error_code: 'rate_limited',
      recovery: 'wait',
      retry_after_seconds: 90
    }
  }));

  await page.locator('#connectButton').click();
  await expect(page.locator('#notice')).toHaveText('Please wait before trying again. Try again in 2 minutes.');
  await expect(page.locator('#notice')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#notice')).toHaveCSS('position', 'fixed');
  await expect(page.locator('#connectButton')).toBeDisabled();
  await expect(page.locator('#connectButton')).toHaveText('Try again in 2 min');
});

test('a Free-plan connection limit explains that unlinking immediately frees a slot', async ({ page }) => {
  await openSignedInScenario(page);
  await page.route('**/api/plaid/create_link_token', (route) => route.fulfill({
    status: 403,
    json: {
      error: 'Your Free plan includes two connected institutions. Unlink one to connect another.',
      error_code: 'institution_limit_reached',
      recovery: 'manage_connections'
    }
  }));

  await page.locator('#connectButton').click();
  await expect(page.locator('#notice')).toHaveText('Your Free plan includes two connected institutions. Unlink one to connect another.');
  await expect(page.locator('#notice')).toHaveAttribute('data-tone', 'error');
});

test('development exposes deterministic connection-recovery states without provider calls', async ({ page }) => {
  await openSignedInScenario(page, (preview) => { preview.dashboard.developmentTesting = true; });
  await goToView(page, 'profile');
  await expect(page.locator('#developmentRecoveryTesting')).toBeVisible();
  await page.locator('#developmentRecoveryScenario').selectOption('institution_unavailable');
  await page.locator('#developmentRecoveryTrigger').click();
  await expect(page.locator('#notice')).toHaveText('Your institution is temporarily unavailable. Please try again later.');
  await expect(page.locator('#notice')).toHaveAttribute('data-tone', 'error');
});

test('accounts retain the established collection layout for each account type', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    const [first, second, third] = preview.dashboard.accounts;
    const cash = { ...first, id: 'cash', type: 'depository', subtype: 'checking', name: 'Daily cash' };
    const savings = { ...second, id: 'savings', type: 'depository', subtype: 'savings', name: 'Rainy day savings' };
    const investment = { ...third, id: 'investment', type: 'investment', subtype: 'ira', name: 'Retirement account' };
    const card = { ...first, id: 'card', type: 'credit', subtype: 'credit card', name: 'Everyday card', current_balance: 800 };
    const loan = { ...second, id: 'loan', type: 'loan', subtype: 'student loan', name: 'Education loan', current_balance: 2_500 };
    const extraCard = { ...card, id: 'card-2', name: 'Travel card', current_balance: 300 };
    preview.dashboard.accounts = [cash, savings, investment, card, loan, extraCard];
  });

  await goToView(page, 'accounts');
  const collections = page.locator('#accountGrid .account-collection');
  await expect(collections).toHaveCount(5);
  await expect(collections.locator('h2')).toHaveText(['Cash', 'Savings', 'Investments', 'Credit cards', 'Loans & debt']);
  await expect(page.locator('#accountGrid .account-section')).toHaveCount(0);
  const collectionLayout = await collections.evaluateAll((items) => items.every((collection) => {
    const head = collection.querySelector('.account-collection-head');
    const rows = collection.querySelectorAll('.account-item');
    return Boolean(head && rows.length && getComputedStyle(collection).borderTopWidth === '1px');
  }));
  expect(collectionLayout).toBe(true);

  // Two account rows are visible by default, so a two-card group needs no
  // artificial “view more” interaction.
  await expect(collections.nth(3).locator('.account-item')).toHaveCount(2);
  await expect(collections.nth(3).locator('.account-group-more')).toHaveCount(0);
});

test('an investment account in Accounts opens its verified performance detail', async ({ page }) => {
  const history = [
    { date: '2026-09-01', value: 9000, source: 'verified' },
    { date: '2026-09-12', value: 9316, source: 'verified' }
  ];
  await openSignedInScenario(page);
  await page.route('**/api/investments/history**', (route) => route.fulfill({ json: {
    state: 'ready', label: 'Brokerage', value: 9316, history, market: [],
    detail: 'Based on 2 verified daily updates from your connected institution.'
  } }));

  await goToView(page, 'accounts');
  await expandAccountCollections(page);
  const investmentRow = page.locator('#accountGrid [data-account-investment-history]').first();
  await expect(investmentRow).toBeVisible();
  await expect(investmentRow).toHaveAttribute('aria-label', /performance/i);
  await investmentRow.click();
  await expect(page.locator('#holdingHistoryDialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(page.locator('#accountsView')).toHaveClass(/active/);
  await expect(page.locator('#holdingHistoryEyebrow')).toHaveText('Account history');
  await expect(page.locator('#holdingHistoryNote')).toContainText('verified daily updates');
});

test('a connected cash or debt account opens its own verified detail without leaving Accounts', async ({ page }) => {
  const history = [
    { date: '2026-09-01', value: 1200, source: 'verified' },
    { date: '2026-09-12', value: 1450, source: 'verified' }
  ];
  await openSignedInScenario(page);
  await page.route('**/api/accounts/history**', (route) => route.fulfill({ json: {
    state: 'ready',
    account: { id: 'cash-detail', name: 'Daily checking', institutionName: 'Example Bank', type: 'depository', subtype: 'checking', value: 1450 },
    history,
    progress: { state: 'ready', range: '1m', points: 2, startDate: '2026-09-01', endDate: '2026-09-12', valueChange: 250 },
    detail: 'Based on 2 verified daily updates from your connected institution.',
    activity: [{ id: 'paycheck', name: 'Paycheck', date: '2026-09-12', amount: -250 }]
  } }));

  await goToView(page, 'accounts');
  await expandAccountCollections(page);
  const accountRow = page.locator('#accountGrid [data-account-history]').first();
  await expect(accountRow).toBeVisible();
  await expect(accountRow).toHaveAttribute('aria-label', /account detail/i);
  await accountRow.click();
  await expect(page.locator('#accountHistoryDialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(page.locator('#accountHistoryTitle')).toHaveText('Daily checking');
  await expect(page.locator('#accountHistoryNote')).toContainText('verified daily updates');
  await expect(page.locator('#accountHistoryActivity')).toContainText('Paycheck');
  await page.locator('#accountHistoryRange [data-account-history-range="3m"]').click();
  await expect(page.locator('#accountHistoryRange [data-account-history-range="3m"]')).toHaveAttribute('aria-pressed', 'true');
});

test('an account with a connection issue routes to its focused management row', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    const item = preview.dashboard.items[0];
    item.demo = false;
    preview.dashboard.connectionHealth = [{ id: item.id, institution_name: item.institution_name, state: 'attention', requires_reconnect: true, action_required: true }];
  });

  await goToView(page, 'accounts');
  await expandAccountCollections(page);
  const connectionAction = page.locator('#accountGrid [data-account-connection]').first();
  await expect(connectionAction).toBeVisible();
  await expect(connectionAction).toHaveAttribute('aria-label', /Reconnect/i);
  await connectionAction.click();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await expect(page.locator('#connectionsList .connection-row-focused')).toHaveCount(1);
  await expect(page.locator('#connectionsList .connection-row-focused')).toContainText('Reconnect');
});

test('historical charts use only observed snapshots @critical', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  const ago = (days) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const history = [100, 30, 2, 0].map((days, index) => ({ date: ago(days), value: 1000 + index * 100, source: 'verified' }));
  await openSignedInScenario(page, (preview) => {
    preview.dashboard.snapshots = history.map((row) => ({ ...row, net_worth: row.value, assets: row.value, liabilities: 0 }));
    preview.dashboard.summary = { ...preview.dashboard.summary, netWorth: 1300, assets: 1300, liabilities: 0 };
    preview.investments.snapshots = history;
    preview.investments.total = 1300;
  });
  await page.locator('[data-networth-range="all"]').click();
  await expect(page.locator('#netWorthPeriodSummary')).toHaveText('All history');
  await expect(page.locator('#netWorthDelta')).not.toContainText(/estimated/i);
  const netChart = page.locator('#netWorthChart');
  const netBox = await netChart.boundingBox();
  await netChart.dispatchEvent('pointerdown', { clientX: netBox.x + 48, clientY: netBox.y + netBox.height / 2, pointerId: 1 });
  await expect(page.locator('#netWorthChartDate')).not.toContainText(/estimated/i);
  await netChart.dispatchEvent('pointerup');
  await goToView(page, 'investments');
  const allRange = page.locator('[data-investment-range="all"]');
  await expect(allRange).toBeEnabled();
  await allRange.click();
  await expect(page.locator('#investmentContext')).not.toContainText(/estimated/i);
  await page.route('**/api/investments/history**', (route) => route.fulfill({ json: {
    state: 'ready', label: 'Investment account', value: 1300, reconstructed: false, history, market: [],
    detail: 'Based on 4 verified daily updates from your connected institution.'
  } }));
  await expandInvestmentAccount(page);
  await page.getByRole('button', { name: /View .+ performance history/ }).first().click();
  await expect(page.locator('#holdingHistoryDialog')).toBeVisible();
  await expect(page.locator('#holdingHistoryNote')).toContainText('verified daily updates');
  await selectHoldingHistoryRange(page, 'all');
  await expect(page.locator('#holdingHistoryChart svg')).toBeVisible();
  const fits = await page.evaluate(() => {
    const dialog = document.querySelector('#holdingHistoryDialog');
    return document.documentElement.scrollWidth <= window.innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1;
  });
  expect(fits).toBe(true);
});

test('a recently connected member sees distinct portfolio dates, never repeated month labels', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    // This is the real failure mode: several verified syncs in one month.
    // Preserve the final value but ensure the chart is not allowed to label
    // every tick with the same abbreviated month/year.
    preview.investments.snapshots = [
      { date: '2026-09-05', value: 215_200, source: 'verified' },
      { date: '2026-09-06', value: 216_450, source: 'verified' },
      { date: '2026-09-07', value: 217_745, source: 'verified' }
    ];
    preview.investments.progress = {
      scope: 'portfolio', range: 'all', state: 'ready', points: 3,
      requestedStartDate: null, startDate: '2026-09-05', endDate: '2026-09-07',
      startValue: 215_200, endValue: 217_745, valueChange: 2545, changeKind: 'balance'
    };
  });

  await goToView(page, 'investments');
  await expect(page.locator('#investmentChart svg')).toBeVisible();
  // A few days of verified history should use its real span by default, not
  // render as a narrow spike inside an untracked one-year canvas.
  await expect(page.locator('[data-investment-range="all"]')).toHaveClass(/active/);
  await expect(page.locator('#investmentContext')).toContainText('since Sep 5');
  await page.locator('[data-investment-range="all"]').click();
  await expect(page.locator('[data-investment-range="all"]')).toHaveClass(/active/);
  await expect(page.locator('[data-investment-range="1m"]')).toBeEnabled();
  const labels = await page.locator('#investmentChart .chart-x-axis-label').allTextContents();
  expect(labels.length).toBeGreaterThanOrEqual(2);
  expect(labels[0]).toBe('Sep 5');
  expect(labels.at(-1)).toBe('Sep 7');
  expect(labels.every((label) => /^Sep \d+$/.test(label))).toBe(true);
  expect(new Set(labels).size).toBe(labels.length);
});

test('a newly connected portfolio shows the selected period before tracking began @critical', async ({ page }) => {
  let oneMonthPayload;
  await openSignedInScenario(page, (preview) => {
    preview.investments.snapshots = [
      { date: '2026-09-11', value: 215_200, source: 'verified' },
      { date: '2026-09-12', value: 215_430, source: 'verified' }
    ];
    oneMonthPayload = structuredClone(preview.investments);
  });
  await page.route('**/api/investments?range=1m', (route) => route.fulfill({ json: {
    ...oneMonthPayload,
    range: '1m',
    progress: {
      scope: 'portfolio', range: '1m', state: 'ready', points: 2,
      requestedStartDate: '2026-08-12', startDate: '2026-09-11', endDate: '2026-09-12',
      startValue: 215_200, endValue: 215_430, valueChange: 230, changeKind: 'balance'
    }
  } }));

  await goToView(page, 'investments');
  await page.locator('[data-investment-range="1m"]').click();
  // A horizontal SVG path has a zero-height DOM box even while its stroke
  // is painted. Assert the plotted segment and visible stroke instead.
  await expect(page.locator('#investmentChart .chart-unavailable-line')).toHaveAttribute('d', /M .+ L .+/);
  await expect(page.locator('#investmentChart .chart-unavailable-line')).toHaveCSS('stroke-width', '2px');
  await expect(page.locator('#investmentChart .chart-unavailable-label')).toHaveCount(0);
});

test('a short portfolio window spanning months still uses distinct calendar dates', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    preview.investments.snapshots = [
      { date: '2026-08-30', value: 215_200, source: 'verified' },
      { date: '2026-09-05', value: 216_450, source: 'verified' },
      { date: '2026-09-07', value: 217_745, source: 'verified' }
    ];
    preview.investments.progress = {
      scope: 'portfolio', range: 'all', state: 'ready', points: 3,
      requestedStartDate: null, startDate: '2026-08-30', endDate: '2026-09-07',
      startValue: 215_200, endValue: 217_745, valueChange: 2545, changeKind: 'balance'
    };
  });

  await goToView(page, 'investments');
  await page.locator('[data-investment-range="all"]').click();
  await expect(page.locator('#investmentChart svg')).toBeVisible();
  const labels = await page.locator('#investmentChart .chart-x-axis-label').allTextContents();
  expect(labels.length).toBeGreaterThanOrEqual(2);
  expect(labels[0]).toBe('Aug 30');
  expect(labels.at(-1)).toBe('Sep 7');
  expect(new Set(labels).size).toBe(labels.length);
});

test('a one-month net-worth view never repeats a calendar label @critical', async ({ page }) => {
  const today = new Date();
  const recentDate = (days) => new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10);
  await openSignedInScenario(page, (preview) => {
    preview.dashboard.snapshots = [
      { date: recentDate(3), net_worth: 237_200, source: 'verified' },
      { date: recentDate(2), net_worth: 240_663, source: 'verified' },
      { date: recentDate(1), net_worth: 240_603, source: 'verified' }
    ];
  });

  await page.locator('[data-networth-range="1m"]').click();
  await expect(page.locator('#netWorthChart .chart-x-axis-label').first()).toBeVisible();
  const labels = await page.locator('#netWorthChart .chart-x-axis-label').allTextContents();
  expect(labels.length).toBeGreaterThanOrEqual(1);
  expect(labels.every((label) => /^[A-Z][a-z]{2} \d+$/.test(label))).toBe(true);
  expect(new Set(labels).size).toBe(labels.length);
  await expect(page.locator('#netWorthChart .chart-unavailable-label')).toHaveCount(0);
});

test('a long net-worth range with only recent history does not overlap right-edge dates @critical', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    preview.dashboard.snapshots = [
      { date: '2026-09-05', net_worth: 237_200, source: 'verified' },
      { date: '2026-09-06', net_worth: 240_663, source: 'verified' },
      { date: '2026-09-07', net_worth: 240_603, source: 'verified' }
    ];
  });

  await page.locator('[data-networth-range="1y"]').click();
  const labels = await page.locator('#netWorthChart .chart-x-axis-label').allTextContents();
  expect(labels).toEqual(['Sep 7']);
  await expect(page.locator('#netWorthChart .chart-unavailable-label')).toHaveCount(0);
});

test('an incomplete portfolio timeframe retains its verified endpoint dates', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    preview.investments.snapshots = [
      { date: '2026-09-05', value: 215_200, source: 'verified' },
      { date: '2026-09-07', value: 217_745, source: 'verified' }
    ];
  });
  await goToView(page, 'investments');
  const yearRange = page.locator('[data-investment-range="1y"]');
  await expect(yearRange).toBeEnabled();
  await yearRange.click();
  const labels = await page.locator('#investmentChart .chart-x-axis-label').allTextContents();
  // When two verified points sit at the far end of a long requested range,
  // the latest date wins rather than overlapping labels.
  expect(labels).toEqual(['Sep 7']);
  await expect(page.locator('#investmentChart .chart-unavailable-label')).toHaveCount(0);
});

test('portfolio timeframe controls redraw the verified window instead of relabeling the same short trend', async ({ page }) => {
  // A fixed mid-month endpoint includes multiple calendar-month observations
  // even when this test runs on the first day of the actual month.
  const today = '2026-09-18';
  const ago = (days) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  await openSignedInScenario(page, (preview) => {
    // Deliberately span more than one selectable range. This is the failure
    // mode behind a portfolio chart that appeared to remain on Sep 5–Sep 7
    // regardless of the selected control.
    preview.investments.snapshots = [390, 160, 88, 31, 17, 0].map((days, index) => ({
      date: ago(days), value: 200_000 + index * 1_000, source: 'verified'
    }));
    preview.investments.total = 205_000;
  });

  await goToView(page, 'investments');
  const chart = page.locator('#investmentChart');
  const lineSegments = async () => chart.locator('.main-history-line').evaluate((line) => (line.getAttribute('d') || '').split('L').length - 1);

  const monthRange = page.locator('[data-investment-range="1m"]');
  await expect(monthRange).toBeEnabled();
  await monthRange.click();
  await expect(page.locator('[data-investment-range="1m"]')).toHaveClass(/active/);
  await expect(page.locator('#investmentContext')).toContainText('last month');
  const oneMonthSegments = await lineSegments();

  const sixMonthRange = page.locator('[data-investment-range="6m"]');
  await expect(sixMonthRange).toBeEnabled();
  await sixMonthRange.click();
  await expect(page.locator('[data-investment-range="6m"]')).toHaveClass(/active/);
  await expect(page.locator('#investmentPeriodSummary')).toHaveText('last 6 months');
  await expect(page.locator('#investmentContext')).toContainText('since Apr 11');
  const sixMonthSegments = await lineSegments();

  // More verified observations belong to six months than one month. Checking
  // the plotted path—not only the active button or helper text—guards against
  // a chart that silently keeps rendering the previous timeframe.
  expect(oneMonthSegments).toBeGreaterThanOrEqual(1);
  expect(sixMonthSegments).toBeGreaterThan(oneMonthSegments);
  const labels = await chart.locator('.chart-x-axis-label').allTextContents();
  expect(labels.length).toBeGreaterThanOrEqual(2);
  expect(new Set(labels).size).toBe(labels.length);
});

test('investment account and holding rows keep names and values independently scannable', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    preview.investments.accounts = preview.investments.accounts.map((account, index) => ({
      ...account,
      name: [
        'Employer retirement plan with a long descriptive name',
        'Individual brokerage account for long-term goals',
        'Health savings account investments'
      ][index] || account.name,
      institution_name: `Institution with a descriptive name ${index + 1}`,
      value: [186_420, 27_905, 1_250][index] || account.value
    }));
  });

  await goToView(page, 'investments');
  const accountRows = page.locator('#investmentAccounts .investment-account-row');
  await expect(accountRows).toHaveCount(3);
  const accountLayout = await accountRows.evaluateAll((rows) => rows.map((row) => {
    const name = row.querySelector('strong')?.getBoundingClientRect();
    const value = row.querySelector('b')?.getBoundingClientRect();
    return {
      row: row.getBoundingClientRect(),
      name,
      value,
      overflow: row.scrollWidth > row.clientWidth + 1
    };
  }));
  expect(accountLayout.every(({ row, name, value, overflow }) => name && value && !overflow && name.right + 4 <= value.left && value.right <= row.right + 1)).toBe(true);
  const valueEdges = accountLayout.map(({ value }) => Math.round(value.right));
  expect(Math.max(...valueEdges) - Math.min(...valueEdges)).toBeLessThanOrEqual(1);

  await page.getByText('All holdings across accounts', { exact: true }).click();
  const holdings = page.locator('#investmentPositions .holding-row');
  await expect(holdings).toHaveCount(3);
  const holdingsRemainLegible = await holdings.evaluateAll((rows) => rows.every((row) => {
    const copy = row.querySelector('.holding-copy')?.getBoundingClientRect();
    const value = row.querySelector('.position-value')?.getBoundingClientRect();
    return Boolean(copy && value && row.scrollWidth <= row.clientWidth + 1 && copy.right + 4 <= value.left);
  }));
  expect(holdingsRemainLegible).toBe(true);
});

test('investment portfolio and account rows present one reconciled verified change window', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    const [first, second] = preview.investments.accounts;
    const startDate = '2026-08-29';
    const endDate = '2026-09-12';
    const ready = (valueChange) => ({
      scope: 'account', range: 'all', state: 'ready', points: 2,
      startDate, endDate, startValue: 0, endValue: 0, valueChange, changeKind: 'balance'
    });
    preview.investments = {
      ...preview.investments,
      range: 'all', total: 3_000,
      snapshots: [
        { date: startDate, value: 3_000, source: 'verified', basis: 'account_snapshots' },
        { date: endDate, value: 3_000, source: 'verified', basis: 'account_snapshots' }
      ],
      progress: {
        scope: 'portfolio', range: 'all', state: 'ready', points: 2,
        startDate, endDate, startValue: 3_000, endValue: 3_000, valueChange: 0,
        changeKind: 'balance', basis: 'account_snapshots'
      },
      accounts: [
        { ...first, name: 'IRA', value: 1_100, rangeProgress: ready(100) },
        { ...second, name: 'Brokerage', value: 1_900, rangeProgress: ready(-100) }
      ],
      positions: [], positionsAvailable: false, allocation: []
    };
  });

  await goToView(page, 'investments');
  await expect(page.locator('#investmentTotal')).toHaveText('$3,000');
  await expect(page.locator('#investmentContext')).toHaveText('+$0 all history');
  const rows = page.locator('#investmentAccounts .investment-account-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('+$100 · all history');
  await expect(rows.nth(1)).toContainText('−$100 · all history');
});

test('a member can inspect debt accounts without a debt planning section', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    const credit = preview.dashboard.accounts.find((account) => account.type === 'credit');
    credit.name = 'Everyday card';
    credit.current_balance = 3400;
    credit.interest_rate = 24.99;
    preview.dashboard.accounts = [credit];
    preview.dashboard.summary = { ...preview.dashboard.summary, netWorth: -3400, assets: 0, liabilities: 3400 };
    preview.dashboard.debtPayoff = {
      accountCount: 1,
      totalDebt: 3400,
      strategy: 'avalanche',
      missingRates: 0,
      debts: [{ id: credit.id, name: 'Everyday card', balance: 3400, interestRate: 24.99 }],
      priority: { id: credit.id, name: 'Everyday card', balance: 3400, interestRate: 24.99 }
    };
  });

  await goToView(page, 'accounts');
  await expect(page.locator('#debtPayoffCard')).toHaveCount(0);
  const credit = page.getByRole('region', { name: 'Credit cards accounts', exact: true });
  await expect(credit.locator('[data-account-collapse]')).toHaveAttribute('aria-expanded', 'false');
  await expect(credit).toContainText('$3,400');
  await credit.locator('[data-account-collapse]').click();
  await expect(credit.getByRole('button', { name: /View Everyday card account detail/i })).toBeVisible();
});

test('a provider holding gap stays actionable without inventing a classification', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    const account = preview.dashboard.accounts.find((entry) => entry.type === 'investment');
    preview.investments.positionsAvailable = true;
    preview.investments.unclassifiedAccounts = [{ account_id: account.plaid_account_id, name: account.name, institution_name: account.institution_name, difference: 2400 }];
    preview.investments.allocation = [...preview.investments.allocation, { name: 'Cash & unclassified', value: 2400, share: 0.05 }];
  });

  await goToView(page, 'investments');
  await page.getByRole('button', { name: /cash & unclassified/i }).click();
  await expect(page.locator('#investmentPositions')).toContainText('No matching holdings returned');
  await page.getByRole('button', { name: 'Add holding' }).click();
  await expect(page.locator('#manualHoldingDialog')).toBeVisible();
  await expect(page.locator('#manualHoldingDialog')).toContainText('Add holding');
});

test('a delayed institution is explained and routed to connections without exposing provider errors', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    const item = preview.dashboard.items[0];
    item.demo = false;
    preview.dashboard.connectionHealth = [{ id: item.id, state: 'stale', requires_reconnect: false }];
  });

  await expect(page.locator('#connectionAttention')).toBeVisible();
  await expect(page.locator('#connectionAttention')).toContainText(/update delayed|retrying/i);
  await page.locator('#connectionAttentionAction').click();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await expect(page.locator('#connectionsList')).toContainText(/checking again automatically/i);
  await expect(page.locator('body')).not.toContainText('502');
});

test('long merchant names and mixed cash-flow categories remain readable and drill into activity', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    const transaction = preview.spending.transactions.find((entry) => entry.bucket !== 'income');
    transaction.name = 'A very long merchant name that must never force a dollar amount off the screen';
    transaction.merchant_name = transaction.name;
  });

  await goToView(page, 'spending');
  await page.locator('#spendingTransactionsPanel > summary').click();
  const row = page.locator('.spending-transaction-row').filter({ hasText: 'A very long merchant name' });
  await expect(row).toBeVisible();
  const staysWithinViewport = await row.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth + 1);
  expect(staysWithinViewport).toBe(true);
  await page.locator('#cashflowSankey [data-cashflow-category]').first().click();
  await expect(page.locator('#cashflowDialog')).toHaveAttribute('open', '');
  await expect(page.locator('#cashflowDialogContent .cashflow-activity-detail')).toBeVisible();
  await expect(page.locator('#spendingTransactionsPanel')).not.toHaveAttribute('open', '');
});
