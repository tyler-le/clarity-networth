import { test, expect } from '@playwright/test';

test.skip(Boolean(process.env.CODEX_SANDBOX_NETWORK_DISABLED), 'This workspace blocks browser loopback networking; GitHub CI runs the full browser suite.');

// The public demo is rate-limited per visitor in production. Each Playwright
// test is a separate visitor journey, so give it a distinct documentation-only
// address rather than making all 92 journeys look like one abusive client.
// This preserves the real limiter while keeping viewport coverage deterministic.
let nextTestClient = 10;
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': `198.51.100.${nextTestClient++}` });
});

async function openDemo(page) {
  // The local browser server deliberately has no real OAuth credentials. Mock
  // only the public configuration response so this test exercises the
  // production access-code gate without contacting Google.
  await page.route('**/api/auth/config', (route) => route.fulfill({ json: { configured: true, googleClientId: 'test-client-id.apps.googleusercontent.com' } }));
  // The demo journey never authenticates. Stub the optional Google script so
  // an unrelated third-party network delay cannot hold the document load open.
  await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({ contentType: 'application/javascript', body: 'window.google={accounts:{id:{initialize(){},renderButton(){}}}};' }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /see your money/i })).toBeVisible();
  await expect(page.locator('#inviteCode')).toBeVisible();
  await expect(page.locator('#inviteCode')).toHaveAttribute('type', 'text');
  await expect(page.locator('#inviteCode')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
  await expect(page.locator('#googleSignIn')).toBeHidden();
  await expect(page.locator('#accessCodeStatus')).toHaveText('');
  await expect(page.locator('.auth-intro')).toHaveText('A calm, clear view of your net worth, accounts, and path ahead.');
  await expect(page.getByText(/By continuing, you agree to our/i)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  await expect(page.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
  await page.getByRole('button', { name: /explore the demo/i }).click();
  await expect(page.locator('#appShell')).toBeVisible();
  // The shell is shown before its first data request completes. Wait for a
  // rendered financial value before interacting with responsive navigation;
  // otherwise a test can click during the intentional loading transition.
  await expect(page.locator('#netWorth')).toHaveText(/\$/, { timeout: 15_000 });
  await expect(page.locator('#appShell')).toHaveAttribute('aria-busy', 'false');
}

test('a verified access code unlocks the single Google sign-in action', async ({ page }) => {
  await page.route('**/api/auth/config', (route) => route.fulfill({ json: { configured: true, googleClientId: 'test-client-id.apps.googleusercontent.com' } }));
  await page.route('**/api/auth/access-code', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: "window.google={accounts:{id:{initialize:function(){},renderButton:function(el){el.innerHTML='<button type=\"button\">Continue with Google</button>';}}}};"
  }));
  await page.goto('/');
  await page.locator('#inviteCode').fill('VALID-CODE');
  await page.locator('#inviteCode').press('Enter');
  await expect(page.locator('#accessCodeStatus')).toHaveText('Access confirmed. Continue with Google.');
  await expect(page.locator('#googleSignIn').getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.locator('#beginGoogleSignIn')).toHaveCount(0);
});

async function goToView(page, view) {
  const mobile = page.locator(`.mobile-nav [data-view="${view}"]`);
  if (await mobile.isVisible()) {
    await mobile.click();
    return;
  }
  await page.locator(`.sidebar [data-view="${view}"]`).click();
}

test('a slow first load shows calm placeholders before financial data arrives', async ({ page }) => {
  let releasePreview;
  const previewHeld = new Promise((resolve) => { releasePreview = resolve; });
  await page.route('**/api/demo-preview?range=1m', async (route) => {
    // Hold the actual response until the assertion has observed the loading
    // state. A fixed delay races the browser scheduler in CI and can allow the
    // response to finish before Playwright checks the skeleton.
    await previewHeld;
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: /explore the demo/i }).click();
  await expect(page.locator('#loadingSkeleton')).toBeVisible();
  await expect(page.locator('#loadingSkeleton .skeleton-hero')).toBeVisible();
  releasePreview();
  await expect(page.locator('#netWorth')).toHaveText(/\$/);
  await expect(page.locator('#loadingSkeleton')).toBeHidden();
  await expect(page.locator('#netWorthChart svg')).toBeVisible();
});

