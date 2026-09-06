import { test, expect } from '@playwright/test';

test.skip(Boolean(process.env.CODEX_SANDBOX_NETWORK_DISABLED), 'This workspace blocks browser loopback networking; GitHub CI runs the full browser suite.');

async function openDemo(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /see your money/i })).toBeVisible();
  await expect(page.getByText(/By continuing, you agree to our/i)).toBeVisible();
  await page.getByRole('button', { name: /explore the demo/i }).click();
  await expect(page.locator('#appShell')).toBeVisible();
  // The shell is shown before its first data request completes. Wait for a
  // rendered financial value before interacting with responsive navigation;
  // otherwise a test can click during the intentional loading transition.
  await expect(page.locator('#netWorth')).toHaveText(/\$/);
  await expect(page.locator('#appShell')).toHaveAttribute('aria-busy', 'false');
}

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

test('a new visitor can explore the complete demo without signing in', async ({ page }) => {
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

test('cash-flow interactions lead from visual category to the relevant activity', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await expect(page.locator('#cashflowSankey [data-cashflow-category]').first()).toBeVisible();

  await page.locator('#cashflowSankey [data-cashflow-category]').first().click();
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingCategoryFilter')).not.toHaveValue('all');
  await expect(page.locator('.spending-transaction-row').first()).toBeVisible();
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

test('cash-flow diagram shows dollars and share of take-home income together', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await expect(page.locator('#cashflowSankey')).toContainText('100%');
  await expect(page.locator('#cashflowSankey')).toContainText('$');
  await expect(page.locator('#cashflowSankey [data-cashflow-category="savings"]')).toBeVisible();
  await expect(page.locator('#cashflowSankey [data-cashflow-category="investments"]')).toBeVisible();
  await page.locator('[data-spending-range="6m"]').click();
  await expect(page.locator('[data-spending-range="6m"]')).toHaveClass(/active/);
  await expect(page.locator('#spendingContext')).toContainText('last 6 completed months');
});

test('cash-flow diagram stays readable on mobile and expands in-app', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  await expect(page.locator('#cashflowSankey')).toContainText('Take-home');
  const moreLabel = page.locator('#cashflowSankey .cashflow-more');
  if (await moreLabel.count()) {
    const [labelBox, svgBox] = await Promise.all([moreLabel.boundingBox(), page.locator('#cashflowSankey svg').boundingBox()]);
    expect(labelBox && svgBox && labelBox.x >= svgBox.x && labelBox.x + labelBox.width <= svgBox.x + svgBox.width).toBe(true);
  }
  await page.locator('#cashflowExpand').click();
  await expect(page.locator('#cashflowDialog')).toHaveAttribute('open', '');
  await expect(page.locator('#cashflowDialogContent svg')).toBeVisible();
  await page.locator('#cashflowDialogContent [data-cashflow-category]').first().click();
  await expect(page.locator('#cashflowDialog')).not.toHaveAttribute('open', '');
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
});

test('cash-flow quality holds at every supported viewport', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'spending');
  const diagram = page.locator('#cashflowSankey');
  await expect(diagram.locator('svg')).toBeVisible();
  await expect(diagram).toContainText('Take-home');
  const edgeWidths = await diagram.locator('.cashflow-flow').evaluateAll((paths) => paths.map((path) => Number(path.getAttribute('stroke-width'))));
  expect(Math.max(...edgeWidths)).toBeLessThanOrEqual(48);
  expect(Math.max(...edgeWidths)).toBeGreaterThan(Math.min(...edgeWidths));
  const nodeBoxes = await diagram.locator('.cashflow-target rect:first-child').evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }));
  expect(nodeBoxes.every((box) => box.width > 0 && box.height > 0)).toBe(true);
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
  await page.locator('#cashflowSankey [data-cashflow-category="income"]').click();
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingCategoryFilter')).toHaveValue('income');
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

test('net-worth history can be scrubbed and always identifies the selected date', async ({ page }) => {
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
  const holding = page.locator('.holding-row').first();
  await holding.locator('summary').click();
  await expect(holding).toHaveAttribute('open', '');
  await expect(holding.locator('.holding-account-list')).toBeVisible();
  await expect(holding.locator('.holding-account').first()).toBeVisible();
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

test('retirement milestones explain the planning terms on demand', async ({ page }) => {
  await openDemo(page);
  await goToView(page, 'retirement');
  await expect(page.locator('#retirementPath')).toContainText('Emergency fund');
  await expect(page.locator('#retirementPath')).toContainText('Work-break runway');
  await expect(page.locator('#retirementLifestylePaths')).toContainText('Essentials covered');
  await expect(page.locator('#retirementLifestylePaths')).toContainText('Current lifestyle');
  await page.getByLabel('How the freedom ladder is calculated').click();
  await expect(page.locator('.retirement-hero')).toHaveCSS('overflow', 'visible');
  await expect(page.getByText('Based on your plan')).toBeVisible();
  await expect(page.getByText('Cash milestones')).toBeVisible();
  await page.getByText('Your freedom ladder').click();
  await expect(page.locator('.retirement-method').first()).not.toHaveAttribute('open', '');
  await page.getByLabel('How the freedom ladder is calculated').click();
  await page.locator('[data-retirement-milestone="coast"]').click();
  await expect(page.locator('#retirementInfoDialog')).toHaveAttribute('open', '');
  await expect(page.locator('#retirementInfoTitle')).toHaveText('What is Coast FIRE?');
  await expect(page.locator('#retirementInfoDescription')).toContainText('without more retirement contributions');
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
