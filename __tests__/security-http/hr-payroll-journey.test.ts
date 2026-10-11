import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {chromium,type APIResponse,type Browser,type BrowserContext,type Page} from "playwright";
import {Pool} from "pg";
import {mkdirSync} from "node:fs";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {harness,type Harness} from "./_server";
import {formatAmount,parseAmount,type Currency} from "@/lib/money";
import {openHrJourneyServer} from "./_hr-isolated-server";
let h:Harness,db:Pool,browser:Browser,context:BrowserContext;
let isolated:Awaited<ReturnType<typeof openHrJourneyServer>>,baseUrl:string;
const periodMonth="2026-08";
const evidence=process.env.HR_EVIDENCE_DIR ?? "/tmp/hr-evidence";
let run:any,items:any[];
async function confirmationFixture(month:string,label:string,width:number){
 const name=`HR-CONFIRM-${label}-${width}`;
 const staff=await api("POST","/api/hr/staff",{fullName:name,department:"secretariat",jobTitle:"اختبار تأكيد صرف",hireDate:"2026-01-01",endDate:null,phone:null,note:null,workStatus:"active",contractKind:"salary",salaryAmountMinor:10000,salaryCurrency:"YER",salaryPeriod:"monthly",salaryEffectiveOn:"2026-01-01"});
 expect(staff.status).toBe(201);const staffId=staff.body.staff?.id ?? staff.body.id;
 const contract=await api("POST","/api/hr/contracts",{staffId,title:name,templateKind:"support_staff",startDate:"2026-01-01",endDate:null,compensationKind:"salary",baseSalaryMinor:10000,salaryCurrency:"YER",salaryPeriod:"monthly"});expect(contract.status).toBe(201);
 expect((await api("PATCH",`/api/hr/contracts/${contract.body.id}`,{action:"transition",status:"approved",reason:"اعتماد اختبار تأكيد معزول"})).status).toBe(200);
 expect((await api("PATCH",`/api/hr/contracts/${contract.body.id}`,{action:"transition",status:"active",reason:"اعتماد اختبار تأكيد معزول"})).status).toBe(200);
 const period=await api("POST","/api/hr/payroll/periods",{periodMonth:month});expect(period.status).toBe(201);
 const calculated=await api("POST","/api/hr/payroll/runs",{action:"calculate",periodId:period.body.id,currency:"YER"});expect(calculated.status).toBe(201);
 expect((await api("POST","/api/hr/payroll/runs",{action:"approve",runId:calculated.body.id})).status).toBe(200);
 const item=(await api("GET",`/api/hr/payroll/runs?id=${calculated.body.id}`)).body.items.find((i:any)=>i.staffId===staffId);expect(item).toBeTruthy();
 const ownContext=await browser.newContext({viewport:{width,height:width===390?844:900}});
 const pair=h.sessions.admin.cookie.split(";")[0],split=pair.indexOf("=");await ownContext.addCookies([{name:pair.slice(0,split),value:pair.slice(split+1),url:baseUrl}]);
 const page=await ownContext.newPage();await page.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});await page.getByRole("tab",{name:"المسير والصرف"}).click();
 await page.locator('section[aria-label="إدارة المسير والصرف"] select').first().selectOption(String(period.body.id));
 const row=page.locator("tbody tr").filter({hasText:name});await expect.poll(()=>row.count()).toBe(1);
 return {item,page,row,periodId:period.body.id,close:()=>ownContext.close()};
}
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
   expect((await api("PATCH",`/api/hr/contracts/${contract.body.id}`,{action:"transition",status:"approved",reason:"اعتماد رحلة معزولة"})).status).toBe(200);
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
   expect((await db.query("SELECT requested_by,approved_by,status FROM hr_attendance_corrections WHERE id=$1",[correction.id])).rows[0]).toEqual({requested_by:"secadmin",approved_by:`nightreviewer${width}`,status:"approved"});
   expect(new Date(stored.check_in_raw).toISOString()).toBe("2026-08-01T19:00:00.000Z");
   expect(new Date(stored.check_out_actual).toISOString()).toBe("2026-08-02T03:15:00.000Z");expect(new Date(stored.check_out_raw).toISOString()).toBe("2026-08-02T03:00:00.000Z");expect(stored.work_minutes).toBe(495);
   const repeat=await api("POST","/api/hr/attendance",{staffId,punchType:"check_out",punchTime:"2026-08-02T06:00:00+03:00"});expect(repeat.status).toBe(201);expect(repeat.body.id).toBe(out.body.id);expect(repeat.body.checkOutActual).toBe("2026-08-02T03:15:00.000Z");
   const next=await api("POST","/api/hr/attendance",{staffId,punchType:"check_in",punchTime:"2026-08-02T22:00:00+03:00"});expect(next.status).toBe(201);expect(next.body.checkOutRaw).toBeNull();
   for(const [role,session] of [["reception",h.sessions.reception],["doctor",h.sessions.doctorA]] as const){
    const roleContext=await browser.newContext({viewport:{width,height:900}});
    try{
     const cookie= session.cookie.split(";")[0],separator=cookie.indexOf("=");await roleContext.addCookies([{name:cookie.slice(0,separator),value:cookie.slice(separator+1),url:baseUrl}]);
     const rolePage=await roleContext.newPage();await rolePage.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});
     const authenticated=await rolePage.evaluate(async()=>{
      const response=await fetch("/api/auth/me");return {status:response.status,body:await response.json()};
     });
     expect(authenticated.status).toBe(200);expect(authenticated.body.role).toBe(role);
     // Authenticate the real browser session, then match the label with its decorative icon.
     // The accessible name is "⏱️الدوام والحضور", not the bare exact text.
     await expect.poll(async()=>await rolePage.getByRole("tab",{name:"الدوام والحضور"}).count()).toBe(role==="reception"?1:0);
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