test('demo recovers from one failed initial request instead of leaving an empty shell', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/demo-preview?range=1m', async (route) => {
    attempts += 1;
    if (attempts === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporarily unavailable' }) });
    else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: /explore the demo/i }).click();
  await expect(page.locator('#netWorth')).toHaveText(/\$/);
  expect(attempts).toBe(2);
});

test('a new visitor can explore the complete demo without signing in @critical', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openDemo(page);

  await expect(page.getByRole('heading', { name: 'Net Worth' })).toBeVisible();
  await expect(page.locator('#netWorth')).toHaveText(/\$/);
  await expect(page.locator('#netWorthChart svg')).toBeVisible();

  await goToView(page, 'spending');
  await expect(page.getByRole('heading', { name: 'Cash flow' })).toBeVisible();
  await page.locator('[data-spending-range="1y"]').click();
  await expect(page.locator('.trend-column')).toHaveCount(12);
  await expect(page.locator('.trend-month')).toHaveCount(12);
  const positiveBarsStayAboveZero = await page.locator('#spendingTrend svg').evaluate((svg) => {
    const zero = Number(svg.querySelector('.trend-grid.zero')?.getAttribute('y1'));
    return [...svg.querySelectorAll('.trend-column rect')]
      .filter((bar) => bar.getAttribute('fill') === 'var(--income)')
      .every((bar) => Number(bar.getAttribute('y')) + Number(bar.getAttribute('height')) <= zero + .01);
  });
  expect(positiveBarsStayAboveZero).toBe(true);
  await expect(page.locator('#cashflowSankey svg')).toBeVisible();
  await expect(page.locator('#recurringCharges')).toBeVisible();

  await goToView(page, 'investments');
  await expect(page.getByRole('heading', { name: 'Investments' })).toBeVisible();
  await expect(page.locator('#investmentChart svg')).toBeVisible();
  await expect(page.locator('.holding-row')).toHaveCount(3);
  await goToView(page, 'retirement');
  await expect(page.getByRole('heading', { name: 'Retirement' })).toBeVisible();
  await expect(page.locator('.retirement-milestone')).toHaveCount(4);
  expect(pageErrors).toEqual([]);
});

test('cash flow shows an identifiable income inlet that filters its activity', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  const paychecks = page.locator('#cashflowSankey [data-cashflow-category="income_paychecks"]');
  const interest = page.locator('#cashflowSankey [data-cashflow-category="income_interest"]');
  await expect(paychecks).toBeVisible();
  await expect(paychecks).toContainText('Paychecks');
  await expect(interest).toBeVisible();
  await expect(interest).toContainText('Interest');
  await paychecks.click();
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingTransactions')).toContainText('Payroll');
});

test('a demo visitor can exit from Profile and return to sign-in', async ({ page }) => {
  await openDemo(page);
  await page.locator('#profileButton').click();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await expect(page.locator('#demoToggle')).toHaveText('Exit demo');
  await page.locator('#demoToggle').click();
  await expect(page.locator('#authScreen')).toBeVisible();
  await expect(page.locator('#appShell')).toBeHidden();
  await expect(page.locator('#inviteCode')).toBeVisible();
});

test('accounts makes a simple debt payoff choice actionable without a separate dashboard', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'accounts');
  const card = page.locator('#debtPayoffCard');
  await expect(card).toBeVisible();
  await expect(card).toContainText('One clear next step, when you’re ready');
  await expect(card.getByRole('button', { name: /view plan/i })).toBeVisible();
  await expect(card.getByRole('button', { name: /save most interest/i })).toHaveCount(0);
  await card.getByRole('button', { name: /view plan/i }).click();
  await expect(card).toContainText(/debt payoff/i);
  await expect(card).toContainText('Save most interest');
  await expect(card).toContainText('Chase Sapphire Preferred');
  await card.getByRole('button', { name: /small wins first/i }).click();
  await expect(card.getByRole('button', { name: /small wins first/i })).toHaveClass(/active/);
  await expect(card).toContainText('Capital One Venture, your smallest balance');
  await expect(page.locator('#accountGrid')).toContainText('••4821');
});

