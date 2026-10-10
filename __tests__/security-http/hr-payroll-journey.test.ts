import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {chromium,type APIResponse,type Browser,type BrowserContext,type Page} from "playwright";
import {Pool} from "pg";
import {mkdirSync} from "node:fs";
import {join} from "node:path";
import {harness,type Harness} from "./_server";
import {openHrJourneyServer} from "./_hr-isolated-server";
let h:Harness,db:Pool,browser:Browser,context:BrowserContext;
let isolated:Awaited<ReturnType<typeof openHrJourneyServer>>,baseUrl:string;
const periodMonth="2026-08";
const evidence=process.env.HR_EVIDENCE_DIR ?? "/tmp/hr-evidence";
let run:any,items:any[];
async function api(method:string,path:string,body?:unknown,cookie=h.sessions.admin.cookie){
 const res=await fetch(`${baseUrl}${path}`,{method,headers:{cookie,origin:baseUrl,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:res.status,body:await res.json()};
}
async function ready(page:Page){
 await page.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});
 await page.getByRole("tab",{name:"المسير والصرف"}).click();
 await page.locator('section[aria-label="إدارة المسير والصرف"] select').first().selectOption(String(run.periodId));
 await expect.poll(async()=>await page.locator("tbody").textContent()).toContain("HR-JOURNEY-HYBRID");
}
beforeAll(async()=>{
 h=await harness();isolated=await openHrJourneyServer(h);db=isolated.db;baseUrl=isolated.baseUrl;
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
 context=await browser.newContext({viewport:{width:1280,height:900}});
 const pair=h.sessions.admin.cookie.split(";")[0];const split=pair.indexOf("=");await context.addCookies([{name:pair.slice(0,split),value:pair.slice(split+1),url:baseUrl}]);
 mkdirSync(evidence,{recursive:true});
 const shift=(await db.query("SELECT id FROM cashier_shifts WHERE status='open' LIMIT 1")).rows[0] ?? (await db.query("INSERT INTO cashier_shifts(opened_by) VALUES ('secadmin') RETURNING id")).rows[0];
 for(const [name,kind,salary] of [["SALARY","salary",80000],["PERCENT","commission",0],["HYBRID","salary_commission",100000]] as const){
   const staff=await api("POST","/api/hr/staff",{fullName:`HR-JOURNEY-${name}`,department:kind==="salary"?"secretariat":"doctors",jobTitle:"اختبار رحلة",hireDate:"2026-01-01",endDate:null,phone:null,note:null,workStatus:"active",contractKind:kind,...(salary?{salaryAmountMinor:salary,salaryCurrency:"YER",salaryPeriod:"monthly",salaryEffectiveOn:"2026-01-01"}:{})});expect(staff.status,JSON.stringify(staff.body)).toBe(201);
   const staffId=staff.body.staff?.id ?? staff.body.id;
   let partyId:number|undefined;
   if(kind!=="salary"){
     partyId=(await db.query("INSERT INTO parties(name,kind,commission_percent) VALUES ($1,'doctor',30) RETURNING id",[`HR-JOURNEY-${name}`])).rows[0].id;
     const patient=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES ($1,$1) RETURNING id",[`HR-J-${name}`])).rows[0];
     const invoice=(await db.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by,created_at) VALUES ($1,$2,40000,'YER','secadmin','2026-08-02 10:00+03') RETURNING id",[`HR-J-I-${name}`,patient.id])).rows[0];
     await db.query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,doctor_id) VALUES ($1,'اختبار',1,40000,40000,$2)",[invoice.id,partyId]);
     await db.query("INSERT INTO visits(patient_name,patient_id,doctor_id,status,invoice_id,arrived_at,signed_at,signed_by) VALUES ('اختبار',$1,$2,'done',$3,'2026-08-02 10:00+03','2026-08-02 10:00+03','secadmin')",[patient.id,partyId,invoice.id]);
     await db.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,created_at) VALUES ($1,$2,$3,$4,'payment',40000,'YER',1,40000,'YER','cash','secadmin','2026-08-02 10:00+03')",[`HR-J-R-${name}`,patient.id,invoice.id,shift.id]);
   }
   const contract=await api("POST","/api/hr/contracts",{staffId,title:`HR-JOURNEY-${name}`,templateKind:kind==="salary"?"support_staff":kind==="commission"?"doctor_percentage":"doctor_hybrid",startDate:"2026-01-01",endDate:null,compensationKind:kind,baseSalaryMinor:salary || null,salaryCurrency:salary?"YER":null,salaryPeriod:salary?"monthly":null,doctorPartyId:partyId,commissionRatePercent:partyId?30:null});expect(contract.status).toBe(201);
   expect((await api("PATCH",`/api/hr/contracts/${contract.body.id}`,{action:"transition",status:"active",reason:"اعتماد رحلة معزولة"})).status).toBe(200);
 }
 const period=await api("POST","/api/hr/payroll/periods",{periodMonth});expect(period.status).toBe(201);
 const calculated=await api("POST","/api/hr/payroll/runs",{action:"calculate",periodId:period.body.id,currency:"YER"});expect(calculated.status).toBe(201);run=calculated.body;
 const approved=await api("POST","/api/hr/payroll/runs",{action:"approve",runId:run.id});expect(approved.status,JSON.stringify(approved.body)).toBe(200);
 items=(await api("GET",`/api/hr/payroll/runs?id=${run.id}`)).body.items;
},240_000);
afterAll(async()=>{await context?.close();await browser?.close();await isolated?.close();});
describe("HR contract to payroll to cash: actual API and browser",()=>{
 it("salary, percentage and hybrid show their real components, on desktop and mobile",async()=>{
   expect(items.find(i=>i.staffName==="HR-JOURNEY-SALARY")).toMatchObject({baseSalaryMinor:80000,commissionsMinor:0});
   expect(items.find(i=>i.staffName==="HR-JOURNEY-PERCENT")).toMatchObject({baseSalaryMinor:0,commissionsMinor:12000});
   expect(items.find(i=>i.staffName==="HR-JOURNEY-HYBRID")).toMatchObject({baseSalaryMinor:100000,commissionsMinor:12000});
   const page=await context.newPage();try{
    await ready(page);expect(await page.locator("tbody").textContent()).toContain("112,000");
    await page.screenshot({path:join(evidence,"hr-payroll-1280.png"),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.screenshot({path:join(evidence,"hr-payroll-390.png"),fullPage:true});
    await page.goto(`${baseUrl}/print/hr/payroll/${run.id}`);for(const item of items)expect(await page.textContent("body")).toContain(item.staffName);
    await page.pdf({path:join(evidence,"hr-payroll-all-rows.pdf"),format:"A4",printBackground:true});
   }finally{await page.close();}
 });
 it("lost response, reload, double click and stale second tab reuse one partial payout",async()=>{
   const item=items.find(i=>i.staffName==="HR-JOURNEY-SALARY");const page=await context.newPage(),second=await context.newPage();
   try{
    await ready(page);await ready(second);
    const row=(p:Page)=>p.locator("tbody tr").filter({hasText:"HR-JOURNEY-SALARY"});
    await row(page).getByRole("button",{name:"صرف",exact:true}).click();
    await page.locator('input[type="number"]').fill("30000");
    let sent:any;
    let committed!: (response:APIResponse)=>void,failed!: (error:unknown)=>void;
    const committedRequest=new Promise<APIResponse>((resolve,reject)=>{committed=resolve;failed=reject;});
    await page.route("**/api/hr/payroll/disburse",async route=>{
      try{
        sent=route.request().postDataJSON();
        const response=await route.fetch();
        await route.abort("connectionfailed");committed(response);
      }catch(error){failed(error);}
    },{times:1});
    await page.getByRole("button",{name:"تأكيد الصرف وتسجيل المصروف"}).click();
    // The server must actually finish its transaction before we inspect its durable result.
    // A short polling deadline previously failed while the intercepted request was still running.
    const response=await committedRequest;expect(response.status()).toBe(201);
    expect((await response.json()).disbursement).toMatchObject({itemId:item.id,amountMinor:30000});
    expect(Number((await db.query("SELECT paid_minor FROM hr_payroll_items WHERE id=$1",[item.id])).rows[0].paid_minor)).toBe(30000);
    await page.reload();await page.getByRole("tab",{name:"المسير والصرف"}).click();
    await page.locator('section[aria-label="إدارة المسير والصرف"] select').first().selectOption(String(run.periodId));
    await row(page).getByRole("button",{name:"صرف",exact:true}).click();
    expect(await page.locator('input[type="number"]').inputValue()).toBe("30000");
    const replay=page.waitForResponse(r=>r.url().endsWith("/api/hr/payroll/disburse")&&r.request().method()==="POST");
    await page.getByRole("button",{name:"تأكيد الصرف وتسجيل المصروف"}).dblclick();expect((await replay).status()).toBe(200);
    await row(second).getByRole("button",{name:"صرف",exact:true}).click();
    const replay2=second.waitForResponse(r=>r.url().endsWith("/api/hr/payroll/disburse")&&r.request().method()==="POST");
    await second.getByRole("button",{name:"تأكيد الصرف وتسجيل المصروف"}).click();expect((await replay2).status()).toBe(200);
    const actual=(await db.query("SELECT count(*)::int AS n,sum(amount_minor)::text AS paid FROM hr_payroll_disbursements WHERE item_id=$1",[item.id])).rows[0];expect(actual).toEqual({n:1,paid:"30000"});
    expect((await api("GET",`/api/hr/payroll/disburse?clientRequestId=${sent.clientRequestId}`)).body.disbursement.amountMinor).toBe(30000);
    expect((await api("POST","/api/hr/payroll/disburse",{...sent,amountMinor:30001,components:{salaryMinor:30001,commissionMinor:0}})).status).toBe(409);
    const report=await api("GET","/api/hr/reports");expect(report.status).toBe(200);expect(report.body.payrollSummaryByCurrency.find((row:any)=>row.currency==="YER")).toMatchObject({totalNetDue:204000,totalDisbursed:30000,totalRemainingPayable:174000});
   }finally{await page.close();await second.close();}
 },180_000);
 it("hybrid partial allocation produces salary and commission vouchers, reversal restores both",async()=>{
   const item=items.find(i=>i.staffName==="HR-JOURNEY-HYBRID");
   const payload={itemId:item.id,amountMinor:35000,components:{salaryMinor:30000,commissionMinor:5000},clientRequestId:"http-hybrid-partial-0001"};
   const paid=await api("POST","/api/hr/payroll/disburse",payload);expect(paid.status).toBe(201);expect(paid.body.disbursement.parts).toHaveLength(2);
   const parts=(await db.query("SELECT e.category,e.amount_minor,e.payable_id FROM expenses e JOIN hr_payroll_disbursement_parts p ON p.expense_id=e.id WHERE p.disbursement_id=$1 ORDER BY e.category",[paid.body.disbursement.id])).rows;
   expect(parts.map(p=>[p.category,Number(p.amount_minor)])).toEqual([["commission",5000],["salary",30000]]);
   const reversed=await api("POST","/api/hr/payroll/disburse",{action:"reverse",disbursementId:paid.body.disbursement.id,reason:"اختبار عكس جزأي الصرف"});expect(reversed.status).toBe(200);
   expect(Number((await db.query("SELECT paid_minor FROM hr_payroll_items WHERE id=$1",[item.id])).rows[0].paid_minor)).toBe(0);
   expect((await api("POST","/api/hr/payroll/disburse",{itemId:item.id,amountMinor:1})).status).toBe(400);
   for(const session of [h.sessions.reception,h.sessions.doctorA,h.sessions.accountant]){
    expect((await api("POST","/api/hr/payroll/disburse",payload,session.cookie)).status).toBe(403);
    expect((await api("GET",`/api/hr/payroll/runs?id=${run.id}`,undefined,session.cookie)).status).toBe(403);
    expect((await api("GET","/api/hr/reports",undefined,session.cookie)).status).toBe(403);
   }
   expect((await api("POST","/api/hr/payroll/disburse",{...payload,itemId:999999,clientRequestId:"invalid-item-http-0001"})).status).toBe(404);
 });
});

it("actual attendance and leave APIs preserve raw events, pending decisions and private reasons",async()=>{
 const staffId=items.find(i=>i.staffName==="HR-JOURNEY-SALARY").staffId;
 const schedule=await api("POST","/api/hr/schedules",{staffId,name:"HTTP night",scheduleType:"night",effectiveFrom:"2026-01-01",workingDays:[0,1,2,3,4,5,6],shiftStartTime:"22:00",shiftEndTime:"06:00",crossesMidnight:true});expect(schedule.status).toBe(201);
 expect((await api("POST","/api/hr/attendance",{staffId,punchType:"check_in",punchTime:"2026-08-01T22:00:00+03:00"})).status).toBe(201);
 const out=await api("POST","/api/hr/attendance",{staffId,punchType:"check_out",punchTime:"2026-08-02T06:00:00+03:00"});expect(out.status).toBe(201);expect(out.body).toMatchObject({attendanceDate:"2026-08-01",workMinutes:480,isIncomplete:false});
 const correction=await api("POST","/api/hr/attendance/corrections",{attendanceRecordId:out.body.id,fieldCorrected:"check_in",newCheckIn:"2026-08-01T23:00:00+03:00",reason:"HTTP pending fixture"});expect(correction.status).toBe(201);expect(correction.body).toMatchObject({status:"pending",approvedBy:null});
 expect((await api("POST","/api/hr/attendance/corrections",{action:"decide",id:correction.body.id,decision:"approved"})).status).toBe(400);
 expect((await api("GET",`/api/hr/attendance?staffId=${staffId}`)).body[0].checkInActual).toBe(out.body.checkInActual);
 expect((await db.query("SELECT count(*)::int AS n FROM hr_attendance_punch_events WHERE attendance_id=$1",[out.body.id])).rows[0].n).toBe(2);
 const request=await api("POST","/api/hr/leaves",{staffId,leaveTypeCode:"annual",startDate:"2026-08-10",endDate:"2026-08-10",reason:"Private HTTP reason"});expect(request.status).toBe(201);expect(request.body.daysCount).toBe(1);
 expect((await api("PATCH",`/api/hr/leaves/${request.body.id}`,{status:"approved"})).status).toBe(400);
 expect((await api("GET",`/api/hr/leaves/${request.body.id}`,undefined,h.sessions.doctorA.cookie)).status).toBe(404);
 expect((await api("GET",`/api/hr/leaves?staffId=${staffId}`,undefined,h.sessions.doctorA.cookie)).body).toEqual([]);
 expect((await api("GET",`/api/hr/leaves/balances?staffId=${staffId}`,undefined,h.sessions.doctorA.cookie)).body).toEqual([]);
 expect((await api("POST","/api/hr/leaves",{staffId,leaveTypeCode:"annual",startDate:"2026-08-11",endDate:"2026-08-11",reason:"tampered staff"},h.sessions.doctorA.cookie)).status).toBe(400);
 const page=await context.newPage();try{
  await page.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});await page.getByRole("tab",{name:"الدوام والحضور"}).click();
  await page.locator('section[aria-label="الدوام والحضور"] input[type="date"]').fill("2026-08-01");
  await expect.poll(async()=>await page.locator('section[aria-label="الدوام والحضور"] tbody').textContent()).toContain("HR-JOURNEY-SALARY");
  const row=page.locator('section[aria-label="الدوام والحضور"] tbody tr').filter({hasText:"HR-JOURNEY-SALARY"});expect(await row.textContent()).toContain("22:00");expect(await row.textContent()).toContain("06:00");expect(await row.textContent()).toContain("8.0");
  await page.screenshot({path:join(evidence,"hr-workforce-1280.png"),fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:join(evidence,"hr-workforce-390.png"),fullPage:true});
 }finally{await page.close();}
});
it("a doctor sees personal tasks and leave without an unusable team attendance tab",async()=>{
 const doctor=await browser.newContext({viewport:{width:390,height:844}});
 const pair=h.sessions.doctorA.cookie.split(";")[0],split=pair.indexOf("=");await doctor.addCookies([{name:pair.slice(0,split),value:pair.slice(split+1),url:baseUrl}]);
 const page=await doctor.newPage();try{
  await page.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});
  expect(await page.getByRole("tab",{name:"المهام",exact:false}).count()).toBe(1);
  expect(await page.getByRole("tab",{name:"الدوام والحضور",exact:false}).count()).toBe(0);
  expect(await page.getByRole("tab",{name:"المسير والصرف",exact:false}).count()).toBe(0);
 }finally{await doctor.close();}
});


