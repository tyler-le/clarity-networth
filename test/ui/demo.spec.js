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
  await expect(page.locator('#recurringCharges')).toContainText('Netflix');
  await expect(page.locator('#goalTitle')).toHaveText('Emergency fund');
  await expect(page.locator('#goalDetail')).toContainText('Demo only');

  await goToView(page, 'investments');
  await expect(page.getByRole('heading', { name: 'Investments' })).toBeVisible();
  await expect(page.locator('#investmentChart svg')).toBeVisible();
  await expect(page.locator('.holding-row')).toHaveCount(3);
  await goToView(page, 'retirement');
  await expect(page.getByRole('heading', { name: 'Retirement' })).toBeVisible();
  await expect(page.locator('.retirement-milestone')).toHaveCount(4);
  expect(pageErrors).toEqual([]);
});

test('net worth opens as a concise financial briefing', async ({ page }) => {
  await openDemo(page);
  await expect(page.locator('#netWorthCard')).toBeVisible();
  await expect(page.locator('#balanceSheetCard')).toContainText(/where your money is/i);
  await expect(page.locator('.overview-side-rail #goalInsight')).toContainText(/your focus/i);
  await expect(page.locator('#netWorthMovement')).toContainText(/net worth|tracking starts/i);
  await expect(page.locator('#overviewGlance')).toContainText(/cash.*invested.*debt/is);
  await expect(page.locator('#clarityCheckin')).toBeVisible();
  // The secondary composition summary uses full, aligned amounts rather than
  // squeezing three large values into narrow columns.
  const compositionFits = await page.locator('#balanceSheetCard').evaluate((card) => {
    const values = [...card.querySelectorAll('.overview-glance-values strong')];
    return values.length === 3 && values.every((value) => value.scrollWidth <= value.clientWidth + 1);
  });
  expect(compositionFits).toBe(true);
  // The chart's plain-English interpretation is part of the same decision,
  // not a disconnected card farther down the dashboard.
  expect(await page.locator('#netWorthMovement').evaluate((movement) => movement.closest('#netWorthCard') === movement.parentElement)).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(overflow).toBe(false);
});

test('cash flow shows identifiable income inlets that highlight their flow', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  const paychecks = page.locator('#cashflowSankey [data-cashflow-category="income_paychecks"]');
  const interest = page.locator('#cashflowSankey [data-cashflow-category="income_interest"]');
  await expect(paychecks).toBeVisible();
  await expect(paychecks).toContainText('Paychecks');
  await expect(interest).toBeVisible();
  await expect(interest).toContainText('Interest');
  await paychecks.click();
  await expect(paychecks).toHaveClass(/is-selected/);
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingCategoryFilter')).toHaveValue('income_paychecks');
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
  const manualPrompt = page.locator('.manual-account-prompt');
  await expect(manualPrompt).toContainText('Something not connected?');
  await expect(manualPrompt.getByRole('button', { name: 'Add item' })).toBeVisible();
  const [gridBox, promptBox] = await Promise.all([page.locator('#accountGrid').boundingBox(), manualPrompt.boundingBox()]);
  expect(gridBox && promptBox && promptBox.y >= gridBox.y + gridBox.height).toBe(true);
});

