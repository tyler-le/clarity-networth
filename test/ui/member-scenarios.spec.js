import { test, expect } from '@playwright/test';

test.skip(Boolean(process.env.CODEX_SANDBOX_NETWORK_DISABLED), 'This workspace blocks browser loopback networking; GitHub CI runs the full browser suite.');

let nextTestClient = 90;
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': `198.51.100.${nextTestClient++}` });
});

async function goToView(page, view) {
  if (view === 'profile') return page.locator('#profileButton').click();
  const mobile = page.locator(`.mobile-nav [data-view="${view}"]`);
  if (await mobile.isVisible()) return mobile.click();
  return page.locator(`.sidebar [data-view="${view}"]`).click();
}

// Uses the complete, realistic demo contract as a baseline, then makes one
// meaningful change for a member situation. The UI is real; only the service
// boundary is mocked. This catches rendering and interaction regressions
// without requiring Plaid, Google, or market-data calls in browser tests.
async function openSignedInScenario(page, transform = () => {}) {
  const response = await page.request.get('/api/demo-preview?range=1m');
  expect(response.ok()).toBe(true);
  const preview = await response.json();
  transform(preview);
  preview.dashboard.demoMode = false;
  preview.dashboard.appearance = { theme: 'light' };
  preview.dashboard.plaidConfigured = true;
  preview.dashboard.user = { email: 'scenario@example.test', name: 'Scenario member' };

  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { user: { email: 'scenario@example.test', name: 'Scenario member' } } }));
  await page.route('**/api/dashboard', (route) => route.fulfill({ json: preview.dashboard }));
  await page.route(/\/api\/spending(?:\?.*)?$/, (route) => route.fulfill({ json: preview.spending }));
  await page.route('**/api/investments', (route) => route.fulfill({ json: preview.investments }));
  await page.route('**/api/retirement', (route) => route.fulfill({ json: preview.retirement }));
  await page.route('**/api/launch-event', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/settings/debt-strategy', (route) => route.fulfill({ json: preview.dashboard.debtPayoff || {} }));
  await page.goto('/');
  await expect(page.locator('#appShell')).toBeVisible();
  await expect(page.locator('#appShell')).toHaveAttribute('aria-busy', 'false');
}

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
  await expect(page.locator('#debtPayoffCard')).toBeVisible();
  await expect(page.locator('#netWorth')).toHaveText('Your net worth');
  await expect(page.locator('#netWorthMovementTitle')).toHaveText('Understand what changed');
  await goToView(page, 'spending');
  await expect(page.locator('#freshSpendingState')).toBeHidden();
  await expect(page.locator('#cashFlowOverviewCard')).toBeVisible();
  await expect(page.locator('#spendingView .onboarding-tab-cta')).toBeVisible();
  await expect(page.locator('#cashflowHeadline')).toHaveText('Income, spending, and saving in one view');
  await goToView(page, 'investments');
  await expect(page.locator('#investmentsView .onboarding-tab-cta')).toBeVisible();
  await expect(page.locator('#investmentTotal')).toHaveText('Your portfolio');
  await goToView(page, 'retirement');
  await expect(page.locator('#retirementView .onboarding-tab-cta')).toBeVisible();
  await expect(page.locator('#retirementProjection')).toHaveText('Your retirement outlook');
  await goToView(page, 'accounts');
  await expect(page.locator('#accountsView .onboarding-tab-cta')).toBeVisible();
  await expect(page.locator('#accountsSummary strong').first()).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  await goToView(page, 'profile');
  await expect(page.locator('#profileName')).toHaveText('Scenario member');
  await expect(page.locator('#profileEmail')).toHaveText('scenario@example.test');
  await expect(page.locator('.profile-settings-panel')).toBeVisible();
  await expect(page.locator('#signOutButton')).toBeVisible();
  const signOutIsLastProfileAction = await page.locator('#signOutButton').evaluate((button) => button.closest('.profile-settings-panel')?.lastElementChild?.contains(button));
  expect(signOutIsLastProfileAction).toBe(true);
  await expect(page.locator('#connectionsList')).toContainText('No connected institutions.');
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
  await expect(page.locator('#accountGrid')).toContainText('Cash & savings');
  await expect(page.locator('#debtPayoffCard')).toBeHidden();
  await expect(page.locator('#accountGrid .account-section')).toHaveCount(1);
});

