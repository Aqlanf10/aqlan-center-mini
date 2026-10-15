import {afterAll,beforeAll,expect,it} from 'vitest';
import {chromium,type Browser} from 'playwright';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {harness} from './_server';
import {openHrJourneyServer} from './_hr-isolated-server';

let h:Awaited<ReturnType<typeof harness>>,owned:Awaited<ReturnType<typeof openHrJourneyServer>>,browser:Browser;
const evidence=process.env.HR_EVIDENCE_DIR ?? join(process.cwd(),'.hr-evidence');
beforeAll(async()=>{mkdirSync(evidence,{recursive:true});h=await harness();owned=await openHrJourneyServer(h);browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});});
afterAll(async()=>{try{await browser?.close();}finally{await owned?.close();}});
for(const width of [390,1280])it(`invalid deadline sends no write and both forms recover after correction at ${width}`,async()=>{
 const context=await browser.newContext({viewport:{width,height:900},locale:'ar-YE'});
 try{
  const [name,...value]=h.sessions.admin.cookie.split('=');await context.addCookies([{name,value:value.join('='),url:owned.baseUrl}]);
  const page=await context.newPage();const writes:string[]=[];page.on('request',r=>{if(['POST','PATCH'].includes(r.method())&&/^\/api\/tasks(?:\/\d+)?$/.test(new URL(r.url()).pathname))writes.push(r.method());});
  await page.goto(owned.baseUrl+'/hr');await page.getByRole('button',{name:'مهمة جديدة',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'مهمة جديدة',exact:true});await modal.getByLabel('العنوان',{exact:true}).fill(`موعد قابل للتصحيح ${width}`);
  // Native datetime-local accepts extended years; the application's date contract rejects them.
  await modal.getByLabel('موعد الاستحقاق',{exact:true}).fill('10000-01-01T14:00');await modal.getByRole('button',{name:'إنشاء',exact:true}).click();
  await expect.poll(()=>modal.getByRole('alert').count()).toBe(1);
  expect(await modal.getByRole('alert').innerText()).toMatch(/غير صالح/);expect(writes).toEqual([]);
  expect(await modal.getByRole('button',{name:'إنشاء',exact:true}).isEnabled()).toBe(true);
  await page.screenshot({path:join(evidence,`task-create-invalid-deadline-${width}.png`),fullPage:true});
  await modal.getByLabel('موعد الاستحقاق',{exact:true}).fill('2026-10-12T14:00');const created=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/tasks');await modal.getByRole('button',{name:'إنشاء',exact:true}).click();
  const response=await created;expect(response.status()).toBe(201);const task=await response.json();await modal.waitFor({state:'hidden'});
  await page.getByRole('button',{name:new RegExp(`موعد قابل للتصحيح ${width}`)}).first().click();await page.getByRole('button',{name:/تعديل العنوان/}).click();
  const form=page.getByRole('form',{name:'تعديل بيانات المهمة'});await form.getByLabel('موعد الاستحقاق',{exact:true}).fill('10000-01-01T14:00');await form.getByRole('button',{name:'حفظ التعديل',exact:true}).click();
  const detail=page.getByRole('dialog',{name:`المهمة: موعد قابل للتصحيح ${width}`,exact:true});await expect.poll(()=>detail.getByRole('alert').count()).toBe(1);
  expect(await detail.getByRole('alert').innerText()).toMatch(/غير صالح/);expect(writes).toEqual(['POST']);expect(await form.getByRole('button',{name:'حفظ التعديل',exact:true}).isEnabled()).toBe(true);
  await page.screenshot({path:join(evidence,`task-edit-invalid-deadline-${width}.png`),fullPage:true});
  await form.getByLabel('موعد الاستحقاق',{exact:true}).fill('2026-10-12T15:00');const saved=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname===`/api/tasks/${task.id}`);await form.getByRole('button',{name:'حفظ التعديل',exact:true}).click();expect((await saved).status()).toBe(200);
  expect(writes).toEqual(['POST','PATCH']);expect((await owned.db.query('SELECT due_at FROM hr_tasks WHERE id=$1',[task.id])).rows[0].due_at.toISOString()).toBe('2026-10-12T12:00:00.000Z');
 }finally{await context.close();}
});