test('demo visitors can try a goal without creating personal data', async ({ page }) => {
  await openDemo(page);
  await expect(page.locator('#goalTitle')).toHaveText('Emergency fund');
  await expect(page.locator('#goalDetail')).toContainText('Demo only');
  await page.locator('#goalAction').click();
  await expect(page.locator('#goalRemoveDialog')).toContainText('Emergency fund');
  await page.locator('#goalRemoveConfirm').click();
  await expect(page.locator('#goalAction')).toHaveText('Add goal');
  await page.locator('#goalAction').click();
  await page.locator('#goalName').fill('Travel fund');
  await page.locator('#goalSource').selectOption('cash');
  await page.locator('#goalTarget').fill('20000');
  await page.locator('#goalForm').getByRole('button', { name: 'Add goal' }).click();
  await expect(page.locator('#goalTitle')).toHaveText('Travel fund');
  await expect(page.locator('#goalDetail')).toContainText('Demo only');
  await expect(page.locator('#goalAction')).toHaveText('Remove');
  await page.locator('#goalAction').click();
  await expect(page.locator('#goalRemoveDialog')).toBeVisible();
  await expect(page.locator('#goalRemoveDialog')).toContainText('Travel fund');
  await page.locator('#goalRemoveCancel').click();
  await expect(page.locator('#goalTitle')).toHaveText('Travel fund');
  await page.locator('#goalAction').click();
  await page.locator('#goalRemoveConfirm').click();
  await expect(page.locator('#goalAction')).toHaveText('Add goal');
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

test('cash-flow taps filter activity without moving the reader away from the diagram', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  const node = page.locator('#cashflowSankey [data-cashflow-category="income_paychecks"]');
  await expect(node).toBeVisible();
  const before = await page.evaluate(() => scrollY);

  await node.click();
  await expect(page.locator('#cashflowSankey .cashflow-flow.is-connected')).not.toHaveCount(0);
  await expect(page.locator('#cashflowSankey .cashflow-flow.is-muted')).not.toHaveCount(0);
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingCategoryFilter')).toHaveValue('income_paychecks');
  expect(await page.evaluate(() => scrollY)).toBe(before);
});

test('cash-flow combines income before showing allocations instead of estimating paycheck destinations', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  const diagram = page.locator('#cashflowSankey');
  await expect(diagram).toContainText('Money in');
  const flows = await diagram.locator('.cashflow-flow').evaluateAll((paths) => paths.map((path) => path.dataset.cashflowFlow));
  expect(flows).toContain('income_paychecks period_funds');
  expect(flows).toContain('period_funds actual_spend');
  expect(flows).not.toContain('income_paychecks actual_spend');
  expect(flows).not.toContain('income_paychecks savings');
  expect(flows).not.toContain('income_paychecks investments');
});