test('accounts groups cash, investments, and debt without repeating collection cards', async ({ page }) => {
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
  const sections = page.locator('#accountGrid .account-section');
  await expect(sections).toHaveCount(3);
  await expect(sections.locator('h2')).toHaveText(['Cash & savings', 'Investments', 'Debt']);
  await expect(page.locator('#accountGrid .account-collection')).toHaveCount(0);
  const sectionRules = await sections.evaluateAll((items) => items.slice(1).every((item) => getComputedStyle(item).borderTopWidth === '1px'));
  expect(sectionRules).toBe(true);

  const debtMore = page.locator('[data-account-group="Debt"]');
  await expect(debtMore).toHaveText(/view 1 more/i);
  await debtMore.click();
  await expect(debtMore).toHaveText(/show less/i);
  await expect(sections.nth(2).locator('.account-item')).toHaveCount(3);
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
  await expect(page.locator('#netWorthDelta')).not.toContainText(/estimated/i);
  const netChart = page.locator('#netWorthChart');
  const netBox = await netChart.boundingBox();
  await netChart.dispatchEvent('pointerdown', { clientX: netBox.x + 48, clientY: netBox.y + netBox.height / 2, pointerId: 1 });
  await expect(page.locator('#netWorthChartDate')).not.toContainText(/estimated/i);
  await netChart.dispatchEvent('pointerup');
  await goToView(page, 'investments');
  await page.locator('[data-investment-range="all"]').click();
  await expect(page.locator('#investmentContext')).not.toContainText(/estimated/i);
  await page.route('**/api/investments/history**', (route) => route.fulfill({ json: {
    state: 'ready', label: 'Investment account', value: 1300, reconstructed: false, history, market: [],
    detail: 'Based on 4 verified daily updates from your connected institution.'
  } }));
  await page.getByRole('button', { name: /View .+ performance history/ }).first().click();
  await expect(page.locator('#holdingHistoryDialog')).toBeVisible();
  await expect(page.locator('#holdingHistoryNote')).toContainText('verified daily updates');
  await page.getByRole('button', { name: 'All', exact: true }).last().click();
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

test('a short portfolio window spanning months still uses distinct calendar dates', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    preview.investments.snapshots = [
      { date: '2026-08-30', value: 215_200, source: 'verified' },
      { date: '2026-09-05', value: 216_450, source: 'verified' },
      { date: '2026-09-07', value: 217_745, source: 'verified' }
    ];
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
  await openSignedInScenario(page, (preview) => {
    preview.dashboard.snapshots = [
      { date: '2026-09-05', net_worth: 237_200, source: 'verified' },
      { date: '2026-09-06', net_worth: 240_663, source: 'verified' },
      { date: '2026-09-07', net_worth: 240_603, source: 'verified' }
    ];
  });

  await page.locator('[data-networth-range="1m"]').click();
  const labels = await page.locator('#netWorthChart .chart-x-axis-label').allTextContents();
  expect(labels.length).toBeGreaterThanOrEqual(1);
  expect(labels.every((label) => /^[A-Z][a-z]{2} \d+$/.test(label))).toBe(true);
  expect(new Set(labels).size).toBe(labels.length);
  await expect(page.locator('#netWorthChart .chart-unavailable-label')).toHaveText(/Since|Tracking began/);
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
  await expect(page.locator('#netWorthChart .chart-unavailable-label')).toHaveText(/Since|Tracking began/);
});

test('an incomplete portfolio timeframe retains its verified endpoint dates', async ({ page }) => {
  await openSignedInScenario(page, (preview) => {
    preview.investments.snapshots = [
      { date: '2026-09-05', value: 215_200, source: 'verified' },
      { date: '2026-09-07', value: 217_745, source: 'verified' }
    ];
  });
  await goToView(page, 'investments');
  await page.locator('[data-investment-range="1y"]').click();
  const labels = await page.locator('#investmentChart .chart-x-axis-label').allTextContents();
  expect(labels).toEqual(['Sep 5', 'Sep 7']);
  await expect(page.locator('#investmentChart .chart-unavailable-label')).toHaveText(/Since|Tracking began/);
});

test('portfolio timeframe controls redraw the verified window instead of relabeling the same short trend', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  const ago = (days) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  await openSignedInScenario(page, (preview) => {
    // Deliberately span more than one selectable range. This is the failure
    // mode behind a portfolio chart that appeared to remain on Sep 5–Sep 7
    // regardless of the selected control.
    preview.investments.snapshots = [390, 160, 88, 31, 5, 0].map((days, index) => ({
      date: ago(days), value: 200_000 + index * 1_000, source: 'verified'
    }));
    preview.investments.total = 205_000;
  });

  await goToView(page, 'investments');
  const chart = page.locator('#investmentChart');
  const lineSegments = async () => chart.locator('.main-history-line').evaluate((line) => (line.getAttribute('d') || '').split('L').length - 1);

  await page.locator('[data-investment-range="1m"]').click();
  await expect(page.locator('[data-investment-range="1m"]')).toHaveClass(/active/);
  await expect(page.locator('#investmentContext')).toContainText('last month');
  const oneMonthSegments = await lineSegments();

  await page.locator('[data-investment-range="6m"]').click();
  await expect(page.locator('[data-investment-range="6m"]')).toHaveClass(/active/);
  await expect(page.locator('#investmentContext')).toContainText('last 6 months');
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

  const holdings = page.locator('#investmentPositions .holding-row');
  await expect(holdings).toHaveCount(3);
  const holdingsRemainLegible = await holdings.evaluateAll((rows) => rows.every((row) => {
    const copy = row.querySelector('.holding-copy')?.getBoundingClientRect();
    const value = row.querySelector('.position-value')?.getBoundingClientRect();
    return Boolean(copy && value && row.scrollWidth <= row.clientWidth + 1 && copy.right + 4 <= value.left);
  }));
  expect(holdingsRemainLegible).toBe(true);
});

test('a member with debt receives one optional next step, not an alarming wall of payoff controls', async ({ page }) => {
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
  const payoff = page.locator('#debtPayoffCard');
  await expect(payoff).toBeVisible();
  await expect(payoff.getByRole('button', { name: /view plan/i })).toBeVisible();
  await expect(payoff.getByRole('button', { name: /save most interest/i })).toHaveCount(0);
  await payoff.getByRole('button', { name: /view plan/i }).click();
  await expect(payoff.getByRole('button', { name: /save most interest/i })).toBeVisible();
  await expect(payoff).toContainText('Everyday card');
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
  await expect(page.locator('#connectionsList')).toContainText(/retrying automatically/i);
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
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
});
