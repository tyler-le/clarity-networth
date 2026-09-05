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

  await page.locator('.mobile-nav [data-view="spending"]').click();
  await expect(page.getByRole('heading', { name: 'Cash flow' })).toBeVisible();
  await page.locator('[data-spending-range="1y"]').click();
  await expect(page.locator('.trend-column')).toHaveCount(12);
  await expect(page.locator('#cashflowSankey svg')).toBeVisible();

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

test('net-worth history can be scrubbed and always identifies the selected date', async ({ page }) => {
  await openDemo(page);
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
