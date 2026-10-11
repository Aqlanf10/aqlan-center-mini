/** Owner audit: real HTTP and unmodified production bundle, disposable owned HR DB. */
import {beforeAll,afterAll,it,expect} from 'vitest';
import {chromium,type Browser} from 'playwright';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {harness} from './_server';
import {openHrJourneyServer} from './_hr-isolated-server';
let h:Awaited<ReturnType<typeof harness>>,owned:Awaited<ReturnType<typeof openHrJourneyServer>>,browser:Browser;
const evidence:Record<string,unknown>={};let staffId:number;
// Match the existing HR journeys: an explicit artifact directory or this checkout's local default.
const EVIDENCE_DIR=process.env.HR_EVIDENCE_DIR ?? join(process.cwd(),'.hr-evidence');
async function api(role:keyof typeof h.sessions,method:string,path:string,body?:unknown){
 const response=await fetch(owned.baseUrl+path,{method,headers:{cookie:h.sessions[role].cookie,origin:owned.baseUrl,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
beforeAll(async()=>{
 mkdirSync(EVIDENCE_DIR,{recursive:true});
 h=await harness();owned=await openHrJourneyServer(h);browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 const made=await api('admin','POST','/api/hr/staff',{fullName:'استقبال الفترتين — اصطناعي',jobTitle:'سكرتارية',department:'secretariat',workStatus:'active',hireDate:'2026-01-01',endDate:null,phone:null,note:null,contractKind:'salary',salaryAmountMinor:100000,salaryCurrency:'YER',salaryPeriod:'monthly',salaryEffectiveOn:'2026-01-01'});
 expect(made.status,JSON.stringify(made.body)).toBe(201);staffId=made.body.id;
 const schedule=await api('admin','POST','/api/hr/schedules',{staffId,name:'صباح ومساء — اصطناعي',scheduleType:'split',effectiveFrom:'2026-01-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'12:00',secondShiftStart:'16:00',secondShiftEnd:'20:00'});expect(schedule.status).toBe(201);
 for(const [punchType,time] of [['check_in','08:00'],['check_out','12:00'],['check_in','16:00'],['check_out','20:00']]){
  const punch=await api('admin','POST','/api/hr/attendance',{staffId,punchType,punchTime:`2026-08-01T${time}:00+03:00`});expect(punch.status).toBe(201);evidence.splitLastResponse=punch;
 }
},240000);
afterAll(async()=>{
 try{writeFileSync(join(EVIDENCE_DIR,'acceptance-http.json'),JSON.stringify(evidence,null,2));}
 finally{try{await browser?.close();}finally{await owned?.close();}}
});
for(const width of [390,1280])it(`native split attendance and schedule editor at ${width}`,async()=>{
 const context=await browser.newContext({viewport:{width,height:900},locale:'ar-YE'});
 const [name,...value]=h.sessions.admin.cookie.split('=');await context.addCookies([{name,value:value.join('='),url:owned.baseUrl}]);
 const page=await context.newPage();
 try{
  await page.goto(owned.baseUrl+'/hr');await page.getByRole('tab',{name:'الدوام والحضور'}).click();
  await page.locator('input[type=date]').first().fill('2026-08-01');
  await page.waitForFunction(()=>document.querySelector('tbody')?.textContent?.includes('استقبال الفترتين'));
  evidence[`attendanceText${width}`]=await page.locator('tbody').innerText();
  await page.screenshot({path:join(EVIDENCE_DIR,`fixed-split-record-${width}.png`),fullPage:false});
  await page.locator('select').filter({has:page.locator(`option[value="${staffId}"]`)}).first().selectOption(String(staffId));
  await page.getByRole('button',{name:'جداول الدوام والورديات'}).click();
  await page.getByRole('button',{name:/إنشاء جدول وردية/}).click();
  const modal=page.getByRole('dialog');await modal.locator('select').selectOption('split');
  expect(await modal.locator('input[type=time]').count()).toBe(4);expect(await modal.getByRole('checkbox').count()).toBe(7);
  evidence[`splitEditor${width}`]={timeInputs:await modal.locator('input[type=time]').count(),text:await modal.innerText(),documentOverflow:await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)};
  await page.screenshot({path:join(EVIDENCE_DIR,`fixed-split-editor-${width}.png`),fullPage:false});
 }finally{await context.close();}
});
it('HTTP rejects invalid policies, applies a saved grace default, and requires a structured leave document reference',async()=>{
 expect((await api('reception','PATCH','/api/hr/settings',{attendancePolicy:{lateGraceMins:90}})).status).toBe(403);
 expect((await api('admin','PATCH','/api/hr/settings',{attendancePolicy:{lateGraceMins:-1}})).status).toBe(400);
 expect((await api('admin','PATCH','/api/hr/settings',{attendancePolicy:{lateGraceMins:90}})).status).toBe(200);
 const schedule=await api('admin','POST','/api/hr/schedules',{staffId,name:'HTTP policy default',scheduleType:'morning',effectiveFrom:'2026-09-01',workingDays:[0,1,2,3,4,5,6],shiftStartTime:'08:00',shiftEndTime:'16:00'});
 expect(schedule.status).toBe(201);expect(schedule.body.gracePeriodMins).toBe(90);
 expect((await api('admin','POST','/api/hr/leaves/balances',{staffId:String(staffId),leaveTypeId:'sick',year:2026,allocatedDays:3,reason:'Synthetic allocation'})).status).toBe(201);
 const input={staffId,leaveTypeCode:'sick',startDate:'2026-08-12',endDate:'2026-08-12',reason:'Synthetic documented leave'};
 const missing=await api('admin','POST','/api/hr/leaves',input);expect(missing.status).toBe(201);
 const refused=await api('admin','PATCH',`/api/hr/leaves/${missing.body.id}`,{status:'approved',decisionNotes:'Review'});expect(refused.status).toBe(400);expect(refused.body.message).toMatch(/مرفق/);
 expect((await api('admin','PATCH',`/api/hr/leaves/${missing.body.id}`,{status:'cancelled',decisionNotes:'Replace submission'})).status).toBe(200);
 const documented=await api('admin','POST','/api/hr/leaves',{...input,attachmentRefs:[{id:'synthetic-paper-12',name:'مستند اصطناعي مقدم للمراجع'}]});expect(documented.status).toBe(201);
 expect((await api('admin','PATCH',`/api/hr/leaves/${documented.body.id}`,{status:'approved',decisionNotes:'Reviewed reference'})).status).toBe(200);
 // Older writers admitted malformed JSON entries: the new reference display must remain readable.
 await owned.db.query("UPDATE hr_leave_requests SET attachment_refs='[null]'::jsonb WHERE id=$1",[documented.body.id]);
 const context=await browser.newContext({viewport:{width:390,height:900},locale:'ar-YE'});const [name,...value]=h.sessions.admin.cookie.split('=');await context.addCookies([{name,value:value.join('='),url:owned.baseUrl}]);
 try{
  const page=await context.newPage();await page.goto(owned.baseUrl+'/hr');await page.getByRole('tab',{name:'الإجازات'}).click();await page.getByText('مرجع قديم يحتاج مراجعة',{exact:false}).waitFor();await page.getByRole('button',{name:'تقديم طلب إجازة'}).click();
  const modal=page.getByRole('dialog');await modal.locator('select').nth(1).selectOption('sick');expect(await modal.getByLabel('مرجع المستند المقدم للمراجع',{exact:false}).getAttribute('required')).not.toBeNull();
  expect(await modal.innerText()).toContain('لا يرفع ملفًا');await page.screenshot({path:join(EVIDENCE_DIR,'leave-document-reference-390.png'),fullPage:false});
 }finally{await context.close();}
});
for(const deviceZone of ['Asia/Aden','America/Los_Angeles'])it(`clinic deadline remains 14:00 through create and edit on ${deviceZone} device`,async()=>{
 const context=await browser.newContext({viewport:{width:1280,height:900},locale:'ar-YE',timezoneId:deviceZone});const [name,...value]=h.sessions.admin.cookie.split('=');await context.addCookies([{name,value:value.join('='),url:owned.baseUrl}]);
 try{
  const page=await context.newPage();await page.goto(owned.baseUrl+'/hr');await page.getByRole('button',{name:'مهمة جديدة',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'مهمة جديدة',exact:true});await modal.getByLabel('العنوان',{exact:true}).fill(`موعد الساعة الثانية ظهرًا — ${deviceZone}`);await modal.getByLabel('موعد الاستحقاق',{exact:true}).fill('2026-10-12T14:00');
  const reply=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/tasks');await modal.getByRole('button',{name:'إنشاء',exact:true}).click();
  const response=await reply;expect(response.status()).toBe(201);const task=await response.json();const stored=(await owned.db.query('SELECT due_at FROM hr_tasks WHERE id=$1',[task.id])).rows[0].due_at.toISOString();
  evidence.deadlineTimezone={input:'2026-10-12T14:00',browserTimezone:deviceZone,expectedUtc:'2026-10-12T11:00:00.000Z',storedUtc:stored,request:response.request().postDataJSON()};
  expect(stored).toBe('2026-10-12T11:00:00.000Z');await modal.waitFor({state:'hidden'});await page.getByRole('button',{name:new RegExp(deviceZone)}).first().waitFor();await page.getByRole('button',{name:new RegExp(deviceZone)}).first().click();await page.getByRole('button',{name:/تعديل/}).last().click();expect(await page.locator('input[type=\"datetime-local\"]').inputValue()).toBe('2026-10-12T14:00');await page.screenshot({path:join(EVIDENCE_DIR,'fixed-task-timezone-'+deviceZone.replaceAll('/','-')+'-1280.png'),fullPage:false});const saved=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname===`/api/tasks/${task.id}`);await page.getByRole('button',{name:'حفظ التعديل',exact:true}).click();expect((await saved).status()).toBe(200);expect((await owned.db.query('SELECT due_at FROM hr_tasks WHERE id=$1',[task.id])).rows[0].due_at.toISOString()).toBe('2026-10-12T11:00:00.000Z');
 }finally{await context.close();}
});

it('refuses an old UTC writer receipt under new clinic-local semantics without duplicating the task',async()=>{
 const input={title:'Historical UTC writer receipt — synthetic',description:'',isPrivate:true,priority:'normal',plannedFor:null,assigneeStaffId:null,clientRequestId:'legacy-utc-deadline-upgrade-2026'};
 // The old UTC route normalized local 14:00 to this instant. Seed that exact
 // normalized intent through the unchanged receipt/fingerprint writer, not a fabricated digest.
 const oldIntent={...input,dueAt:'2026-10-12T14:00:00.000Z'};
 const original=await api('admin','POST','/api/tasks',oldIntent);expect(original.status).toBe(201);
 const before=(await owned.db.query("SELECT old_value FROM hr_task_events WHERE task_id=$1 AND action='create'",[original.body.id])).rows;
 const replay=await api('admin','POST','/api/tasks',{...input,dueAt:'2026-10-12T14:00'});
 expect(replay.status).toBe(409);
 const rows=(await owned.db.query('SELECT id,due_at FROM hr_tasks WHERE client_request_id=$1',[input.clientRequestId])).rows;
 expect(rows).toHaveLength(1);expect(rows[0].id).toBe(original.body.id);expect(rows[0].due_at.toISOString()).toBe('2026-10-12T14:00:00.000Z');
 expect((await owned.db.query("SELECT old_value FROM hr_task_events WHERE task_id=$1 AND action='create'",[original.body.id])).rows).toEqual(before);
 const unchangedReplay=await api('admin','POST','/api/tasks',oldIntent);expect(unchangedReplay.status).toBe(201);expect(unchangedReplay.body.id).toBe(original.body.id);
 const newIntent={...input,title:'Current writer replay — synthetic',clientRequestId:'current-clinic-deadline-replay-2026',dueAt:'2026-10-12T14:00'};
 const current=await api('admin','POST','/api/tasks',newIntent);expect(current.status).toBe(201);
 const repeated=await api('admin','POST','/api/tasks',newIntent);expect(repeated.status).toBe(201);expect(repeated.body.id).toBe(current.body.id);
 expect((await owned.db.query('SELECT id,due_at FROM hr_tasks WHERE client_request_id=$1',[newIntent.clientRequestId])).rows).toMatchObject([{id:current.body.id,due_at:new Date('2026-10-12T11:00:00.000Z')}]);
 evidence.deadlineUpgrade={oldNormalizedUtc:rows[0].due_at.toISOString(),newLocalReplayStatus:replay.status,oldTaskCount:rows.length,sameWriterReplayId:repeated.body.id};
});
