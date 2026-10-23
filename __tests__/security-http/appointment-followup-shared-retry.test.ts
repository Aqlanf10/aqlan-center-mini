import { beforeAll, afterAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { chromium, type Browser, type Page, type Locator } from 'playwright';
import { baseUrl, harness } from './_server';
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
beforeAll(async () => {
  h=await harness(); db=new Client({connectionString:h.seeded.dbUrl,ssl:false}); await db.connect();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
});
afterAll(async()=>{await browser?.close();await db?.end();});
async function openHistory(page:Page,id:number){
  await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=summary`);
  await page.getByRole('region',{name:'مواعيد المريض',exact:true}).getByRole('button',{name:'السابقة والمغلقة'}).click();
  const row=page.locator(`[data-patient-appointment="${id}"]`);
  await row.getByRole('button',{name:'متابعة الغياب',exact:true}).click();
  const editor=row.getByRole('region',{name:'إجراء متابعة الغياب'});
  await expect.poll(()=>editor.getByRole('button',{name:/حفظ نتيجة المتابعة|إعادة المحاولة نفسها/}).isEnabled()).toBe(true);
  return editor;
}
it.each(['two editors','two tabs'])('%s cannot replace or delete a lost-response attempt; reload replays exactly once',async mode=>{
  const {rows:[source]}=await db.query(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status) VALUES ($1,'2000-01-01','10:00','no_show') RETURNING id`,[h.seeded.patientAId]);
  const endpoint=`${baseUrl}/api/appointments/${source.id}/followup`;
  const headers={Cookie:h.sessions.reception.cookie,Origin:baseUrl,'Content-Type':'application/json'};
  const editorContext=await (await fetch(`${endpoint}?patientId=${h.seeded.patientAId}`,{headers})).json();
  const created=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({...editorContext.source,expectedActorUserId:editorContext.actorUserId,requestId:crypto.randomUUID(),expectedRevision:0,assigneeUserId:editorContext.actorUserId,dueAt:new Date(Date.now()+86400000).toISOString(),status:'open',outcome:'pending',nextStep:'call'})});
  expect(created.status).toBe(201);
  const key=`appointment-followup:v1:${editorContext.actorUserId}:${h.seeded.patientAId}:${source.id}`;
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const [name,...value]=h.sessions.reception.cookie.split('=');await context.addCookies([{name,value:value.join('='),url:baseUrl}]);
  // Delivery of advisory UI notifications may be delayed in inactive documents.
  // Correctness must come from the shared lock/store protocol, never these events.
  await context.addInitScript(()=>{
    window.addEventListener('storage',e=>e.stopImmediatePropagation(),true);
    window.addEventListener('appointment-followup-attempt-changed',e=>e.stopImmediatePropagation(),true);
  });
  const a=await context.newPage(); const aEditor=await openHistory(a,source.id);
  const b=mode==='two tabs'?await context.newPage():a;
  let bEditor: Locator;
  if(mode==='two tabs')bEditor=await openHistory(b,source.id);
  else {
    const queue=a.getByRole('region',{name:'قائمة متابعة الغياب'});
    const task=queue.locator(`[data-followup-appointment="${source.id}"]`);
    await task.getByRole('button',{name:'متابعة الغياب',exact:true}).click();
    bEditor=task.getByRole('region',{name:'إجراء متابعة الغياب'});
    await expect.poll(()=>bEditor.getByRole('button',{name:'حفظ نتيجة المتابعة',exact:true}).isEnabled()).toBe(true);
  }
  let release!:()=>void; const held=new Promise<void>(resolve=>{release=resolve;});
  let original=''; let first=true;
  await a.route(endpoint,async route=>{
    if(route.request().method()==='POST'&&first){first=false;original=route.request().postData()!;await route.fetch();await held;await route.abort('failed').catch(()=>{});}else await route.continue();
  });
  try {
    await aEditor.getByRole('button',{name:'حفظ نتيجة المتابعة',exact:true}).click();
    await expect.poll(async()=> (await db.query('SELECT revision FROM appointment_followups WHERE source_appointment_id=$1',[source.id])).rows[0]?.revision).toBe(2);
    await bEditor.getByRole('button',{name:'حفظ نتيجة المتابعة',exact:true}).click();
    await expect.poll(()=>b.evaluate(k=>localStorage.getItem(k),key)).toBe(original);
    release();
    await expect.poll(()=>aEditor.getByRole('button',{name:'إعادة المحاولة نفسها',exact:true}).isEnabled()).toBe(true);
    // Still-stale B must adopt A's intent, not create one with B's stale revision.
    const staleSave=bEditor.getByRole('button',{name:'حفظ نتيجة المتابعة',exact:true});
    if(await staleSave.count())await staleSave.click();
    await expect.poll(()=>bEditor.getByRole('button',{name:'إعادة المحاولة نفسها',exact:true}).isEnabled()).toBe(true);
    const refresh=bEditor.getByRole('button',{name:/تحديث السياق/});
    if(await refresh.count())await refresh.click();
    expect(await b.evaluate(k=>localStorage.getItem(k),key)).toBe(original);
    if(mode==='two tabs') {
      // Cookie replacement can precede this tab's SessionProvider update.
      const [adminName,...adminValue]=h.sessions.admin.cookie.split('=');
      await context.addCookies([{name:adminName,value:adminValue.join('='),url:baseUrl}]);
      await bEditor.getByRole('button',{name:'إعادة المحاولة نفسها',exact:true}).click();
      await expect.poll(()=>bEditor.getByText(/تغيّرت الجلسة/).count()).toBe(1);
      expect(await b.evaluate(k=>localStorage.getItem(k),key)).toBe(original);
      const adminEditor=await openHistory(b,source.id);
      expect(await adminEditor.getByRole('button',{name:'إعادة المحاولة نفسها',exact:true}).count()).toBe(0);
      await context.addCookies([{name,value:value.join('='),url:baseUrl}]);
    }
    const reloaded=await openHistory(b,source.id);
    await reloaded.getByRole('button',{name:'إعادة المحاولة نفسها',exact:true}).click();
    await expect.poll(()=>b.evaluate(k=>localStorage.getItem(k),key)).toBeNull();
    expect((await db.query('SELECT revision,outcome FROM appointment_followups WHERE source_appointment_id=$1',[source.id])).rows[0]).toEqual({revision:2,outcome:'no_answer'});
    expect(Number((await db.query('SELECT count(*) FROM appointment_followup_events e JOIN appointment_followups f ON f.id=e.followup_id WHERE f.source_appointment_id=$1',[source.id])).rows[0].count)).toBe(2);
  } finally {release();await context.close();}
});
