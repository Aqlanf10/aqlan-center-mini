import {afterAll,beforeAll,expect,it} from 'vitest';
import {chromium,type Browser} from 'playwright';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {harness} from './_server';
import {openHrJourneyServer} from './_hr-isolated-server';

let h:Awaited<ReturnType<typeof harness>>,owned:Awaited<ReturnType<typeof openHrJourneyServer>>,browser:Browser;
const evidence=process.env.HR_EVIDENCE_DIR ?? join(process.cwd(),'.hr-evidence');
beforeAll(async()=>{
 mkdirSync(evidence,{recursive:true});h=await harness();owned=await openHrJourneyServer(h);
 const {rows:[staff]}=await owned.db.query("INSERT INTO hr_staff(full_name,department,created_by) VALUES('مرجع قديم اصطناعي','other','secadmin') RETURNING id");
 for(const [reason,refs] of [
  ['طلب بمرجع تاريخي تالف',[{id:{legacy:1},name:{legacy:2}},null,{id:'  ',name:' '},{id:7,name:8}]],
  ['طلب بمرجع نصي صالح',[{id:'paper-42',name:'مرجع ورقي محفوظ'}]],
 ] as const)await owned.db.query("INSERT INTO hr_leave_requests(staff_id,leave_type_code,start_date,end_date,days_count,reason,attachment_refs,created_by) VALUES($1,'unpaid','2026-08-01','2026-08-01',1,$2,$3::jsonb,'secadmin')",[staff.id,reason,JSON.stringify(refs)]);
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
});
afterAll(async()=>{try{await browser?.close();}finally{await owned?.close();}});
for(const width of [390,1280])it(`keeps other leave rows readable with object-valued legacy references at ${width}`,async()=>{
 const context=await browser.newContext({viewport:{width,height:900},locale:'ar-YE'});
 try{
  const [name,...value]=h.sessions.admin.cookie.split('=');await context.addCookies([{name,value:value.join('='),url:owned.baseUrl}]);
  const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(owned.baseUrl+'/hr');await page.getByRole('tab',{name:'الإجازات'}).click();
  await expect.poll(()=>page.getByText('طلب بمرجع نصي صالح',{exact:false}).count()).toBe(1);
  expect(await page.getByText('مرجع قديم يحتاج مراجعة (غير صالح)',{exact:true}).count()).toBe(4);
  expect(await page.getByText('مرجع ورقي محفوظ (paper-42)',{exact:true}).count()).toBe(1);
  expect(await page.getByRole('button',{name:'تقديم طلب إجازة'}).isEnabled()).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({path:join(evidence,`legacy-leave-references-${width}.png`),fullPage:true});
 }finally{await context.close();}
});