test('selecting a cash-flow month keeps its income-source labels defined', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  const month = page.locator('#spendingTrend [data-spending-month]').last();
  // The SVG group is the semantic target; dispatching its click avoids a
  // viewport-dependent pointer hit-test on a thin chart bar.
  await month.evaluate((node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await expect(page.locator('#cashflowSankey')).not.toContainText('undefined');
  await expect(page.locator('#cashflowSankey [data-cashflow-category="income_paychecks"]')).toContainText('Paychecks');
});

test('cash-flow blocks trace their connected paths with a keyboard action', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  const paycheckBlock = page.locator('#cashflowSankey [data-cashflow-category="income_paychecks"]');
  // SVG focus events can be normalized differently by browser engines. Enter
  // is the durable keyboard interaction the product promises: it selects the
  // block and traces its paths without relying on a pointer hit target.
  await paycheckBlock.press('Enter');
  const focused = await page.locator('#cashflowSankey').evaluate((diagram) => ({
    connected: diagram?.querySelectorAll('.cashflow-flow.is-connected').length || 0,
    muted: diagram?.querySelectorAll('.cashflow-flow.is-muted').length || 0
  }));
  expect(focused.connected).toBeGreaterThan(0);
  expect(focused.muted).toBeGreaterThan(0);
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

test('cash-flow diagram pairs dollar amounts with meaningful secondary percentages', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await expect(page.locator('#cashflowSankey')).toContainText('Paychecks');
  await expect(page.locator('#cashflowSankey')).toContainText('Interest');
  await expect(page.locator('#cashflowSankey')).toContainText('$');
  await expect(page.locator('#cashflowSankey [data-cashflow-category="savings"]')).toBeVisible();
  await expect(page.locator('#cashflowSankey [data-cashflow-category="investments"]')).toBeVisible();
  const percentages = await page.locator('#cashflowSankey .cashflow-share').allTextContents();
  expect(percentages.length).toBeGreaterThan(0);
  expect(percentages.every((value) => /^\d{1,3}%$/.test(value) && Number(value.slice(0, -1)) <= 100)).toBe(true);
  await page.locator('[data-spending-range="6m"]').click();
  await expect(page.locator('[data-spending-range="6m"]')).toHaveClass(/active/);
  await expect(page.locator('#spendingView')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#spendingContext')).toContainText('last 6 completed months');
});

test('one cash-flow period control keeps the overview and monthly chart in sync', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await page.locator('[data-spending-range="3m"]').click();
  await expect(page.locator('[data-spending-range="3m"]')).toHaveClass(/active/);
  await expect(page.locator('#monthlyCashFlowPeriod')).toContainText('last 3 completed months');
  const month = page.locator('#spendingTrend [data-spending-month]').last();
  // The semantic SVG group is the target; dispatch directly so browser SVG
  // hit-testing cannot make this synchronization test viewport-dependent.
  await month.evaluate((node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await expect(page.locator('#clearSpendingMonth')).toBeVisible();
  await expect(page.locator('#spendingPeriodSummary')).toContainText(/selected/i);
  await expect(page.locator('[data-spending-range="3m"]')).toHaveClass(/active/);
  await page.locator('#clearSpendingMonth').click();
  await expect(page.locator('#clearSpendingMonth')).toBeHidden();
  await expect(page.locator('#monthlyCashFlowPeriod')).toContainText('last 3 completed months');
});

test('cash flow all uses the same visible range contract as its data', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await page.locator('[data-spending-range="all"]').click();
  await expect(page.locator('[data-spending-range="all"]')).toHaveClass(/active/);
  await expect(page.locator('#spendingPeriodSummary')).toContainText('all available history');
  await expect(page.locator('#monthlyCashFlowPeriod')).toContainText('all available history');
});

test('cash-flow timeframe stays available while reading the full view @critical', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  const control = page.locator('.spending-period-selector');
  await expect(control).toBeVisible();
  await expect(control).not.toHaveCSS('box-shadow', 'none');
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect.poll(() => control.evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBeGreaterThanOrEqual(0);
  await expect.poll(() => control.evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBeLessThanOrEqual(12);
  await page.locator('[data-spending-range="6m"]').click();
  await expect(page.locator('[data-spending-range="6m"]')).toHaveClass(/active/);
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
  await expect(detail).toContainText('Money in');
  await expect(detail).toContainText('Spent');
  await expect(detail).toContainText(/Left|Over/);
  const labelsStayWithValues = await detail.locator('strong').evaluateAll((items) => items.every((item) => /Money in|Spent/.test(item.textContent || '') && item.getBoundingClientRect().width > 0));
  expect(labelsStayWithValues).toBe(true);
});

test('cash-flow diagram stays readable on mobile and expands in-app', async ({ page }, testInfo) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await expect(page.locator('#cashflowSankey')).toContainText('Paychecks');
  const compactDiagram = await page.locator('#cashflowSankey').evaluate((diagram) => ({
    hasHorizontalOverflow: diagram.scrollWidth > diagram.clientWidth + 1,
    categoryNodes: diagram.querySelectorAll('[data-cashflow-category^="housing_"]').length
  }));
  // A phone keeps the primary flow to three columns, without sideways panning;
  // category detail belongs in the explicit expanded view.
  expect(compactDiagram.hasHorizontalOverflow).toBe(false);
  if (testInfo.project.name === 'phone') expect(compactDiagram.categoryNodes).toBe(0);
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
  const category = page.locator('#cashflowDialogContent [data-cashflow-category]').first();
  const categoryKey = await category.getAttribute('data-cashflow-category');
  await category.click();
  await expect(page.locator('#cashflowDialog')).toHaveAttribute('open', '');
  await expect(page.locator('#cashflowDialogContent .cashflow-activity-detail')).toBeVisible();
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingCategoryFilter')).toHaveValue(categoryKey || 'all');
  await page.locator('#cashflowDialogContent [data-cashflow-back]').click();
  await expect(page.locator('#cashflowDialogContent svg')).toBeVisible();
  await page.locator('#cashflowDialogClose').click();
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
  // SVG font metrics differ between macOS and Linux browsers, so geometry
  // comparisons here make a healthy card fail purely because its font engine
  // is different. Keep this release assertion semantic: every visible node
  // must retain a non-empty label and value. Exact visual fit belongs in the
  // optional full visual-regression sweep.
  const nodeTextIsPresent = await diagram.locator('.cashflow-target').evaluateAll((nodes) => nodes.every((node) =>
    [...node.querySelectorAll('text')].every((text) => text.textContent?.trim())
  ));
  expect(nodeTextIsPresent).toBe(true);
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

test('the income source keeps its connected flow highlighted after a tap', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await page.locator('#cashflowSankey [data-cashflow-category="income_paychecks"]').click();
  await expect(page.locator('#cashflowSankey .cashflow-flow.is-connected')).not.toHaveCount(0);
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingCategoryFilter')).toHaveValue('income_paychecks');
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
  await expect(dialog.locator('#holdingHistoryEyebrow')).toHaveText('Your position');
  await expect(dialog.locator('#holdingHistoryWhere')).toContainText('Held in');
  await expect(page.locator('.holding-row').first()).not.toHaveAttribute('open', '');
});

test('holding detail performance follows its own selected timeframe', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  await page.locator('[data-holding-history]').first().click();
  const metric = page.locator('#holdingHistoryWhere').getByTestId('holding-history-performance').first();
  await expect(metric).toBeVisible();
  await page.locator('[data-holding-history-range="1m"]').click();
  await expect(metric).toHaveAttribute('aria-label', /last month/);
});

test('changing a holding detail timeframe keeps the sheet stable while it updates @critical', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  await page.locator('[data-holding-history]').first().click();
  const dialog = page.locator('#holdingHistoryDialog');
  const chart = page.locator('#holdingHistoryChart');
  await expect(chart.locator('svg')).toBeVisible();
  let releaseRequest;
  const pendingRequest = new Promise((resolve) => { releaseRequest = resolve; });
  await page.route('**/api/demo-investments/history?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('range') === '1m') {
      await pendingRequest;
    }
    await route.continue();
  });
  await page.locator('[data-holding-history-range="1m"]').click();
  await expect(page.locator('#holdingHistoryRange')).toHaveAttribute('aria-busy', 'true');
  await expect(dialog).toBeVisible();
  await expect(chart.locator('svg')).toBeVisible();
  releaseRequest();
  await expect(page.locator('#holdingHistoryRange')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('[data-holding-history-range="1m"]')).toHaveClass(/active/);
});