test('demo visitors can try a goal without creating personal data', async ({ page }) => {
  await openDemo(page);
  await page.locator('#goalAction').click();
  await page.locator('#goalName').fill('Travel fund');
  await page.locator('#goalSource').selectOption('cash');
  await page.locator('#goalTarget').fill('20000');
  await page.locator('#goalForm').getByRole('button', { name: 'Add goal' }).click();
  await expect(page.locator('#goalTitle')).toHaveText('Travel fund');
  await expect(page.locator('#goalDetail')).toContainText('Demo only');
  await expect(page.locator('#goalAction')).toHaveText('Remove');
});

test('debt rates remain editable after a first entry', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'accounts');
  const card = page.locator('#debtPayoffCard');
  await card.getByRole('button', { name: /view plan/i }).click();
  await card.locator('.debt-rate-editor summary').click();
  const rate = card.locator('[data-debt-rate="demo-credit"]');
  await expect(rate).toHaveValue('24.49');
  await rate.fill('18.5');
  await card.getByRole('button', { name: 'Save rates' }).click();
  await expect(card.locator('.debt-rate-editor summary')).toContainText('Edit interest rates');
  await card.locator('.debt-rate-editor summary').click();
  await expect(card.locator('[data-debt-rate="demo-credit"]')).toHaveValue('18.5');
});

test('cash-flow interactions lead from visual category to the relevant activity', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await expect(page.locator('#cashflowSankey [data-cashflow-category]').first()).toBeVisible();

  await page.locator('#cashflowSankey [data-cashflow-category]').first().click();
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingCategoryFilter')).not.toHaveValue('all');
  await expect(page.locator('.spending-transaction-row').first()).toBeVisible();
});

test('cash-flow blocks trace their connected paths before opening activity', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  const paycheckBlock = page.locator('#cashflowSankey [data-cashflow-category="income_paychecks"]');
  await paycheckBlock.focus();
  await expect(page.locator('#cashflowSankey .cashflow-flow.is-connected')).not.toHaveCount(0);
  await expect(page.locator('#cashflowSankey .cashflow-flow.is-muted')).not.toHaveCount(0);
});

test('asset-allocation filters preserve the reader position', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  const allocation = page.locator('#investmentAllocationCard');
  await allocation.scrollIntoViewIfNeeded();
  const before = await allocation.evaluate((element) => element.getBoundingClientRect().top);
  await page.locator('[data-investment-filter="Funds"]').click();
  await expect.poll(async () => allocation.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0);
  await expect(page.locator('#investmentHoldingsInsight')).toContainText('Funds');
});

test('cash-flow diagram shows clear dollar amounts without misleading over-income percentages', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await expect(page.locator('#cashflowSankey')).toContainText('Paychecks');
  await expect(page.locator('#cashflowSankey')).toContainText('Interest');
  await expect(page.locator('#cashflowSankey')).toContainText('$');
  await expect(page.locator('#cashflowSankey [data-cashflow-category="savings"]')).toBeVisible();
  await expect(page.locator('#cashflowSankey [data-cashflow-category="investments"]')).toBeVisible();
  await expect(page.locator('#cashflowSankey')).not.toContainText('%');
  await page.locator('[data-spending-range="6m"]').click();
  await expect(page.locator('[data-spending-range="6m"]')).toHaveClass(/active/);
  await expect(page.locator('#spendingView')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#spendingContext')).toContainText('last 6 completed months');
});

