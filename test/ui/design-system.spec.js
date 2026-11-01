import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test.skip(Boolean(process.env.CODEX_SANDBOX_NETWORK_DISABLED), 'Browser loopback unavailable in this sandbox.');
let client=140;
test.beforeEach(async ({page})=>{
  await page.setExtraHTTPHeaders({'X-Forwarded-For':`198.51.100.${client++}`});
  await page.route('https://accounts.google.com/gsi/client',route=>route.fulfill({body:'',contentType:'application/javascript'}));
});

async function contrastFindings(page){
  return page.evaluate(()=>{
    const parse=s=>{const n=s.match(/[\d.]+/g)?.map(Number);const scale=s.startsWith('color(srgb')?255:1;return n?.length>=3?[n[0]*scale,n[1]*scale,n[2]*scale,n[3]??1]:[0,0,0,0];};
    const blend=(front,back)=>front.slice(0,3).map((v,i)=>v*front[3]+back[i]*(1-front[3])).concat(1);
    const luminance=c=>c.slice(0,3).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
    const selectors='.financial-answer *, .primary, .primary *, .secondary, .secondary *, .text-button, .text-button *, .nav-item.active, .mobile-nav button.active, .demo-preview-button, .demo-preview-button *, .range-control button.active';
    return [...document.querySelectorAll(selectors)].flatMap(el=>{
      if(!el.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})||!el.getBoundingClientRect().width)return [];
      const text=[...el.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent.trim()).join('');
      if(!text)return [];
      const style=getComputedStyle(el);const color=parse(style.color);
      const chain=[];for(let node=el;node;node=node.parentElement)chain.unshift(node);
      let bg=[255,255,255,1];for(const node of chain)bg=blend(parse(getComputedStyle(node).backgroundColor),bg);
      const fg=blend(color,bg),a=luminance(fg),b=luminance(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      const size=parseFloat(style.fontSize),large=size>=24||(size>=18.66&&Number(style.fontWeight)>=700);
      return ratio+.01<(large?3:4.5)?[{text:text.slice(0,70),id:el.id,class:el.className,color:style.color,background:bg,ratio:Math.round(ratio*100)/100,required:large?3:4.5}]:[];
    });
  });
}

for(const view of ['auth','overview','spending','investments','retirement','accounts','profile']){
  test(`${view} uses cohesive controls and readable contrast in both themes @critical`,async({page},testInfo)=>{
    await page.goto('/');
    if(view!=='auth'){
      await page.getByRole('button',{name:/explore the demo/i}).click();
      await expect(page.locator('#netWorth')).toHaveText(/\$/);
      await expect(page.locator('#appShell')).toHaveAttribute('aria-busy','false');
      if(view==='profile')await page.getByRole('button',{name:'Open profile'}).click();
      else if(view!=='overview'){
        const mobile=page.locator(`.mobile-nav [data-view="${view}"]`);
        await (await mobile.isVisible()?mobile:page.locator(`.sidebar [data-view="${view}"]`)).click();
      }
      if(view==='investments')await expect(page.getByTestId('investment-account-group')).toHaveCount(3);
    }
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme==='dark'?'dark':'',theme);
      expect(await contrastFindings(page),`${view}/${theme} contrast failures`).toEqual([]);
      const controls=page.locator('.primary:visible, .secondary:visible, .demo-preview-button:visible, .financial-answer button:visible');
      for(const control of await controls.all()){
        await control.hover();
        expect(await contrastFindings(page),`${view}/${theme} hover contrast`).toEqual([]);
        await page.keyboard.press('Tab');
        await control.focus();
        expect(await contrastFindings(page),`${view}/${theme} focus contrast`).toEqual([]);
      }
      await page.mouse.move(0,0);
      await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),`${view}/${theme} overflow`).toBe(false);
      if(['phone','desktop'].includes(testInfo.project.name)&&process.env.CLARITY_CAPTURE_DESIGN==='true'){
        fs.mkdirSync('.playwright-data/design-review',{recursive:true});
        await page.screenshot({path:`.playwright-data/design-review/${testInfo.project.name}-${view}-${theme}.png`});
      }
    }
  });
}