test('account detail names each holding instead of repeating the account name', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  await page.getByRole('button', { name: /View 401\(k\) performance history/i }).click();
  const where = page.locator('#holdingHistoryWhere');
  await expect(page.locator('#holdingHistoryEyebrow')).toHaveText('Your account');
  await expect(page.locator('#holdingHistoryTitle')).toHaveText('401(k)');
  await expect(where).toContainText('Holdings in this account');
  await expect(where.locator('b').first()).toContainText(/VTI|VXUS|BND/);
  await expect(where.locator(':scope > div:not(.holding-history-where-heading) small').first()).toContainText(/401\(k\).*Funds/);
  await expect(where.getByTestId('holding-history-performance').first()).toContainText(/[+$−]/);
  const metricEdges = await where.locator(':scope > div:not(.holding-history-where-heading)').evaluateAll((rows) => rows.flatMap((row) => {
    const value = row.querySelector('strong');
    const performance = row.querySelector('[data-testid="holding-history-performance"]');
    if (!value || !performance) return [];
    return [Math.abs(value.getBoundingClientRect().right - performance.getBoundingClientRect().right)];
  }));
  expect(metricEdges.length).toBeGreaterThan(0);
  expect(Math.max(...metricEdges)).toBeLessThanOrEqual(1);
  await page.locator('[data-holding-history-range="1m"]').click();
  await expect(where.getByTestId('holding-history-performance-period')).toContainText(/last month performance/);
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
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('holdingHistoryDialog');
});

test('investment detail distinguishes loading, preparing, and first-snapshot tracking @critical', async ({ page }) => {
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
        state: 'tracking',
        label: 'Demo 401(k)',
        ticker: 'FXAIX',
        value: 12_345,
        history: [{ date: '2026-09-07', value: 12_345 }],
        market: [],
        detail: 'Tracking from a verified institution update on 2026-09-07.'
      })
    });
  });
  await page.locator('[data-holding-history]').first().click();
  await expect(chart.locator('[data-history-state="tracking"]')).toBeVisible();
  await expect(chart).toContainText(/tracking began/i);
  await expect(chart).not.toContainText(/personal history unavailable/i);
  await expect(chart.locator('svg')).toBeVisible();
});