for(const width of [390,1280]){
 it(`explicit next-day correction and second-admin approval preserve evidence at ${width}px`,async()=>{
  const name=`NIGHT-CORRECTION-${width}`;
  const staff=await api("POST","/api/hr/staff",{fullName:name,department:"secretariat",jobTitle:"Synthetic night shift",hireDate:"2026-01-01",endDate:null,phone:null,note:null,workStatus:"active",contractKind:"salary",salaryAmountMinor:1000,salaryCurrency:"YER",salaryPeriod:"monthly",salaryEffectiveOn:"2026-01-01"});expect(staff.status).toBe(201);
  const staffId=staff.body.staff?.id ?? staff.body.id;
  expect((await api("POST","/api/hr/schedules",{staffId,name,scheduleType:"night",effectiveFrom:"2026-01-01",workingDays:[0,1,2,3,4,5,6],shiftStartTime:"22:00",shiftEndTime:"06:00",crossesMidnight:true})).status).toBe(201);
  expect((await api("POST","/api/hr/attendance",{staffId,punchType:"check_in",punchTime:"2026-08-01T22:00:00+03:00"},h.sessions.reception.cookie)).status).toBe(201);
  const out=await api("POST","/api/hr/attendance",{staffId,punchType:"check_out",punchTime:"2026-08-02T06:00:00+03:00"},h.sessions.reception.cookie);expect(out.status).toBe(201);
  const page=await context.newPage();await page.setViewportSize({width,height:900});
  let reviewerContext:BrowserContext|undefined;
  try{
   await page.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});await page.getByRole("tab",{name:"الدوام والحضور"}).click();
   await page.locator('section[aria-label="الدوام والحضور"] input[type="date"]').fill("2026-08-01");
   const row=page.locator('section[aria-label="الدوام والحضور"] tbody tr').filter({hasText:name});await row.getByRole("button",{name:"تصحيح",exact:false}).click();
   expect(await page.getByLabel("تاريخ الدخول الصحيح",{exact:true}).count()).toBe(1);
   expect(await page.getByLabel("تاريخ الخروج الصحيح",{exact:true}).count()).toBe(1);
   expect(await page.getByLabel("تاريخ الخروج الصحيح",{exact:true}).inputValue()).toBe("2026-08-02");
   await page.getByLabel("تاريخ الدخول الصحيح",{exact:true}).fill("2026-08-01");
   await page.getByLabel("وقت الدخول الصحيح",{exact:true}).fill("22:00");
   await page.getByLabel("تاريخ الخروج الصحيح",{exact:true}).fill("2026-08-02");
   await page.getByLabel("وقت الخروج الصحيح",{exact:true}).fill("06:15");
   await page.locator("textarea").fill(`Explicit next-day synthetic ${width}`);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
   await page.screenshot({path:join(evidence,`hr-nextday-form-${width}.png`),fullPage:true});
   const submitted=page.waitForResponse(r=>r.url().endsWith("/api/hr/attendance/corrections")&&r.request().method()==="POST");
   console.info(`night ${width}: submitting form`);
   await page.getByRole("button",{name:"رفع طلب التصحيح",exact:true}).click();
   console.info(`night ${width}: form clicked`);
   const response=await submitted;expect(response.status()).toBe(201);
   console.info(`night ${width}: response received`);
   const correction=await response.json();
   console.info(`night ${width}: submitted correction`);
   expect(correction.newCheckOut).toBe("2026-08-02T03:15:00.000Z");
   page.on("dialog",dialog=>dialog.type()==="prompt"?dialog.accept("Synthetic self-approval attempt"):dialog.dismiss());
   await page.getByRole("button",{name:"طلبات التصحيح",exact:false}).click();
   const ownCard=page.locator("div.flex.flex-wrap.items-center.justify-between").filter({hasText:`Explicit next-day synthetic ${width}`});
   const selfDecision=page.waitForResponse(r=>r.url().endsWith("/api/hr/attendance/corrections")&&r.request().method()==="POST");
   console.info(`night ${width}: checking self approval`);
   await ownCard.getByRole("button",{name:"اعتماد التصحيح"}).click();expect((await selfDecision).status()).toBe(400);
   console.info(`night ${width}: self approval denied`);
   expect(await ownCard.textContent()).toContain("قيد المراجعة");
   await page.screenshot({path:join(evidence,`hr-nextday-self-denied-${width}.png`),fullPage:true});
   expect((await api("POST","/api/hr/attendance/corrections",{action:"decide",id:correction.id,decision:"approved",requestedBy:"other-admin",staffId:999})).status).toBe(400);
   for(const cookie of [h.sessions.reception.cookie,h.sessions.doctorA.cookie]){
    expect((await api("POST","/api/hr/attendance/corrections",{action:"decide",id:correction.id,decision:"approved"},cookie)).status).toBe(403);
    expect((await api("POST","/api/hr/attendance/corrections",{attendanceRecordId:out.body.id,staffId,requestedBy:"secadmin",fieldCorrected:"all",newCheckIn:"2026-08-01T22:00:00+03:00",reason:"Spoofed identity"},cookie)).status).toBe(403);
   }
   expect((await api("POST","/api/hr/attendance",{staffId,punchType:"check_in",punchTime:"2026-08-03T22:00:00+03:00"},h.sessions.doctorA.cookie)).status).toBe(403);
   console.info(`night ${width}: role and spoofing checks passed`);
   // An independent real admin logs in using the fixture's existing synthetic password hash.
   await db.query("INSERT INTO users(username,display_name,password_hash,role) SELECT $1,'Synthetic reviewer',password_hash,'admin' FROM users WHERE username='secadmin' ON CONFLICT(username) DO NOTHING",[`nightreviewer${width}`]);
   const login=await fetch(`${baseUrl}/api/auth/login`,{method:"POST",headers:{origin:baseUrl,"content-type":"application/json"},body:JSON.stringify({username:`nightreviewer${width}`,password:"SecAdmin#Pass1"})});expect(login.status).toBe(200);
   console.info(`night ${width}: reviewer logged in`);
   const pair=login.headers.getSetCookie().map(c=>c.split(";")[0]).find(c=>c.startsWith("aqlan_flow_session="))!;expect(pair).toBeTruthy();
   reviewerContext=await browser.newContext({viewport:{width,height:900}});const split=pair.indexOf("=");await reviewerContext.addCookies([{name:pair.slice(0,split),value:pair.slice(split+1),url:baseUrl}]);
   const reviewerPage=await reviewerContext.newPage();reviewerPage.on("dialog",dialog=>dialog.accept("Synthetic second-admin review"));
   await reviewerPage.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});await reviewerPage.getByRole("tab",{name:"الدوام والحضور"}).click();await reviewerPage.getByRole("button",{name:"طلبات التصحيح",exact:false}).click();
   const card=reviewerPage.locator("div.flex.flex-wrap.items-center.justify-between").filter({hasText:`Explicit next-day synthetic ${width}`});
   console.info(`night ${width}: reviewer correction card opened`);
   const approved=reviewerPage.waitForResponse(r=>r.url().endsWith("/api/hr/attendance/corrections")&&r.request().method()==="POST");await card.getByRole("button",{name:"اعتماد التصحيح"}).click();expect((await approved).status()).toBe(200);
   await expect.poll(async()=>await card.textContent()).toContain("معتمد");
   expect(await reviewerPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
   await reviewerPage.screenshot({path:join(evidence,`hr-nextday-approved-${width}.png`),fullPage:true});
   await reviewerPage.getByRole("button",{name:"سجل الحضور اليومي",exact:true}).click();
   await reviewerPage.locator('section[aria-label="الدوام والحضور"] input[type="date"]').fill("2026-08-01");
   const correctedRow=reviewerPage.locator('section[aria-label="الدوام والحضور"] tbody tr').filter({hasText:name});
   await expect.poll(async()=>await correctedRow.textContent()).toContain("06:15");
   expect(await correctedRow.textContent()).toContain("22:00");expect(await correctedRow.textContent()).toContain("8.3");
   await reviewerPage.screenshot({path:join(evidence,`hr-nextday-result-${width}.png`),fullPage:true});
   expect((await api("POST","/api/hr/attendance/corrections",{action:"decide",id:correction.id,decision:"approved"})).status).toBe(400);
   const stored=(await db.query("SELECT * FROM hr_attendance_records WHERE id=$1",[out.body.id])).rows[0];
   expect(new Date(stored.check_out_actual).toISOString()).toBe("2026-08-02T03:15:00.000Z");expect(new Date(stored.check_out_raw).toISOString()).toBe("2026-08-02T03:00:00.000Z");expect(stored.work_minutes).toBe(495);
   const repeat=await api("POST","/api/hr/attendance",{staffId,punchType:"check_out",punchTime:"2026-08-02T06:00:00+03:00"});expect(repeat.status).toBe(201);expect(repeat.body.id).toBe(out.body.id);expect(repeat.body.checkOutActual).toBe("2026-08-02T03:15:00.000Z");
   const next=await api("POST","/api/hr/attendance",{staffId,punchType:"check_in",punchTime:"2026-08-02T22:00:00+03:00"});expect(next.status).toBe(201);expect(next.body.checkOutRaw).toBeNull();
   for(const [role,session] of [["reception",h.sessions.reception],["doctor",h.sessions.doctorA]] as const){
    const roleContext=await browser.newContext({viewport:{width,height:900}});
    try{
     const cookie= session.cookie.split(";")[0],separator=cookie.indexOf("=");await roleContext.addCookies([{name:cookie.slice(0,separator),value:cookie.slice(separator+1),url:baseUrl}]);
     const rolePage=await roleContext.newPage();await rolePage.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});
     expect(await rolePage.getByRole("tab",{name:"الدوام والحضور",exact:true}).count()).toBe(role==="reception"?1:0);
     if(role==="reception"){
      await rolePage.getByRole("tab",{name:"الدوام والحضور"}).click();await rolePage.locator('section[aria-label="الدوام والحضور"] input[type="date"]').fill("2026-08-01");
      await expect.poll(async()=>await rolePage.locator('section[aria-label="الدوام والحضور"] tbody').textContent()).toContain(name);
      expect(await rolePage.getByRole("button",{name:"طلبات التصحيح",exact:false}).count()).toBe(0);
      expect(await rolePage.getByRole("button",{name:"طلب تصحيح",exact:true}).count()).toBe(0);
     }
     const spoof=await rolePage.evaluate(async targetStaffId=>{
      const response=await fetch("/api/hr/leaves",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({staffId:targetStaffId,leaveTypeCode:"annual",startDate:"2026-08-20",endDate:"2026-08-20",reason:"Synthetic browser employee spoof"})});
      return {status:response.status,body:await response.json()};
     },staffId);
     expect(spoof.status).toBe(400);
     expect(spoof.body).not.toHaveProperty("staffId");
     await rolePage.screenshot({path:join(evidence,`hr-nextday-${role}-${width}.png`),fullPage:true});
    }finally{await roleContext.close();}
   }
  }finally{await reviewerContext?.close();await page.close();}
 });
}