for(const change of ["role","credential"] as const){
 it(`queued real payout rejects a ${change} revoked after HTTP admission`,async()=>{
  const fixture=await confirmationFixture(change==="role"?"2026-09":"2026-01",`authority-${change}`,1280),{item}=fixture;
  const blocker=await db.connect();let pending:ReturnType<typeof api>|undefined;
  try{
   await blocker.query("BEGIN");
   const {rows:[identity]}=await blocker.query("SELECT pg_backend_pid() AS pid");
   await blocker.query("SELECT id FROM users WHERE username='secadmin' FOR UPDATE");
   await blocker.query("SELECT id FROM hr_payroll_items WHERE id=$1 FOR UPDATE",[item.id]);
   pending=api("POST","/api/hr/payroll/disburse",{itemId:item.id,amountMinor:1000,components:{salaryMinor:1000,commissionMinor:0},clientRequestId:`queued-authority-${change}-0001`});
   await expect.poll(async()=>(await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",[identity.pid])).rows[0].n).toBeGreaterThan(0);
   // Only the owned fixture's account changes. ROLLBACK/restore never touches a real environment.
   if(change==="role") await blocker.query("UPDATE users SET role='doctor' WHERE username='secadmin'");
   else await blocker.query("UPDATE users SET password_hash='synthetic-revoked-credential' WHERE username='secadmin'");
   await blocker.query("COMMIT");
   const result=await pending;expect(result.status).toBe(403);
   expect((await db.query("SELECT count(*)::int AS n FROM hr_payroll_disbursements WHERE item_id=$1",[item.id])).rows[0].n).toBe(0);
   expect((await db.query("SELECT count(*)::int AS n FROM expenses WHERE payable_id=$1",[item.payableId])).rows[0].n).toBe(0);
   expect((await db.query("SELECT paid_minor::text FROM hr_payroll_items WHERE id=$1",[item.id])).rows[0].paid_minor).toBe("0");
  }finally{
   await blocker.query("ROLLBACK");blocker.release();await pending?.catch(()=>undefined);
   const shared=new Pool({connectionString:h.seeded.dbUrl,ssl:false});
   try{const {rows:[original]}=await shared.query("SELECT role,password_hash FROM users WHERE username='secadmin'");await db.query("UPDATE users SET role=$1,password_hash=$2 WHERE username='secadmin'",[original.role,original.password_hash]);}finally{await shared.end();await fixture.close();}
  }
 });
}

for(const [index,[width,variant]] of ([[390,"missing"],[1280,"missing"],[390,"foreign"],[1280,"foreign"]] as const).entries()){
 it(`unverified payout ${variant} body retains the exact request after actual commit at ${width}px`,async()=>{
  const fixture=await confirmationFixture(`2026-0${7-index}`,variant,width),{page,item,row}=fixture;
  try{
   await row.getByRole("button",{name:"صرف",exact:true}).click();await page.locator('input[type="number"]').fill("1000");
   let submitted:any,committedBody:any;
   await page.route("**/api/hr/payroll/disburse",async route=>{
    submitted=route.request().postDataJSON();const response=await route.fetch();expect(response.status()).toBe(201);committedBody=await response.json();
    await route.fulfill({response,json:variant==="missing"?{success:true}:{...committedBody,disbursement:{...committedBody.disbursement,itemId:item.id+100000,clientRequestId:"different-operation-key"}}});
   },{times:1});
   await page.getByRole("button",{name:"تأكيد الصرف وتسجيل المصروف"}).click();
   await expect.poll(()=>page.locator('section[aria-label="إدارة المسير والصرف"]').innerText()).toContain("لم تتأكد نتيجة الصرف");
   expect(await page.getByRole("button",{name:"تأكيد الصرف وتسجيل المصروف"}).isVisible()).toBe(true);
   const saved=await page.evaluate(id=>JSON.parse(localStorage.getItem(`hr:payroll:pending:${id}`)!),item.id);
   expect(saved).toMatchObject({clientRequestId:submitted.clientRequestId,itemId:item.id,amountMinor:1000});expect(saved.completed).not.toBe(true);
   expect(committedBody.disbursement).toMatchObject({itemId:item.id,amountMinor:1000});
   expect((await db.query("SELECT count(*)::int AS n,sum(amount_minor)::text AS amount FROM hr_payroll_disbursements WHERE item_id=$1",[item.id])).rows[0]).toEqual({n:1,amount:"1000"});
   await page.screenshot({path:join(evidence,`hr-unverified-${variant}-${width}.png`),fullPage:true});
   await page.route("**/api/hr/payroll/disburse?clientRequestId=*",async route=>{
    const response=await route.fetch();expect(response.status()).toBe(200);
    await route.fulfill({response,json:{disbursement:{...committedBody.disbursement,currency:"USD"}}});
   },{times:1});
   await page.getByRole("button",{name:"التحقق من الصرف السابق"}).click();
   await expect.poll(()=>page.locator('section[aria-label="إدارة المسير والصرف"]').innerText()).toContain("ولا تبدأ عملية أخرى قبل التحقق");
   expect(await page.evaluate(id=>JSON.parse(localStorage.getItem(`hr:payroll:pending:${id}`)!).completed,item.id)).not.toBe(true);
   const method=variant==="missing"?"POST":"GET";
   const replay=page.waitForResponse(r=>r.url().includes("/api/hr/payroll/disburse")&&r.request().method()===method);
   await page.getByRole("button",{name:method==="POST"?"تأكيد الصرف وتسجيل المصروف":"التحقق من الصرف السابق"}).click();const response=await replay;expect(response.status()).toBe(200);
   expect((await response.json()).disbursement).toMatchObject({id:committedBody.disbursement.id,clientRequestId:submitted.clientRequestId,itemId:item.id});
   await expect.poll(()=>page.getByRole("button",{name:"تأكيد الصرف وتسجيل المصروف"}).isVisible()).toBe(false);
   expect((await db.query("SELECT count(*)::int AS n,sum(amount_minor)::text AS amount FROM hr_payroll_disbursements WHERE item_id=$1",[item.id])).rows[0]).toEqual({n:1,amount:"1000"});
   expect((await db.query("SELECT count(*)::int AS n FROM expenses WHERE payable_id=$1",[item.payableId])).rows[0].n).toBe(1);
   await page.screenshot({path:join(evidence,`hr-verified-replay-${variant}-${width}.png`),fullPage:true});
  }finally{await fixture.close();}
 });
}
for(const width of [390,1280]){
 it(`unverified reversal preserves the confirmed request until the original voucher is verified at ${width}px`,async()=>{
  const fixture=await confirmationFixture(width===390?"2026-03":"2026-02","reverse",width),{page,item,row}=fixture;
  try{
   await row.getByRole("button",{name:"صرف",exact:true}).click();await page.locator('input[type="number"]').fill("1000");
   const created=page.waitForResponse(r=>r.url().endsWith("/api/hr/payroll/disburse")&&r.request().method()==="POST");
   await page.getByRole("button",{name:"تأكيد الصرف وتسجيل المصروف"}).click();const paid=(await (await created).json()).disbursement;
   await expect.poll(()=>row.getByRole("button",{name:`عكس الصرف #${paid.id}`,exact:true}).count()).toBe(1);
   page.on("dialog",dialog=>dialog.accept("Synthetic verified reversal"));
   await page.route("**/api/hr/payroll/disburse",async route=>{const response=await route.fetch();expect(response.status()).toBe(200);expect((await response.json()).disbursement.reversedAt).toBeTruthy();await route.fulfill({response,json:{success:true}});},{times:1});
   await row.getByRole("button",{name:`عكس الصرف #${paid.id}`,exact:true}).click();
   await expect.poll(()=>page.locator('section[aria-label="إدارة المسير والصرف"]').innerText()).toContain("لم تتأكد نتيجة عكس الصرف");
   expect(await page.evaluate(id=>JSON.parse(localStorage.getItem(`hr:payroll:pending:${id}`)!).clientRequestId,item.id)).toBe(paid.clientRequestId);
   await page.screenshot({path:join(evidence,`hr-unverified-reversal-${width}.png`),fullPage:true});
   expect(await page.evaluate(id=>JSON.parse(localStorage.getItem(`hr:payroll:pending-reversal:${id}`)!),item.id)).toEqual({itemId:item.id,disbursementId:paid.id,reason:"Synthetic verified reversal"});
   await page.reload({waitUntil:"domcontentloaded"});await page.getByRole("tab",{name:"المسير والصرف"}).click();
   await page.locator('section[aria-label="إدارة المسير والصرف"] select').first().selectOption(String(fixture.periodId));
   await expect.poll(()=>row.innerText()).toContain("معكوس:");
   await row.getByRole("button",{name:"صرف",exact:true}).click();
   await expect.poll(()=>page.locator('section[aria-label="إدارة المسير والصرف"]').innerText()).toContain("تحقق من عكس الصرف السابق");
   expect(await page.getByRole("button",{name:"تأكيد الصرف وتسجيل المصروف"}).count()).toBe(0);
   const replay=page.waitForResponse(r=>r.url().endsWith("/api/hr/payroll/disburse")&&r.request().method()==="POST");
   await row.getByRole("button",{name:`التحقق من عكس الصرف #${paid.id}`,exact:true}).click();const verified=await replay;expect(verified.status()).toBe(200);
   expect(verified.request().postDataJSON()).toEqual({action:"reverse",disbursementId:paid.id,reason:"Synthetic verified reversal"});
   await expect.poll(()=>row.innerText()).toContain("معكوس:");
   await expect.poll(()=>page.evaluate(id=>localStorage.getItem(`hr:payroll:pending:${id}`),item.id)).toBeNull();
   expect(await page.evaluate(id=>localStorage.getItem(`hr:payroll:pending-reversal:${id}`),item.id)).toBeNull();
   expect((await db.query("SELECT count(*)::int AS n FROM expenses WHERE reversal_of_id=$1",[paid.expenseId])).rows[0].n).toBe(1);
   expect((await db.query("SELECT sum(amount_minor)::text AS total FROM expenses WHERE payable_id=$1",[item.payableId])).rows[0].total).toBe("0");
  }finally{await fixture.close();}
 });
}

for(const width of [390,1280]){
 it(`an older payroll fetch cannot replace the newly selected period at ${width}px`,async()=>{
  const fixture=await confirmationFixture(width===390?"2026-10":"2026-11","race",width),{page}=fixture;
  let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve});
  let arrived!:()=>void;const intercepted=new Promise<void>(resolve=>{arrived=resolve});
  try{
   const initial=page.waitForResponse(r=>r.url().endsWith(`/api/hr/payroll/runs?id=${run.id}`));
   await page.locator('section[aria-label="إدارة المسير والصرف"] select').first().selectOption(String(run.periodId));
   expect((await initial).status()).toBe(200);
   await expect.poll(()=>page.getByRole("link",{name:"طباعة الكشف"}).getAttribute("href")).toBe(`/print/hr/payroll/${run.id}`);
   await page.route(`**/api/hr/payroll/runs?id=${run.id}`,async route=>{const response=await route.fetch();arrived();await barrier;await route.fulfill({response});},{times:1});
   await page.getByRole("button",{name:"SAR",exact:false}).click();
   await page.getByRole("button",{name:"YER",exact:false}).click();await intercepted;
   const newer=page.waitForResponse(r=>r.url().endsWith(`/api/hr/payroll/runs?id=${fixture.item.runId}`));
   await page.locator('section[aria-label="إدارة المسير والصرف"] select').first().selectOption(String(fixture.periodId));expect((await newer).status()).toBe(200);
   const marker=fixture.row;await expect.poll(()=>marker.count()).toBe(1);
   const older=page.waitForResponse(r=>r.url().endsWith(`/api/hr/payroll/runs?id=${run.id}`));release();expect((await older).status()).toBe(200);
   // Let the response body and React update complete before asserting the selected run.
   await page.waitForLoadState("networkidle");
   expect(await page.locator('section[aria-label="إدارة المسير والصرف"] select').first().inputValue()).toBe(String(fixture.periodId));
   expect(await marker.count()).toBe(1);
   await page.screenshot({path:join(evidence,`hr-payroll-period-race-${width}.png`),fullPage:true});
  }finally{release();await fixture.close();}
 });
}