test('cash-flow diagram omits zero-dollar cells and flows', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  const zeroValueCells = await page.locator('#cashflowSankey .cashflow-target').evaluateAll((nodes) => nodes.filter((node) => /\$0(?:\.00)?(?:\s|$)/.test(node.textContent || '')).length);
  expect(zeroValueCells).toBe(0);
  const zeroWidthFlows = await page.locator('#cashflowSankey .cashflow-flow').evaluateAll((paths) => paths.filter((path) => Number(path.getAttribute('stroke-width')) <= 0).length);
  expect(zeroWidthFlows).toBe(0);
});

test('monthly cash-flow values stay self-labeled instead of relying on a detached legend', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop-specific chart-header coverage.');
  await openDemo(page);
  await goToView(page, 'spending');
  const detail = page.locator('#trendDetail');
  await expect(detail).toContainText('Income');
  await expect(detail).toContainText('Spent');
  await expect(detail).toContainText(/Left|Over/);
  const labelsStayWithValues = await detail.locator('strong').evaluateAll((items) => items.every((item) => /Income|Spent/.test(item.textContent || '') && item.getBoundingClientRect().width > 0));
  expect(labelsStayWithValues).toBe(true);
});

test('cash-flow diagram stays readable on mobile and expands in-app', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await expect(page.locator('#cashflowSankey')).toContainText('Paychecks');
  const moreLabel = page.locator('#cashflowSankey .cashflow-more');
  if (await moreLabel.count()) {
    const [labelBox, diagramBox] = await Promise.all([moreLabel.boundingBox(), page.locator('#cashflowSankey').boundingBox()]);
    expect(labelBox && diagramBox && labelBox.x >= diagramBox.x && labelBox.x + labelBox.width <= diagramBox.x + diagramBox.width).toBe(true);
    await moreLabel.click();
    await expect(page.locator('#cashflowDialog')).toHaveAttribute('open', '');
    await page.locator('#cashflowDialogClose').click();
  }
  await page.locator('#cashflowExpand').click();
  await expect(page.locator('#cashflowDialog')).toHaveAttribute('open', '');
  await expect(page.locator('#cashflowDialogContent svg')).toBeVisible();
  await page.locator('#cashflowDialogContent [data-cashflow-category]').first().click();
  await expect(page.locator('#cashflowDialog')).not.toHaveAttribute('open', '');
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
});

test('cash-flow quality holds at every supported viewport @critical', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  const diagram = page.locator('#cashflowSankey');
  await expect(diagram.locator('svg')).toBeVisible();
  await expect(diagram).toContainText('Paychecks');
  const edgeWidths = await diagram.locator('.cashflow-flow').evaluateAll((paths) => paths.map((path) => Number(path.getAttribute('stroke-width'))));
  expect(Math.max(...edgeWidths)).toBeLessThanOrEqual(35);
  expect(Math.max(...edgeWidths)).toBeGreaterThan(Math.min(...edgeWidths));
  const nodeBoxes = await diagram.getByTestId('cashflow-node-surface').evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { width: box.width, height: box.height, fill: node.getAttribute('fill'), fillOpacity: Number(node.getAttribute('fill-opacity')), stroke: node.getAttribute('stroke') };
  }));
  expect(nodeBoxes.every((box) => box.width > 0 && box.height > 0)).toBe(true);
  expect(nodeBoxes.every((box) => box.fill && box.fill !== 'transparent' && box.fillOpacity > 0 && box.stroke && box.stroke !== 'transparent')).toBe(true);
  const categoryColors = await diagram.locator('[data-cashflow-category]').getByTestId('cashflow-node-accent').evaluateAll((stripes) => new Set(stripes.map((stripe) => stripe.getAttribute('fill'))).size);
  expect(categoryColors).toBeGreaterThan(2);
  await page.locator('#cashflowExpand').click();
  await expect(page.locator('#cashflowDialog')).toHaveAttribute('open', '');
  await expect(page.locator('#cashflowDialogContent svg')).toBeVisible();
  await page.locator('#cashflowDialogClose').click();
});