test('holding detail timeframes stay local to the drill-in chart', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  const portfolioRange = page.locator('[data-investment-range].active');
  await expect(portfolioRange).toHaveCount(1);
  const portfolioRangeName = await portfolioRange.getAttribute('data-investment-range');
  await page.locator('[data-holding-history]').first().click();
  await page.locator('[data-holding-history-range="1m"]').click();
  await expect(page.locator('[data-holding-history-range="1m"]')).toHaveClass(/active/);
  await expect(page.locator(`[data-investment-range="${portfolioRangeName}"]`)).toHaveClass(/active/);
});

test('account chart endpoints use the exact verified window behind its metric', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  await page.locator('[data-investment-account-history]').first().click();
  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/demo-investments/history')
    && new URL(response.url()).searchParams.get('range') === '1m');
  await page.locator('[data-holding-history-range="1m"]').click();
  const payload = await (await responsePromise).json();
  expect(payload.progress.state).toBe('ready');
  const format = (date) => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  await expect(page.locator('#holdingHistoryChart .holding-history-axis.start')).toHaveText(format(payload.progress.startDate));
  await expect(page.locator('#holdingHistoryChart .holding-history-axis.end')).toHaveText(format(payload.progress.endDate));
});

test('holding-chart values stay inside the chart at both timeline boundaries', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  await page.locator('[data-holding-history]').first().click();
  const chart = page.locator('#holdingHistoryChart');
  await expect(chart.locator('svg')).toBeVisible();
  const box = await chart.boundingBox();
  for (const x of [box.x + 1, box.x + box.width - 1]) {
    await chart.hover({ position: { x: x - box.x, y: Math.min(90, box.height / 2) } });
    const tooltip = chart.locator('.chart-tooltip');
    await expect(tooltip).toBeVisible();
    const tooltipBox = await tooltip.boundingBox();
    expect(tooltipBox.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(box.x + box.width + 1);
  }
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
  expect(await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.borderTopWidth === '0px' && style.borderRightWidth === '0px' && style.outlineStyle === 'none';
  })).toBe(true);
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
  // The quiet visual pill has a full-width, 44px touch region behind it.
  expect(handleBox.width).toBeGreaterThanOrEqual(dialogBox.width * .8);
  expect(handleBox.height).toBeGreaterThanOrEqual(40);
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
  await expect(dialog).toHaveCSS('transform', /matrix\(1, 0, 0, 1, 0, (?:[4-9]\d|[1-9]\d\d)\)/);
  await handle.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 41, clientY: 190 });
  await expect(dialog).toBeHidden();

  // A bottom sheet also dismisses from its dimmed backdrop. Dispatch on the
  // native dialog itself, which is the browser's event target for that area.
  await page.locator('[data-holding-history]').first().click();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none');
  await dialog.evaluate((element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
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
  await expect(page.locator('#investmentPeriodSummary')).toHaveText('last 3 months');
  await expect(page.locator('#investmentContext')).toContainText('last 3 months');
  await expect(page.locator('#investmentHoldingsInsight')).toContainText('last 3 months selected');
  await page.locator('[data-investment-range="6m"]').click();
  await expect(page.locator('[data-investment-range="6m"]')).toHaveClass(/active/);
  await expect(page.locator('#investmentContext')).toContainText('last 6 months');
});

test('portfolio timeframe stays available while comparing accounts and holdings @critical', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'investments');
  const control = page.getByTestId('investment-period-selector');
  await expect(control).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 700));
  await expect.poll(() => control.evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBeGreaterThanOrEqual(0);
  await expect.poll(() => control.evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBeLessThanOrEqual(12);
  await page.locator('[data-investment-range="3m"]').click();
  await expect(page.locator('[data-investment-range="3m"]')).toHaveClass(/active/);
  await expect(page.locator('#investmentContext')).toContainText('last 3 months');
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
