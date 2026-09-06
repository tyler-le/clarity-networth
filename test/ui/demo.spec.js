import { test, expect } from '@playwright/test';

test.skip(Boolean(process.env.CODEX_SANDBOX_NETWORK_DISABLED), 'This workspace blocks browser loopback networking; GitHub CI runs the full browser suite.');

async function openDemo(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /see your money/i })).toBeVisible();
  await page.getByRole('button', { name: /explore the demo/i }).click();
  await expect(page.locator('#appShell')).toBeVisible();
}

test('a new visitor can explore the complete demo without signing in', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openDemo(page);

  await expect(page.getByRole('heading', { name: 'Net Worth' })).toBeVisible();
  await expect(page.locator('#netWorth')).toHaveText(/\$/);
  await expect(page.locator('#netWorthChart svg')).toBeVisible();
  await expect(page.locator('#weeklyInsight')).toBeVisible();

  await page.locator('.mobile-nav [data-view="spending"]').click();
  await expect(page.getByRole('heading', { name: 'Cash flow' })).toBeVisible();
  await page.locator('[data-spending-range="1y"]').click();
  await expect(page.locator('.trend-column')).toHaveCount(12);
  await expect(page.locator('#cashflowSankey svg')).toBeVisible();
  await expect(page.locator('#recurringCharges')).toBeVisible();

  await page.locator('.mobile-nav [data-view="investments"]').click();
  await expect(page.getByRole('heading', { name: 'Investments' })).toBeVisible();
  await expect(page.locator('#investmentChart svg')).toBeVisible();
  await expect(page.locator('.holding-row')).toHaveCount(3);
  await page.locator('.mobile-nav [data-view="retirement"]').click();
  await expect(page.getByRole('heading', { name: 'Retirement' })).toBeVisible();
  await expect(page.locator('.retirement-milestone')).toHaveCount(4);
  expect(pageErrors).toEqual([]);
});

test('cash-flow interactions lead from visual category to the relevant activity', async ({ page }) => {
  await openDemo(page);
  await page.locator('.mobile-nav [data-view="spending"]').click();
  await expect(page.locator('#cashflowSankey [data-cashflow-category]').first()).toBeVisible();

  await page.locator('#cashflowSankey [data-cashflow-category]').first().click();
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingCategoryFilter')).not.toHaveValue('all');
  await expect(page.locator('.spending-transaction-row').first()).toBeVisible();
});

test('cash-flow diagram can switch between dollars and take-home-income percentages', async ({ page }) => {
  await openDemo(page);
  await page.locator('.mobile-nav [data-view="spending"]').click();
  await page.locator('[data-cashflow-display="percentage"]').click();
  await expect(page.locator('[data-cashflow-display="percentage"]')).toHaveClass(/active/);
  await expect(page.locator('#cashflowSankey')).toContainText('100%');
  await page.locator('[data-cashflow-display="amount"]').click();
  await expect(page.locator('#cashflowSankey')).toContainText('$');
  await expect(page.locator('#cashflowSankey [data-cashflow-category="savings"]')).toBeVisible();
  await expect(page.locator('#cashflowSankey [data-cashflow-category="investments"]')).toBeVisible();
  await page.locator('[data-spending-range="6m"]').click();
  await expect(page.locator('[data-spending-range="6m"]')).toHaveClass(/active/);
  await expect(page.locator('#spendingContext')).toContainText('last 6 completed months');
});

test('the income source opens income activity from the cash-flow diagram', async ({ page }) => {
  await openDemo(page);
  await page.locator('.mobile-nav [data-view="spending"]').click();
  await page.locator('#cashflowSankey [data-cashflow-category="income"]').click();
  await expect(page.locator('#spendingTransactionsPanel')).toHaveAttribute('open', '');
  await expect(page.locator('#spendingCategoryFilter')).toHaveValue('income');
  await expect(page.locator('.income-transaction').first()).toBeVisible();
});

test('payroll contributions open their own cash-flow activity', async ({ page }) => {
  await openDemo(page);
  await page.locator('.mobile-nav [data-view="spending"]').click();
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
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.55);
  await expect(page.locator('#netWorthChartDate')).toHaveText(/\d{4}/);
  await expect(page.locator('#netWorthDelta')).toContainText('Assets');
});

test('holding details preserve account context without crowding the overview', async ({ page }) => {
  await openDemo(page);
  await page.locator('.mobile-nav [data-view="investments"]').click();
  const holding = page.locator('.holding-row').first();
  await holding.locator('summary').click();
  await expect(holding).toHaveAttribute('open', '');
  await expect(holding.locator('.holding-account-list')).toBeVisible();
  await expect(holding.locator('.holding-account').first()).toBeVisible();
});

test('portfolio history can be scrubbed just like net worth', async ({ page }) => {
  await openDemo(page);
  await page.locator('.mobile-nav [data-view="investments"]').click();
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
  await page.locator('.mobile-nav [data-view="investments"]').click();
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
  await page.locator('.mobile-nav [data-view="retirement"]').click();
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
  await page.locator('.mobile-nav [data-view="investments"]').click();
  await expect(page.locator('.investment-card')).toHaveCSS('background-color', 'rgb(26, 32, 28)');
  await expect(page.locator('#investmentTotal')).toHaveCSS('color', 'rgb(240, 244, 240)');
  await page.locator('.mobile-nav [data-view="accounts"]').click();
  await expect(page.locator('#connectButton')).toHaveCSS('background-color', 'rgb(45, 116, 74)');
  await expect(page.locator('#profileButton')).toHaveCSS('background-color', 'rgb(32, 39, 32)');
  await page.locator('#profileButton').click();
  await page.locator('#profileBack').click();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
});