test('the complete app stays navigable and coherent at every supported viewport', async ({ page }) => {
  await openDemo(page);
  for (const [view, heading] of [['spending', 'Cash flow'], ['investments', 'Investments'], ['retirement', 'Retirement'], ['accounts', 'Accounts']]) {
    await goToView(page, view);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await page.locator('#profileButton').click();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await expect(page.locator('#connectionsList')).toContainText('Fidelity');
  await expect(page.locator('#connectionsList')).toContainText('Sample connection');
  await expect(page.locator('#connectionsList .unlink-button')).toHaveCount(0);
  await expect(page.locator('.beta-help a')).toHaveAttribute('href', '/support');
  await page.locator('#profileBack').click();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  const homeBrand = page.locator('#homeBrand');
  if (await homeBrand.isVisible()) {
    await homeBrand.click();
    await expect(page.getByRole('heading', { name: 'Net Worth' })).toBeVisible();
  }
  await expect(page.locator('#appShell')).toBeVisible();
});

test('the income source opens income activity from the cash-flow diagram', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await page.locator('#cashflowSankey [data-cashflow-category="income_paychecks"]').click();
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingCategoryFilter')).toHaveValue('income_paychecks');
  await expect(page.locator('.income-transaction').first()).toBeVisible();
});

test('payroll contributions open their own cash-flow activity', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await expect(page.locator('#cashflowPreTax')).toBeVisible();
  await page.locator('#cashflowPreTax').click();
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingCategoryFilter')).toHaveValue('payroll_retirement');
  await expect(page.locator('.payroll-transaction').first()).toContainText('401(k)');
  await expect(page.locator('#spendingTransactionsPanel summary')).toBeFocused();
});

test('net-worth history can be scrubbed and always identifies the selected date @critical', async ({ page }) => {
  await openDemo(page);
  await page.locator('[data-networth-range="6m"]').click();
  await expect(page.locator('[data-networth-range="6m"]')).toHaveClass(/active/);
  await page.locator('[data-networth-range="3m"]').click();
  await expect(page.locator('[data-networth-range="3m"]')).toHaveClass(/active/);
  const chart = page.locator('#netWorthChart');
  await expect(chart.locator('svg')).toBeVisible();
  const box = await chart.boundingBox();
  if (!box) throw new Error('Net worth chart did not have a layout box.');
  const pointerX = box.x + box.width * 0.2;
  await page.mouse.move(pointerX, box.y + box.height * 0.55);
  await expect(page.locator('#netWorthChartDate')).toHaveText(/\d{4}/);
  await expect(page.locator('#netWorthDelta')).toContainText('Assets');
  const selectedDate = await page.locator('#netWorthChartDate').boundingBox();
  const chartSvg = await chart.locator('svg').boundingBox();
  expect(selectedDate && chartSvg && selectedDate.y + selectedDate.height <= chartSvg.y).toBe(true);
  const xAxisLabels = await chart.locator('.chart-x-axis-label').allTextContents();
  expect(new Set(xAxisLabels).size).toBe(xAxisLabels.length);
  const scrubPosition = await chart.locator('.scrub-line').evaluate((line) => {
    const svg = line.ownerSVGElement;
    const box = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    return box.left + Number(line.getAttribute('x1')) / viewBox.width * box.width;
  });
  expect(Math.abs(scrubPosition - pointerX)).toBeLessThan(10);
  const afterScrub = await chart.boundingBox();
  expect(afterScrub?.y).toBe(box.y);
});

test('holding details preserve account context without crowding the overview', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  await page.locator('[data-holding-history]').first().click();
  const dialog = page.locator('#holdingHistoryDialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#holdingHistoryWhere')).toContainText('Holdings in this account');
  await expect(page.locator('.holding-row').first()).not.toHaveAttribute('open', '');
});