for(const width of [390,1280]){
 it(`every synthetic payroll row survives a multi-page PDF at ${width}px`,async()=>{
  const names=Array.from({length:40},(_,i)=>`HRPRINT${width}EMP${String(i).padStart(2,"0")}`);
  for(const name of names){
   const staff=await api("POST","/api/hr/staff",{fullName:name,department:"secretariat",jobTitle:"اختبار طباعة اصطناعي",hireDate:"2026-01-01",endDate:null,phone:null,note:null,workStatus:"active",contractKind:"salary",salaryAmountMinor:1200,salaryCurrency:"YER",salaryPeriod:"monthly",salaryEffectiveOn:"2026-01-01"});
   expect(staff.status).toBe(201);
  }
  const period=await api("POST","/api/hr/payroll/periods",{periodMonth:width===390?"2027-01":"2027-02"});expect(period.status).toBe(201);
  const calculated=await api("POST","/api/hr/payroll/runs",{action:"calculate",periodId:period.body.id,currency:"YER"});expect(calculated.status).toBe(201);
  expect((await api("POST","/api/hr/payroll/runs",{action:"approve",runId:calculated.body.id})).status).toBe(200);
  const actual=(await api("GET",`/api/hr/payroll/runs?id=${calculated.body.id}`)).body.items;
  expect(actual.length).toBeGreaterThanOrEqual(40);
  const page=await context.newPage();await page.setViewportSize({width,height:width===390?844:900});
  try{
   await page.goto(`${baseUrl}/print/hr/payroll/${calculated.body.id}`,{waitUntil:"networkidle"});
   const body=await page.textContent("body");for(const employee of actual)expect(body).toContain(employee.staffName);
   const pdf=join(evidence,`hr-payroll-multipage-${width}.pdf`);await page.pdf({path:pdf,format:"A4",printBackground:true});
   const info=execFileSync("pdfinfo",[pdf],{encoding:"utf8"});expect(Number(info.match(/^Pages:\s+(\d+)/m)?.[1])).toBeGreaterThan(1);
   const text=execFileSync("pdftotext",[pdf,"-"],{encoding:"utf8"}).replace(/[\s\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,"");
   for(const name of names)expect(text).toContain(name);
   await page.screenshot({path:join(evidence,`hr-payroll-multipage-${width}.png`),fullPage:true});
  }finally{await page.close();}
 });
}

for(const width of [390,1280]){
 it(`a confirmed keyless legacy reversal is recovered without inventing a request key at ${width}px`,async()=>{
  const fixture=await confirmationFixture(width===390?"2026-12":"2027-03","keyless",width),{page,item,row}=fixture;
  try{
   const created=await api("POST","/api/hr/payroll/disburse",{itemId:item.id,amountMinor:1000,components:{salaryMinor:1000,commissionMinor:0},clientRequestId:`fixture-keyless-${width}-001`});expect(created.status).toBe(201);
   const paid=created.body.disbursement;
   // Historical fixture shape: preserve the real payout, vouchers and links; old writers had no request key.
   await db.query("UPDATE hr_payroll_disbursements SET client_request_id=NULL,request_fingerprint=NULL WHERE id=$1",[paid.id]);
   await page.reload({waitUntil:"domcontentloaded"});await page.getByRole("tab",{name:"المسير والصرف"}).click();
   await page.locator('section[aria-label="إدارة المسير والصرف"] select').first().selectOption(String(fixture.periodId));
   await expect.poll(()=>row.getByRole("button",{name:`عكس الصرف #${paid.id}`,exact:true}).count()).toBe(1);
   page.on("dialog",dialog=>dialog.accept("Synthetic keyless legacy reversal"));
   const result=page.waitForResponse(r=>r.url().endsWith("/api/hr/payroll/disburse")&&r.request().method()==="POST");
   await row.getByRole("button",{name:`عكس الصرف #${paid.id}`,exact:true}).click();const response=await result;expect(response.status()).toBe(200);
   const reversed=(await response.json()).disbursement;expect(reversed.clientRequestId).toBeNull();expect(reversed.reversedAt).toBeTruthy();
   await expect.poll(()=>row.innerText()).toContain("معكوس:");
   await expect.poll(()=>page.evaluate(id=>localStorage.getItem(`hr:payroll:pending-reversal:${id}`),item.id)).toBeNull();
   expect((await db.query("SELECT client_request_id FROM hr_payroll_disbursements WHERE id=$1",[paid.id])).rows[0].client_request_id).toBeNull();
   expect((await db.query("SELECT count(*)::int AS n FROM expenses WHERE reversal_of_id=$1",[paid.expenseId])).rows[0].n).toBe(1);
   expect((await db.query("SELECT sum(amount_minor)::text AS total FROM expenses WHERE payable_id=$1",[item.payableId])).rows[0].total).toBe("0");
   await page.screenshot({path:join(evidence,`hr-keyless-reversal-${width}.png`),fullPage:true});
  }finally{await fixture.close();}
 });
}

// The existing tab's accessible name includes its exposed document icon. Scope
// navigation to the owned HR tablist and witness the actual contract read before
// any form action; no polling delay or role/authority relaxation is introduced.
async function openContractsPanel(page:Page){
 const tab=page.getByRole("tablist",{name:"أقسام الموارد البشرية",exact:true})
   .getByRole("tab",{name:"📄 العقود",exact:true});
 const [response]=await Promise.all([
   page.waitForResponse(r=>{const url=new URL(r.url());return url.origin===baseUrl&&url.pathname==="/api/hr/contracts"&&r.request().method()==="GET";}),
   tab.click(),
 ]);
 expect(response.status()).toBe(200);expect(Array.isArray(await response.json())).toBe(true);
 await expect.poll(()=>tab.getAttribute("aria-selected")).toBe("true");
 const panel=page.getByRole("region",{name:"إدارة العقود",exact:true});
 await expect.poll(()=>panel.count()).toBe(1);
 await expect.poll(()=>panel.getByText("جاري تحميل العقود...",{exact:true}).count()).toBe(0);
}

// Independent owned contract journey runs after existing payroll cases.
 it("shows the allowed administrative approval journey and preserves the approved original through an addendum",async()=>{
   const name=`HR-LIFECYCLE-${Date.now()}`;
   const staff=await api("POST","/api/hr/staff",{fullName:name,department:"secretariat",jobTitle:"Synthetic contract lifecycle",hireDate:"2026-01-01",endDate:null,phone:null,note:null,workStatus:"active",contractKind:"salary",salaryAmountMinor:25000,salaryCurrency:"YER",salaryPeriod:"monthly",salaryEffectiveOn:"2026-01-01"});expect(staff.status).toBe(201);
   const created=await api("POST","/api/hr/contracts",{staffId:staff.body.staff?.id??staff.body.id,title:name,templateKind:"support_staff",startDate:"2026-01-01",compensationKind:"salary",baseSalaryMinor:25000,salaryCurrency:"YER",salaryPeriod:"monthly",termsPayload:{clauses:["Synthetic original clause"]}});expect(created.status).toBe(201);const id=created.body.id;
   expect((await api("PATCH",`/api/hr/contracts/${id}`,{action:"transition",status:"active",reason:"Forbidden approval bypass"})).status).toBe(409);
   const page=await context.newPage();try{
     await page.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});await openContractsPanel(page);
     const row=page.locator("tbody tr").filter({hasText:name});await expect.poll(()=>row.count()).toBe(1);await row.getByRole("button",{name:"عرض وتعديل",exact:true}).click();
     await page.getByRole("button",{name:"تغيير الحالة",exact:true}).click();
     const dialog=page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"تغيير حالة العقد",exact:true})});
     expect(await dialog.getByRole("combobox").locator("option").evaluateAll(nodes=>nodes.map(n=>(n as HTMLOptionElement).value))).toEqual(["approved","under_review","terminated"]);
     const approval=page.waitForResponse(r=>r.url().endsWith(`/api/hr/contracts/${id}`)&&r.request().method()==="PATCH");await dialog.getByRole("button",{name:"تأكيد التغيير",exact:true}).click();expect((await approval).status()).toBe(200);
     await expect.poll(async()=>(await api("GET",`/api/hr/contracts/${id}`)).body.contract.status).toBe("approved");
     await expect.poll(()=>dialog.count()).toBe(0);await page.getByRole("button",{name:"تغيير الحالة",exact:true}).click();
     await expect.poll(()=>dialog.getByRole("combobox").locator("option").evaluateAll(nodes=>nodes.map(n=>(n as HTMLOptionElement).value))).toEqual(["active","expired","terminated"]);
     await dialog.getByRole("combobox").selectOption("active");const activation=page.waitForResponse(r=>r.url().endsWith(`/api/hr/contracts/${id}`)&&r.request().method()==="PATCH");await dialog.getByRole("button",{name:"تأكيد التغيير",exact:true}).click();expect((await activation).status()).toBe(200);
     const before=(await db.query("SELECT to_jsonb(c) AS row FROM hr_contracts c WHERE id=$1",[id])).rows[0].row;expect(before.status).toBe("active");expect(before.approved_at).not.toBeNull();expect(before.signed_by_staff).toBe(false);expect(before.signed_by_center).toBe(false);expect(before.signed_at).toBeNull();
     expect((await api("PATCH",`/api/hr/contracts/${id}`,{action:"transition",status:"draft",reason:"Forbidden rewind"})).status).toBe(409);
     expect((await api("PATCH",`/api/hr/contracts/${id}`,{title:"Forbidden changed original",baseSalaryMinor:1})).status).toBe(400);
     const child=await api("POST",`/api/hr/contracts/${id}`,{title:"Synthetic explicit addendum",startDate:"2026-01-01",addendumReason:"New terms are a separate draft",baseSalaryMinor:26000,salaryCurrency:"YER",salaryPeriod:"monthly"});expect(child.status).toBe(201);expect(child.body.parentContractId).toBe(id);expect(child.body.status).toBe("draft");expect(child.body.signedAt).toBeNull();
     expect((await db.query("SELECT to_jsonb(c) AS row FROM hr_contracts c WHERE id=$1",[id])).rows[0].row).toEqual(before);
     expect((await api("PATCH",`/api/hr/contracts/${id}`,{action:"transition",status:"terminated"},h.sessions.doctorA.cookie)).status).toBe(403);
   }finally{await page.close();}
 },120000);

