import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harness } from './_server';
import { openHrJourneyServer } from './_hr-isolated-server';
import { addCalendarDays } from '../../lib/hr-temporal';
let h: Awaited<ReturnType<typeof harness>>, owned: Awaited<ReturnType<typeof openHrJourneyServer>>, browser: Browser, day: string;
const evidence = process.env.HR_EVIDENCE_DIR ?? '/tmp/hr-rollover-native';
async function api(method: string, path: string, body?: unknown) {
  const r=await fetch(owned.baseUrl+path,{method,headers:{cookie:h.sessions.admin.cookie,origin:owned.baseUrl,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
}
beforeAll(async()=>{
  h=await harness();owned=await openHrJourneyServer(h);mkdirSync(evidence,{recursive:true});
  day=(await owned.db.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS day")).rows[0].day;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
});
afterAll(async()=>{try{await browser?.close();}finally{await owned?.close();}});
for(const width of [390,1280]) it(`refreshes the actual staff UI, filters assignment and prints truthful unknown status at ${width}`,async()=>{
  const name=`موظف انتقال اصطناعي ${width}`;
  const made=await api('POST','/api/hr/staff',{fullName:name,jobTitle:'استقبال تجريبي',department:'secretariat',workStatus:'active',hireDate:'2020-01-01',endDate:null,phone:null,note:null,contractKind:'salary',salaryAmountMinor:10000,salaryCurrency:width===390?'YER':'SAR',salaryPeriod:'monthly',salaryEffectiveOn:'2020-01-01'});
  expect(made.status).toBe(201);const id=made.body.staff?.id??made.body.id;
  const context=await browser.newContext({viewport:{width,height:900},locale:'ar-YE',timezoneId:'Asia/Aden'});
  const pair=h.sessions.admin.cookie.split(';')[0],split=pair.indexOf('=');await context.addCookies([{name:pair.slice(0,split),value:pair.slice(split+1),url:owned.baseUrl}]);
  try{
    const page=await context.newPage();await page.clock.install();await page.goto(owned.baseUrl+'/hr');await page.getByRole('tab',{name:'الطاقم'}).click();
    const row=page.getByRole('row').filter({hasText:name});await row.waitFor();expect(await row.textContent()).toContain('حالة قديمة غير مؤرخة');
    const endpoint=`/api/hr/staff/${id}/history`;
    const saved=await api('POST',endpoint,{requestId:`native-rollover-history-${width}`,expectedUsername:'secadmin',expectedRevision:0,reason:'فترة مستقبلية اصطناعية بلا استنتاج حالة سابقة',supersedeIds:[],append:[{id:'future',kind:'known',from:addCalendarDays(day,1),to:null,value:{status:'active'}}]});expect(saved.status).toBe(200);
    // Advance only browser timers: real server date is unchanged. Separate PG tests control the midnight instant.
    await page.clock.fastForward(60_001);
    await expect.poll(()=>row.textContent()).toContain('غير معروفة — راجع تاريخ العمل');
    expect((await api('GET','/api/hr/directory')).body.some((s:{id:number})=>s.id===id)).toBe(false);
    expect((await api('GET','/api/hr/staff?status=active')).body.some((s:{id:number})=>s.id===id)).toBe(false);
    await row.getByRole('button',{name:`تاريخ العمل: ${name}`,exact:true}).click();
    const dialog=page.getByRole('dialog',{name:`تاريخ العمل: ${name}`});await dialog.getByRole('form',{name:'توثيق التاريخ'}).waitFor();
    expect(await dialog.textContent()).toContain('الفجوة غير معروفة وتمنع الإسناد الجديد');
    const metrics=await dialog.evaluate(el=>({viewport:innerWidth,page:document.documentElement.scrollWidth,dialogWidth:el.scrollWidth,dialogClient:el.clientWidth,rtl:getComputedStyle(el).direction}));
    expect(metrics.page).toBeLessThanOrEqual(width+1);expect(metrics.dialogWidth).toBeLessThanOrEqual(metrics.dialogClient+1);expect(metrics.rtl).toBe('rtl');
    await page.screenshot({path:join(evidence,`rollover-unknown-${width}.png`)});
    writeFileSync(join(evidence,`rollover-unknown-${width}.json`),JSON.stringify({metrics,day,id,historyRevision:saved.body.revision,source:'real HTTP and Chromium; synthetic data; browser timer fast-forward, server time unchanged'},null,2));
    await dialog.getByRole('button',{name:'إغلاق التاريخ',exact:true}).click();
    await page.getByRole('tab',{name:'المسير والصرف'}).click();
    const preview=page.getByRole('region',{name:'معاينة التاريخ للرواتب'});
    await expect.poll(()=>preview.getByLabel('موظف المعاينة').locator(`option[value="${id}"]`).count()).toBe(1);
    await preview.getByLabel('موظف المعاينة').selectOption(String(id));
    await preview.getByLabel('من تاريخ',{exact:true}).fill(day);await preview.getByLabel('إلى تاريخ (غير مشمول)').fill(addCalendarDays(day,1));
    await preview.getByRole('button',{name:'عرض المعاينة التاريخية'}).click();
    await expect.poll(()=>preview.textContent()).toContain('حالة العمل: غير معروفة');
    await page.screenshot({path:join(evidence,`rollover-inactive-preview-${width}.png`)});
    await page.getByRole('tab',{name:'الدوام والحضور'}).click();
    await expect.poll(()=>page.getByLabel('جدول مؤرخ لموظف').locator(`option[value="${id}"]`).count()).toBe(1);
    await page.goto(owned.baseUrl+'/print/hr/staff');const printed=page.getByRole('row').filter({hasText:name});await printed.waitFor();expect(await printed.textContent()).toContain('غير معروفة — راجع تاريخ العمل');
    await page.screenshot({path:join(evidence,`rollover-print-${width}.png`),fullPage:true});
    if(width===1280)await page.pdf({path:join(evidence,'rollover-staff.pdf'),format:'A4',printBackground:true});
  }finally{await context.close();}
});