test('account detail names each holding instead of repeating the account name', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  await page.getByRole('button', { name: /View 401\(k\) performance history/i }).click();
  const where = page.locator('#holdingHistoryWhere');
  await expect(where).toContainText('Holdings in this account');
  await expect(where.locator('b').first()).toContainText(/FXAIX|FSPSX/);
  await expect(where.locator('small').first()).toContainText(/401\(k\).*Funds/);
});

test('holding and account drill-ins show only a person’s verified position history', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  await page.locator('[data-holding-history]').first().click();
  const dialog = page.locator('#holdingHistoryDialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Your position' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#holdingHistoryChart svg')).toBeVisible();
  await expect(page.locator('#holdingHistoryNote')).toContainText(/verified.*updates/i);
  await expect(dialog.getByRole('tab', { name: 'Market price' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.locator('[data-investment-account-history]').first().click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Your position' })).toBeVisible();
});

test('investment detail distinguishes loading, preparing, and unavailable personal history @critical', async ({ page }) => {
  let releaseHistory;
  const historyHeld = new Promise((resolve) => { releaseHistory = resolve; });
  await page.route('**/api/demo-investments/history**', async (route) => {
    await historyHeld;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'preparing',
        label: 'Demo 401(k)',
        ticker: 'FXAIX',
        value: 12_345,
        history: [],
        market: [],
        reason: 'Your institution is still preparing reported activity for this account.'
      })
    });
  });
  await openDemo(page);
  await goToView(page, 'investments');
  await page.locator('[data-holding-history]').first().click();
  const chart = page.locator('#holdingHistoryChart');
  await expect(chart.locator('[data-history-state="loading"]')).toBeVisible();
  await expect(chart).toContainText(/loading history/i);

  releaseHistory();
  await expect(chart.locator('[data-history-state="preparing"]')).toBeVisible();
  await expect(chart).toContainText(/preparing your history/i);
  await expect(chart.locator('svg')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(page.locator('#holdingHistoryDialog')).toBeHidden();
  await page.unroute('**/api/demo-investments/history**');
  await page.route('**/api/demo-investments/history**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'unavailable',
        label: 'Demo 401(k)',
        ticker: 'FXAIX',
        value: 12_345,
        history: [],
        market: [],
        reason: 'We could not reconcile reported activity with this account’s current value.'
      })
    });
  });
  await page.locator('[data-holding-history]').first().click();
  await expect(chart.locator('[data-history-state="unavailable"]')).toBeVisible();
  await expect(chart).toContainText(/personal history unavailable/i);
  await expect(chart).toContainText(/could not reconcile reported activity/i);
  await expect(chart.locator('svg')).toHaveCount(0);
});

test('holding detail timeframes stay local to the drill-in chart', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  await expect(page.locator('[data-investment-range="1y"]')).toHaveClass(/active/);
  await page.locator('[data-holding-history]').first().click();
  await page.locator('[data-holding-history-range="1m"]').click();
  await expect(page.locator('[data-holding-history-range="1m"]')).toHaveClass(/active/);
  await expect(page.locator('[data-investment-range="1y"]')).toHaveClass(/active/);
  await expect(page.locator('[data-investment-range="1m"]')).not.toHaveClass(/active/);
});

