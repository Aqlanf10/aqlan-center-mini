import { beforeAll, afterAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { chromium, type Browser } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { baseUrl, harness } from './_server';
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let appointmentId: number;
const api = () => `/api/appointments/${appointmentId}/followup`;
beforeAll(async () => {
  h = await harness(); db = new Client({connectionString:h.seeded.dbUrl,ssl:false}); await db.connect();
  const {rows:[row]} = await db.query(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status)
    VALUES ($1,'2000-01-01','10:00','no_show') RETURNING id`,[h.seeded.patientAId]);
  appointmentId=row.id;
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
});
afterAll(async()=>{await browser?.close();await db?.end();});
it('enforces roles, no-store, patient witness, method and CSRF over real HTTP',async()=>{
  for (const role of ['doctorA','doctorB','accountant','cashier'] as const) {
    for (const path of ['/api/appointment-followups',`${api()}?patientId=${h.seeded.patientAId}`]) {
      const response=await fetch(baseUrl+path,{headers:{Cookie:h.sessions[role].cookie}});
      expect(response.status).toBe(403);
    }
    expect((await fetch(baseUrl+api()+'/retire',{method:'POST',headers:{Cookie:h.sessions[role].cookie,Origin:baseUrl,'Content-Type':'application/json'},body:'{}'})).status).toBe(403);
    expect((await fetch(baseUrl+api(),{method:'POST',headers:{Cookie:h.sessions[role].cookie,Origin:baseUrl,'Content-Type':'application/json'},body:'{}'})).status).toBe(403);
  }
  const headers={Cookie:h.sessions.reception.cookie};
  expect((await fetch(`${baseUrl}${api()}?patientId=${h.seeded.patientBId}`,{headers})).status).toBe(409);
  expect((await fetch(`${baseUrl}/api/appointment-followups?limit=101`,{headers})).status).toBe(400);
  const response=await fetch(`${baseUrl}/api/appointment-followups`,{headers});
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
  expect((await fetch(baseUrl+api(),{method:'POST',headers:{...headers,Origin:'https://example.invalid','Content-Type':'application/json'},body:'{}'})).status).toBe(403);
});
it('mobile RTL: explicit create, lost-response retry survives reload, no-answer stays open, no send stamp',async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'ar-YE'});
  const [name,...value]=h.sessions.reception.cookie.split('=');
  await context.addCookies([{name,value:value.join('='),url:baseUrl}]);
  const page=await context.newPage();
  const patientUrl=`${baseUrl}/patients/${h.seeded.patientAId}?tab=summary`;
  await page.goto(patientUrl);
  const appointments=page.getByRole('region',{name:'مواعيد المريض',exact:true});
  await appointments.getByRole('button',{name:'السابقة والمغلقة'}).click();
  const row=page.locator(`[data-patient-appointment="${appointmentId}"]`);
  await row.getByRole('button',{name:'متابعة الغياب',exact:true}).click();
  const editor=row.getByRole('region',{name:'إجراء متابعة الغياب'});
  await expect.poll(()=>editor.getByRole('button',{name:'فتح متابعة',exact:true}).isEnabled()).toBe(true);
  let dropped=false;
  await page.route(`**/api/appointments/${appointmentId}/followup`,async route=>{
    if(route.request().method()==='POST'&&!dropped){dropped=true;await route.fetch();await route.abort('failed');}else await route.continue();
  });
  await editor.getByRole('button',{name:'فتح متابعة',exact:true}).click();
  await expect.poll(async()=>Number((await db.query('SELECT count(*) FROM appointment_followup_events e JOIN appointment_followups f ON f.id=e.followup_id WHERE f.source_appointment_id=$1',[appointmentId])).rows[0].count)).toBe(1);
  await expect.poll(()=>editor.getByRole('button',{name:'إلغاء محاولة منتهية لم تُحفظ',exact:true}).isEnabled()).toBe(true);
  const savedBefore=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('appointment-followup:v1:')));
  await editor.getByRole('button',{name:'إلغاء محاولة منتهية لم تُحفظ',exact:true}).click();
  await expect.poll(()=>editor.getByText(/حُفظت سابقاً/).count()).toBe(1);
  expect(await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('appointment-followup:v1:')))).toEqual(savedBefore);
  await page.reload();
  await appointments.getByRole('button',{name:'السابقة والمغلقة'}).click();
  await row.getByRole('button',{name:'متابعة الغياب',exact:true}).click();
  const retry=editor.getByRole('button',{name:'إعادة المحاولة نفسها',exact:true});
  await expect.poll(()=>retry.isEnabled()).toBe(true);await retry.click();
  await expect.poll(()=>editor.getByRole('button',{name:'حفظ نتيجة المتابعة',exact:true}).isEnabled()).toBe(true);
  expect(Number((await db.query('SELECT count(*) FROM appointment_followup_events e JOIN appointment_followups f ON f.id=e.followup_id WHERE f.source_appointment_id=$1',[appointmentId])).rows[0].count)).toBe(1);
  await editor.getByLabel('نتيجة المتابعة').selectOption('no_answer');
  await editor.getByRole('button',{name:'حفظ نتيجة المتابعة',exact:true}).click();
  await expect.poll(async()=> (await db.query('SELECT status,outcome,revision FROM appointment_followups WHERE source_appointment_id=$1',[appointmentId])).rows[0]).toEqual({status:'open',outcome:'no_answer',revision:2});
  expect((await db.query('SELECT reminder_sent_at,status FROM appointments WHERE id=$1',[appointmentId])).rows[0]).toEqual({reminder_sent_at:null,status:'no_show'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(await editor.getAttribute('dir')).toBe('rtl');
  await mkdir('docs/review/appointment-followup-queue/evidence',{recursive:true});
  await editor.screenshot({path:'docs/review/appointment-followup-queue/evidence/patient-editor-390.png'});
  await page.screenshot({path:'docs/review/appointment-followup-queue/evidence/patient-390.png',fullPage:true});
  await page.goto(baseUrl);
  const queue=page.getByRole('region',{name:'قائمة متابعة الغياب'});
  await expect.poll(()=>queue.getByText('لم يرد',{exact:false}).count()).toBeGreaterThan(0);
  await page.screenshot({path:'docs/review/appointment-followup-queue/evidence/today-390.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'docs/review/appointment-followup-queue/evidence/today-1280.png',fullPage:true});
  await context.close();
});
