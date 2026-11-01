import { test, expect } from '@playwright/test';

test.skip(Boolean(process.env.CODEX_SANDBOX_NETWORK_DISABLED), 'Browser loopback is unavailable in this sandbox.');
let nextClient = 210;
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': `198.51.100.${nextClient++}` });
  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({ body: '', contentType: 'application/javascript' }));
});

async function goToView(page, view) {
  const mobile=page.locator(`.mobile-nav [data-view="${view}"]`);
  await (await mobile.isVisible() ? mobile : page.locator(`.sidebar [data-view="${view}"]`)).click();
}
async function openDemo(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /explore the demo/i }).click();
  await expect(page.locator('#netWorth')).toHaveText(/\$/);
  await expect(page.locator('#appShell')).toHaveAttribute('aria-busy', 'false');
  await goToView(page,'investments');
  await expect(page.getByTestId('investment-account-group')).toHaveCount(3);
}

test('investment accounts contain their own holdings and remember disclosures across periods @critical', async ({ page }) => {
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await openDemo(page);
  const groups=page.getByTestId('investment-account-group');
  await expect(groups.filter({ hasText:'401(k)' })).toHaveCount(1);
  const preview=await (await page.request.get('/api/demo-preview?range=1m')).json();
  for(const account of preview.investments.accounts){
    const group=page.locator(`[data-investment-account="${account.account_id}"]`);
    const positions=preview.investments.positions.filter(position=>position.account_id===account.account_id);
    await expect(group.getByTestId('account-holding')).toHaveCount(positions.length);
    for(const position of positions)await expect(group).toContainText(position.ticker);
  }
  await expect(page.locator('#investmentHoldingsPanel')).not.toHaveAttribute('open','');
  await expect(groups.first()).not.toHaveAttribute('open','');
  await expect(groups.first().getByTestId('account-holding').first()).toBeHidden();
  await groups.first().locator('summary').click();
  await expect(groups.first()).toHaveAttribute('open','');
  await page.getByRole('button',{name:'3 months',exact:true}).click();
  await expect(page.locator('#investmentContext')).toContainText('last 3 months');
  await expect(groups.first()).toHaveAttribute('open','');
  await expect(groups.first().getByTestId('account-holding').first()).toBeVisible();
  await groups.first().getByTestId('account-holding').first().click();
  await expect(page.locator('#holdingHistoryDialog')).toBeVisible();
  await expect(page.locator('#holdingHistoryChart svg')).toBeVisible();
  expect(errors).toEqual([]);
});

test('portfolio progress, holding history, cash-flow Sankey, and dark mode remain usable @critical', async ({ page }) => {
  await openDemo(page);
  const chart=page.locator('#investmentChart');
  await expect(chart.locator('svg')).toBeVisible();
  await chart.scrollIntoViewIfNeeded();
  const bounds=await chart.boundingBox();
  await page.mouse.move(bounds.x+bounds.width*.45,bounds.y+bounds.height*.5);
  await expect(page.locator('#investmentChartDate')).toHaveText(/\d{4}/);
  await page.mouse.move(0,0);
  await page.getByText('All holdings across accounts',{exact:true}).click();
  await expect(page.locator('#investmentSort')).toBeVisible();
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  const contrast=await page.locator('.portfolio-answer').evaluate(element=>{
    const s=getComputedStyle(element);return {background:s.backgroundColor,color:s.color};
  });
  expect(contrast.background).not.toBe(contrast.color);
  await expect(page.locator('.portfolio-answer')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await goToView(page,'spending');
  await expect(page.locator('#cashflowSankey svg')).toBeVisible();
  await goToView(page,'retirement');
  await expect(page.locator('#retirementPath')).toBeVisible();
});

test('mobile header actions fit narrow phones and intermediate widths @critical', async ({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','One phone journey checks the breakpoint edges.');
  await openDemo(page);
  for(const width of [320,360,390,440,600,768]){
    await page.setViewportSize({width,height:844});
    const connect=page.getByRole('button',{name:'Connect account',exact:true});
    await expect(connect).toHaveCSS('font-size','0px');
    const [action,profile,title]=await Promise.all([connect.boundingBox(),page.getByRole('button',{name:'Open profile'}).boundingBox(),page.getByRole('heading',{name:'Investments',exact:true}).boundingBox()]);
    expect(action.width).toBeGreaterThanOrEqual(44);
    expect(action.height).toBeGreaterThanOrEqual(44);
    expect(action.x+action.width).toBeLessThanOrEqual(profile.x);
    expect(title.x+title.width).toBeLessThanOrEqual(action.x);
    expect(profile.x+profile.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  }
});