test('investment detail cards stay readable without horizontal overflow on a phone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'Phone-specific responsive coverage.');
  await openDemo(page);
  await goToView(page, 'investments');
  await page.locator('[data-holding-history]').first().click();
  const dialog = page.locator('#holdingHistoryDialog');
  await expect(dialog).toBeVisible();
  const handle = dialog.locator('.holding-history-drag-handle');
  await expect(handle).toBeVisible();
  await expect(page.locator('#holdingHistoryClose')).toBeHidden();
  // Measure after the sheet has settled; transforms participate in bounding
  // boxes while its entry animation is still running.
  await page.waitForTimeout(350);
  const [dialogBox, viewport] = await Promise.all([dialog.boundingBox(), page.evaluate(() => ({ width: innerWidth, height: innerHeight }))]);
  // Native dialogs can measure one device pixel narrower than the visual
  // viewport because browsers account for a scrollbar differently. Verify the
  // actual mobile contract instead: an edge-to-edge, bottom-anchored sheet.
  expect(dialogBox && dialogBox.x <= 1 && dialogBox.width >= viewport.width - 2 && dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= viewport.height + 1, JSON.stringify({ dialogBox, viewport })).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  for (const selector of ['#holdingHistoryMetrics', '#holdingHistoryRange', '#holdingHistoryWhere']) {
    expect(await page.locator(selector).evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  const handleBox = await handle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + 130, { steps: 4 });
  await page.mouse.up();
  await expect(dialog).toBeHidden();

  // Do not let a mouse-only gesture test mask a broken phone path. Synthetic
  // touch-pointer events exercise the same capture/fallback path iOS uses.
  await page.locator('[data-holding-history]').first().click();
  await expect(dialog).toBeVisible();
  await handle.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 41, clientY: 100 });
  await handle.dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 41, clientY: 190 });
  await handle.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 41, clientY: 190 });
  await expect(dialog).toBeHidden();
});

test('portfolio history can be scrubbed just like net worth', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  const chart = page.locator('#investmentChart');
  await expect(chart.locator('svg')).toBeVisible();
  const box = await chart.boundingBox();
  if (!box) throw new Error('Portfolio chart did not have a layout box.');
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.55);
  await expect(page.locator('#investmentChartDate')).toHaveText(/\d{4}/);
  await expect(page.locator('#investmentTotal')).toHaveText(/\$/);
});

test('investment timeframes keep the portfolio context in sync', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  await page.locator('[data-investment-range="3m"]').click();
  await expect(page.locator('[data-investment-range="3m"]')).toHaveClass(/active/);
  await expect(page.locator('#investmentContext')).toContainText('last 3 months');
  await expect(page.locator('#investmentHoldingsInsight')).toContainText('last 3 months selected');
  await page.locator('[data-investment-range="6m"]').click();
  await expect(page.locator('[data-investment-range="6m"]')).toHaveClass(/active/);
  await expect(page.locator('#investmentContext')).toContainText('last 6 months');
});

test('investment account values share one calm right edge for quick scanning', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  const rightEdges = await page.locator('#investmentAccounts .investment-account-row b').evaluateAll((values) => values.map((value) => {
    const box = value.getBoundingClientRect();
    return Math.round(box.right);
  }));
  expect(rightEdges.length).toBeGreaterThan(1);
  expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThanOrEqual(1);
});