// Real template buttons -> canonical writer -> browser reopen -> print.
const contractTemplateCases=[
 {button:"عقد موظف مساند (راتب)",kind:"support_staff",pay:"salary"},
 {button:"عقد طبيب (نسبة)",kind:"doctor_percentage",pay:"commission"},
 {button:"عقد طبيب (راتب)",kind:"doctor_salary",pay:"salary"},
 {button:"عقد مختلط (راتب ونسبة)",kind:"doctor_hybrid",pay:"salary_commission"},
 {button:"فترة تجربة",kind:"support_staff",pay:"salary"},
] as const;
for(const [index,template] of contractTemplateCases.entries()){
 it(`creates and reopens the actual ${template.kind}/${index} template with unknown wages intact`,async()=>{
  const name=`HR-TEMPLATE-${index}-${Date.now()}`;
  const staff=await api("POST","/api/hr/staff",{fullName:name,department:"secretariat",jobTitle:"Synthetic template",hireDate:"2026-01-01",endDate:null,phone:null,note:null,workStatus:"active",contractKind:"salary",salaryAmountMinor:10000,salaryCurrency:"YER",salaryPeriod:"monthly",salaryEffectiveOn:"2026-01-01"});expect(staff.status).toBe(201);
  const page=await context.newPage();try{
   await page.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});await openContractsPanel(page);await page.getByRole("button",{name:/إنشاء عقد جديد/}).click();
   const form=page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"إنشاء عقد وظيفي جديد",exact:true})});
   await form.getByRole("button",{name:template.button,exact:true}).click();
   expect(await form.getByLabel("نوع العقد",{exact:true}).inputValue()).toBe(template.kind);
   for(const label of ["الراتب الأساسي","نسبة الطبيب (%)","أجر الساعة","ساعات العمل أسبوعياً","عملة الأجر","دورية الراتب","نهاية فترة التجربة"])expect(await form.getByLabel(label,{exact:true}).inputValue()).toBe("");
   await form.getByLabel("الموظف",{exact:true}).selectOption(String(staff.body.staff?.id??staff.body.id));await form.getByLabel("مسمى العقد",{exact:true}).fill(name);
   const saved=page.waitForResponse(r=>r.url().endsWith("/api/hr/contracts")&&r.request().method()==="POST");await form.getByRole("button",{name:"حفظ العقد",exact:true}).click();const response=await saved;expect(response.status()).toBe(201);const contract=await response.json();
   expect(contract.templateKind).toBe(template.kind);expect(contract.compensationKind).toBe(template.pay);
   for(const key of ["baseSalaryMinor","salaryCurrency","salaryPeriod","commissionRatePercent","doctorPartyId","probationEndDate"])expect(contract[key]).toBeNull();
   expect(contract.status).toBe("draft");expect(contract.termsPayload.clauses).toEqual([]);expect(contract.termsPayload.workingHoursPerWeek).toBeNull();
   expect((await api("PATCH",`/api/hr/contracts/${contract.id}`,{action:"transition",status:"approved"})).status).toBe(409);
   await page.reload({waitUntil:"domcontentloaded"});await openContractsPanel(page);const row=page.locator("tbody tr").filter({hasText:name});await row.getByRole("button",{name:"عرض وتعديل",exact:true}).click();
   await expect.poll(()=>page.getByRole("status").filter({hasText:"شروط الأجر غير مكتملة"}).count()).toBe(1);
   const persisted=(await db.query("SELECT * FROM hr_contracts WHERE id=$1",[contract.id])).rows[0];expect(persisted.base_salary_minor).toBeNull();expect(persisted.commission_rate_percent).toBeNull();expect(persisted.approved_at).toBeNull();
   await page.goto(`${baseUrl}/print/hr/contracts/${contract.id}`,{waitUntil:"domcontentloaded"});await expect.poll(()=>page.textContent("body")).toContain("شروط الأجر غير مكتملة");expect(await page.textContent("body")).toContain("مسودة عقد عمل غير معتمدة");
   if(index===0){
    await page.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});await openContractsPanel(page);await page.locator("tbody tr").filter({hasText:name}).getByRole("button",{name:"عرض وتعديل",exact:true}).click();
    await page.getByRole("button",{name:"استكمال / تعديل المسودة",exact:true}).click();
    const editor=page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"استكمال / تعديل المسودة",exact:true})});
    expect(await editor.getByLabel("الراتب الأساسي",{exact:true}).inputValue()).toBe("");expect(await editor.getByLabel("نوع العقد",{exact:true}).isDisabled()).toBe(true);
    await editor.getByLabel("عملة الأجر",{exact:true}).selectOption("SAR");await editor.getByLabel("دورية الراتب",{exact:true}).selectOption("monthly");await editor.getByLabel("الراتب الأساسي",{exact:true}).fill("123.45");
    const updated=page.waitForResponse(r=>r.url().endsWith(`/api/hr/contracts/${contract.id}`)&&r.request().method()==="PATCH");await editor.getByRole("button",{name:"حفظ العقد",exact:true}).click();expect((await updated).status()).toBe(200);
    await page.reload({waitUntil:"domcontentloaded"});await openContractsPanel(page);await page.locator("tbody tr").filter({hasText:name}).getByRole("button",{name:"عرض وتعديل",exact:true}).click();
    await expect.poll(()=>page.getByRole("dialog").innerText()).toContain(formatAmount(12345,"SAR"));
    await page.getByRole("button",{name:"تغيير الحالة",exact:true}).click();const statusDialog=page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"تغيير حالة العقد",exact:true})});await statusDialog.getByRole("combobox").selectOption("approved");
    const approved=page.waitForResponse(r=>r.url().endsWith(`/api/hr/contracts/${contract.id}`)&&r.request().method()==="PATCH");await statusDialog.getByRole("button",{name:"تأكيد التغيير",exact:true}).click();expect((await approved).status()).toBe(200);
    await expect.poll(()=>page.getByRole("button",{name:"استكمال / تعديل المسودة",exact:true}).count()).toBe(0);
    const final=(await api("GET",`/api/hr/contracts/${contract.id}`)).body.contract;expect(final.status).toBe("approved");expect(final.baseSalaryMinor).toBe(12345);expect(final.salaryCurrency).toBe("SAR");expect(final.signedAt).toBeNull();
    await page.goto(`${baseUrl}/print/hr/contracts/${contract.id}`,{waitUntil:"domcontentloaded"});await expect.poll(()=>page.textContent("body")).toContain(formatAmount(12345,"SAR"));
   }

  }finally{await page.close();}
 },120000);
}
for(const scenario of [
 {button:"عقد موظف مساند (راتب)",currency:"YER",amount:"12345",rate:""},
 {button:"عقد طبيب (نسبة)",currency:"",amount:"",rate:"17.25"},
 {button:"عقد مختلط (راتب ونسبة)",currency:"SAR",amount:"123.45",rate:"12.5"},
 {button:"عقد طبيب (راتب)",currency:"USD",amount:"98.76",rate:""},
]){
 it(`retains explicit ${scenario.button}/${scenario.currency} amounts through UI save, reopen and print`,async()=>{
  const name=`HR-MONEY-${scenario.currency||"RATE"}-${Date.now()}`;
  const staff=await api("POST","/api/hr/staff",{fullName:name,department:"secretariat",jobTitle:"Synthetic contract money",hireDate:"2026-01-01",endDate:null,phone:null,note:null,workStatus:"active",contractKind:"salary",salaryAmountMinor:10000,salaryCurrency:"YER",salaryPeriod:"monthly",salaryEffectiveOn:"2026-01-01"});expect(staff.status).toBe(201);
  const page=await context.newPage();try{
   await page.goto(`${baseUrl}/hr`,{waitUntil:"domcontentloaded"});await openContractsPanel(page);await page.getByRole("button",{name:/إنشاء عقد جديد/}).click();
   const form=page.getByRole("dialog").filter({has:page.getByRole("heading",{name:"إنشاء عقد وظيفي جديد",exact:true})});await form.getByRole("button",{name:scenario.button,exact:true}).click();await form.getByLabel("الموظف",{exact:true}).selectOption(String(staff.body.staff?.id??staff.body.id));await form.getByLabel("مسمى العقد",{exact:true}).fill(name);
   if(scenario.amount){await form.getByLabel("عملة الأجر",{exact:true}).selectOption(scenario.currency);await form.getByLabel("دورية الراتب",{exact:true}).selectOption("monthly");await form.getByLabel("الراتب الأساسي",{exact:true}).fill(scenario.amount);}
   if(scenario.rate)await form.getByLabel("نسبة الطبيب (%)",{exact:true}).fill(scenario.rate);
   const saved=page.waitForResponse(r=>r.url().endsWith("/api/hr/contracts")&&r.request().method()==="POST");await form.getByRole("button",{name:"حفظ العقد",exact:true}).click();const response=await saved;expect(response.status()).toBe(201);const contract=await response.json();
   const minor=scenario.amount?parseAmount(scenario.amount,scenario.currency as Currency):null;
   expect(contract.baseSalaryMinor).toBe(minor);expect(contract.salaryCurrency).toBe(scenario.currency||null);expect(contract.commissionRatePercent).toBe(scenario.rate?Number(scenario.rate):null);
   await page.reload({waitUntil:"domcontentloaded"});await openContractsPanel(page);await page.locator("tbody tr").filter({hasText:name}).getByRole("button",{name:"عرض وتعديل",exact:true}).click();
   const details=page.getByRole("dialog");if(minor!==null)await expect.poll(()=>details.innerText()).toContain(formatAmount(minor,scenario.currency as Currency));if(scenario.rate)await expect.poll(()=>details.innerText()).toContain(`${scenario.rate}%`);
   const persisted=(await api("GET",`/api/hr/contracts/${contract.id}`)).body.contract;expect(persisted.baseSalaryMinor).toBe(minor);expect(persisted.salaryCurrency).toBe(scenario.currency||null);expect(persisted.commissionRatePercent).toBe(scenario.rate?Number(scenario.rate):null);
   await page.goto(`${baseUrl}/print/hr/contracts/${contract.id}`,{waitUntil:"domcontentloaded"});if(minor!==null)await expect.poll(()=>page.textContent("body")).toContain(formatAmount(minor,scenario.currency as Currency));if(scenario.rate)await expect.poll(()=>page.textContent("body")).toContain(`${scenario.rate}%`);
   expect((await db.query("SELECT base_salary_minor::text AS amount,salary_currency,commission_rate_percent::text AS rate FROM hr_contracts WHERE id=$1",[contract.id])).rows[0]).toEqual({amount:minor===null?null:String(minor),salary_currency:scenario.currency||null,rate:scenario.rate?Number(scenario.rate).toFixed(2):null});
  }finally{await page.close();}
 },120000);
}