test('retirement milestones explain the planning terms on demand', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'retirement');
  await expect(page.locator('#retirementPath')).toContainText('Emergency fund');
  await expect(page.locator('#retirementPath')).toContainText('Six-month buffer');
  await expect(page.locator('#retirementPath')).toContainText('Amount needed today to fund retirement by age 65 without further contributions');
  await expect(page.locator('#retirementPath .retirement-milestone')).toHaveCount(4);
  await expect(page.locator('#retirementProjectionContext')).toContainText(/On pace for \$[\d,]+ by age 65/);
  await expect(page.getByText('Retirement spending targets')).toBeVisible();
  await expect(page.locator('#retirementSpendContext')).toContainText('Needed by age 65, in today’s dollars · Based on your last 12 months of spending.');
  await page.locator('#retirementAdjust summary').click();
  const retirementAgeInput = page.locator('#retirementRetireAgeValue');
  await retirementAgeInput.fill('66');
  await retirementAgeInput.press('Enter');
  await expect(page.locator('#retirementForm [name="retirement_age"]')).toHaveValue('66');
  await expect(page.locator('#retirementLifestylePaths')).toContainText('Essentials covered');
  await expect(page.locator('#retirementLifestylePaths')).toContainText('Current lifestyle');
  await expect(page.locator('#retirementLifestylePaths')).toContainText('Housing, food, insurance, and other basics');
  await page.getByLabel('How the freedom ladder is calculated').click();
  await expect(page.locator('.retirement-hero')).toHaveCSS('overflow', 'visible');
  await expect(page.getByText('What the ladder represents')).toBeVisible();
  await expect(page.getByText('Cash milestones')).toBeVisible();
  await expect(page.locator('.retirement-hero .retirement-method-popover').getByText('Coast independence', { exact: true })).toBeVisible();
  const ladderTipBounds = await page.locator('.retirement-hero .retirement-method-popover').evaluate((popover) => {
    const rect = popover.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
  });
  expect(ladderTipBounds.top).toBeGreaterThanOrEqual(12);
  expect(ladderTipBounds.bottom).toBeLessThanOrEqual(ladderTipBounds.viewportHeight);
  await page.getByText('Your freedom ladder').click();
  await expect(page.locator('.retirement-method').first()).not.toHaveAttribute('open', '');
  await page.getByLabel('How the freedom ladder is calculated').click();
  await page.locator('[data-retirement-milestone="coast"]').click();
  await expect(page.locator('#retirementInfoDialog')).toHaveAttribute('open', '');
  await expect(page.locator('#retirementInfoTitle')).toHaveText('What is Coast independence?');
  await expect(page.locator('#retirementInfoDescription')).toHaveText('The amount you need invested today so that, without contributing any more, it can grow enough to fund your retirement by your target age.');
  await expect(page.locator('#retirementInfoTargetLabel')).toHaveText('Needed today · Can grow to age 65');
  await expect(page.locator('#retirementInfoTiming')).toHaveText(/Already reached|Est\. [A-Z][a-z]{2} \d{4}|Set a saving pace/);
});

test('the retirement ladder remains legible and usable on a phone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'Phone-specific layout regression');
  await openDemo(page);
  await goToView(page, 'retirement');
  const layout = await page.locator('#retirementPath').evaluate((path) => {
    const cards = [...path.querySelectorAll('.retirement-milestone')];
    const pathRect = path.getBoundingClientRect();
    return {
      overflows: path.scrollWidth > path.clientWidth + 1,
      cardCount: cards.length,
      usableCardWidth: cards.every((card) => card.getBoundingClientRect().width >= pathRect.width * .42)
    };
  });
  expect(layout.overflows).toBe(false);
  expect(layout.cardCount).toBe(4);
  expect(layout.usableCardWidth).toBe(true);
  await page.locator('[data-retirement-milestone="coast"]').click();
  await expect(page.locator('#retirementInfoDialog')).toHaveAttribute('open', '');
});

test('retirement spending help stays inside a phone viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'Phone-specific help layout regression');
  await openDemo(page);
  await goToView(page, 'retirement');
  await page.getByLabel('How lifestyle paths are calculated').click();
  const bounds = await page.locator('.retirement-lifestyles .retirement-method-popover').evaluate((popover) => {
    const rect = popover.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
  await page.getByRole('heading', { name: 'Retirement' }).click();
  await expect(page.locator('.retirement-lifestyles .retirement-method')).not.toHaveAttribute('open', '');
});

test('dark mode is a calm, persistent profile setting', async ({ page }) => {
  await openDemo(page);
  await page.locator('#profileButton').click();
  const toggle = page.locator('#themeToggle');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: /explore the demo/i }).click();
  await expect(page.locator('#appShell')).toBeVisible();
  await goToView(page, 'investments');
  // Dark surfaces are deliberately neutral rather than green-tinted, so the
  // accent color keeps its visual meaning.
  await expect(page.locator('.investment-card')).toHaveCSS('background-color', 'rgb(28, 31, 29)');
  await expect(page.locator('#investmentTotal')).toHaveCSS('color', 'rgb(240, 244, 240)');
  await goToView(page, 'accounts');
  await expect(page.locator('#connectButton')).toHaveCSS('background-color', 'rgb(45, 116, 74)');
  await expect(page.locator('#profileButton')).toHaveCSS('background-color', 'rgb(32, 39, 32)');
  await page.locator('#profileButton').click();
  await page.locator('#profileBack').click();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
});
