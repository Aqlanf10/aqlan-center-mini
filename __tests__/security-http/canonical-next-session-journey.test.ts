/** Slice 28: synthetic, built HTTP/browser evidence for the existing next-session door. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { mkdirSync } from "node:fs";
const ACCOUNTS = {
  owner: { username: "syn-next-owner", password: "Synthetic#NextOwner1", role: "admin", display: "المالك التجريبي" },
  desk: { username: "syn-next-desk", password: "Synthetic#NextDesk1", role: "reception", display: "منسق تجريبي", patientScope: "all", appointmentScope: "all", grants: { "clinical.plans.view": true, "appointments.create": true } },
  reader: { username: "syn-next-reader", password: "Synthetic#NextReader1", role: "admin", display: "قارئ تجريبي", patientScope: "all", appointmentScope: "all", grants: { "clinical.plans.view": true } },
  scheduler: { username: "syn-next-scheduler", password: "Synthetic#NextScheduler1", role: "reception", display: "حاجز تجريبي", patientScope: "all", appointmentScope: "all", grants: { "appointments.create": true } },
  own: { username: "syn-next-own", password: "Synthetic#NextOwn1", role: "doctor", display: "طبيب تجريبي", doctor: true, patientScope: "own", appointmentScope: "all", grants: { "clinical.plans.view": true, "appointments.create": true, "finance.payments.view": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
let patientId = 0, visitId = 0, doctorId = 0, date = "";
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 37, secret: "synthetic-canonical-next-session-20261030", accounts: ACCOUNTS, ownerKey: "owner", async seed(db) {
    date = (await db.query("SELECT to_char((NOW() AT TIME ZONE 'Asia/Aden')::date + 7,'YYYY-MM-DD') AS d")).rows[0].d;
    doctorId = (await db.query("INSERT INTO parties(kind,name,is_active) VALUES ('doctor','طبيب الحالة التجريبي',TRUE) RETURNING id")).rows[0].id;
    patientId = (await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ('SYN-NEXT-1','مريض الجلسة التجريبي',$1) RETURNING id", [doctorId])).rows[0].id;
    const clinical = (await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,created_by) VALUES ($1,'general','حالة تجريبية',$2,'synthetic') RETURNING id", [patientId, doctorId])).rows[0].id;
    visitId = (await db.query("INSERT INTO visits(patient_name,patient_id,case_id,doctor_id,status) VALUES ('مريض الجلسة التجريبي',$1,$2,$3,'done') RETURNING id", [patientId, clinical, doctorId])).rows[0].id;
    for (const [key,value] of [["clinic.chairs","1"],["clinic.day_start","08:00"],["clinic.day_end","20:00"]]) await db.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[key,value]);
  }});
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
const preview = async (cookie: string) => {
  const response = await journey.api(`/api/patients/${patientId}/return-booking-context?kind=visit&sourceId=${visitId}`, cookie);
  expect(response.status).toBe(200); return response.json();
};
it("HTTP: canonical next-session booking uses the reviewed responsible doctor and atomic audit", async () => {
  const { cookie } = await journey.login("desk"), context = await preview(cookie);
  const response = await journey.api(`/api/visits/${visitId}/next`, cookie, { method: "POST", body: JSON.stringify({ date, time: "09:00", durationMinutes: 30, returnBookingFingerprint: context.fingerprint, doctorId: 999999 }) });
  expect(response.status).toBe(201);
  const body = await response.json(); expect(body).toMatchObject({ patientId, doctorId, doctorName: "طبيب الحالة التجريبي" });
  expect((await journey.db.query("SELECT doctor_id FROM appointments WHERE id=$1", [body.appointmentId])).rows).toEqual([{ doctor_id: doctorId }]);
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='appointment.create' AND entity_id=$1::text", [body.appointmentId])).rows).toEqual([{ actor: "syn-next-desk" }]);
  expect(response.headers.get("cache-control")).toContain("no-store"); expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: no grant, outside patient, missing record, revoked session and invalid input cannot write", async () => {
  const reader=await journey.login("reader"), own=await journey.login("own"), desk=await journey.login("desk");
  const context=await preview(desk.cookie), body=JSON.stringify({date,time:"11:00",durationMinutes:30,returnBookingFingerprint:context.fingerprint});
  expect((await journey.api(`/api/visits/${visitId}/next`,reader.cookie,{method:"POST",body})).status).toBe(403);
  const outside=await journey.api(`/api/visits/${visitId}/next`,own.cookie,{method:"POST",body});
  const missing=await journey.api("/api/visits/999999/next",own.cookie,{method:"POST",body});
  expect(outside.status).toBe(404); expect(await outside.json()).toEqual(await missing.json());
  const invalid=await journey.api(`/api/visits/${visitId}/next`,desk.cookie,{method:"POST",body:JSON.stringify({date,time:"99:00"})});
  expect(invalid.status).toBe(400); expect((await invalid.json()).message).toMatch(/[؀-ۿ]/);
  await journey.db.query("UPDATE users SET permissions=jsonb_set(permissions::jsonb,'{revision}','2')::text WHERE id=$1",[journey.ids.reader]);
  expect((await journey.api(`/api/visits/${visitId}/next`,reader.cookie,{method:"POST",body})).status).toBe(401);
  expect(Number((await journey.db.query("SELECT count(*) FROM appointments WHERE patient_id=$1",[patientId])).rows[0].count)).toBe(1);
  expect(await journey.ddlLog()).toEqual([]);
});
it("browser 390px: legitimate booking, nearby confirmation, current doctor and canonical-only API calls",async () => {
  const browser=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"}), page=await browser.newPage();
  const calls:string[]=[];
  await journey.browserLogin(page,"desk");
  page.on("request",r=>{const p=new URL(r.url()).pathname;if(p.startsWith("/api/"))calls.push(p);});
  await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  const form=page.getByTestId(`next-session-${visitId}`);
  await form.getByRole("button",{name:"حجز الجلسة القادمة",exact:true}).click();
  await form.getByText("الطبيب المسؤول الحالي: طبيب الحالة التجريبي").waitFor();
  await form.getByLabel("التاريخ",{exact:true}).fill(date); await form.getByLabel("الوقت",{exact:true}).fill("11:00");
  mkdirSync(".settings-ui-artifacts",{recursive:true});
  await page.screenshot({path:".settings-ui-artifacts/canonical-next-session-390.png",fullPage:true});
  await form.getByRole("button",{name:"تأكيد حجز الجلسة القادمة",exact:true}).click();
  await page.getByRole("button",{name:"تأكيد موعد إضافي مقصود"}).click();
  await form.getByRole("status").filter({hasText:"حُجزت الجلسة القادمة"}).waitFor();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  const allowed=new RegExp(`^/api/(auth/me|patients/${patientId}(/[a-z-]+)?|visits/${visitId}/next)$`);
  expect(calls.filter(p=>!allowed.test(p))).toEqual([]); expect(calls.filter(p=>p===`/api/visits/${visitId}/next`)).toHaveLength(2);
  await browser.close(); expect(await journey.ddlLog()).toEqual([]);
});
it("browser: lost success response sends no automatic retry; verification finds the committed appointment",async () => {
  const browser=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"}), page=await browser.newPage();
  await journey.browserLogin(page,"desk"); await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  const form=page.getByTestId(`next-session-${visitId}`); let posts=0;
  await form.getByRole("button",{name:"حجز الجلسة القادمة",exact:true}).click();
  await form.getByText("الطبيب المسؤول الحالي: طبيب الحالة التجريبي").waitFor();
  const later=(await journey.db.query("SELECT to_char($1::date+7,'YYYY-MM-DD') AS d",[date])).rows[0].d;
  await form.getByLabel("التاريخ",{exact:true}).fill(later);
  await page.route(`**/api/visits/${visitId}/next`,async route=>{posts++; const response=await route.fetch(); expect(response.status()).toBe(201); await route.abort("failed");});
  await form.getByRole("button",{name:"تأكيد حجز الجلسة القادمة",exact:true}).click();
  await form.getByRole("alert").filter({hasText:"لم تتأكد نتيجة الحجز"}).waitFor();
  expect(await form.getByRole("button",{name:"تأكيد حجز الجلسة القادمة",exact:true}).count()).toBe(0);
  await page.reload();
  await form.getByRole("alert").filter({hasText:"لم تتأكد نتيجة طلب سابق"}).waitFor();
  expect(posts).toBe(1);
  await form.getByRole("button",{name:"تحقق من نتيجة الحجز"}).click();
  await form.getByRole("status").filter({hasText:"يوجد موعد مطابق"}).waitFor();
  expect(posts).toBe(1); expect(Number((await journey.db.query("SELECT count(*) FROM appointments WHERE patient_id=$1 AND scheduled_date=$2",[patientId,later])).rows[0].count)).toBe(1);
  await browser.close(); expect(await journey.ddlLog()).toEqual([]);
});
it("browser: reader has no booking action; revoked writer clears the booking form after server refusal",async () => {
  const browser=await journey.browser.newContext(),page=await browser.newPage();
  await journey.browserLogin(page,"reader"); await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  await page.getByTestId("canonical-patient-profile").waitFor(); expect(await page.getByTestId(`next-session-${visitId}`).count()).toBe(0);
  await journey.browserLogin(page,"desk"); await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  const form=page.getByTestId(`next-session-${visitId}`);
  await form.getByRole("button",{name:"حجز الجلسة القادمة",exact:true}).click(); await form.getByText("الطبيب المسؤول الحالي: طبيب الحالة التجريبي").waitFor();
  await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,appointments.create}','false')::text WHERE id=$1",[journey.ids.desk]);
  await form.getByRole("button",{name:"تأكيد حجز الجلسة القادمة",exact:true}).click();
  await form.getByRole("alert").filter({hasText:"انتهت الجلسة أو تغيّرت صلاحية الوصول"}).waitFor();
  expect(await form.getByText("الطبيب المسؤول الحالي: طبيب الحالة التجريبي").count()).toBe(0);
  expect(await form.getByRole("button",{name:"تأكيد حجز الجلسة القادمة",exact:true}).count()).toBe(0);
  await browser.close(); expect(await journey.ddlLog()).toEqual([]);
});
it("browser: scheduler without clinical or queue-management grants can book return from the completed visit",async () => {
  const browser=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"}),page=await browser.newPage();
  await journey.browserLogin(page,"scheduler");await page.goto(`${journey.baseUrl}/visits`);
  const form=page.getByTestId(`next-session-${visitId}`);
  await form.getByRole("button",{name:"حجز الجلسة القادمة",exact:true}).click();await form.getByText("الطبيب المسؤول الحالي: طبيب الحالة التجريبي").waitFor();
  expect(await page.getByRole("button",{name:"انتهى",exact:true}).count()).toBe(0);
  const later=(await journey.db.query("SELECT to_char($1::date+21,'YYYY-MM-DD') AS d",[date])).rows[0].d;
  await form.getByLabel("التاريخ",{exact:true}).fill(later);await form.getByRole("button",{name:"تأكيد حجز الجلسة القادمة",exact:true}).click();
  await form.getByRole("status").filter({hasText:"حُجزت الجلسة القادمة"}).waitFor();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await browser.close();expect(await journey.ddlLog()).toEqual([]);
});
it("browser: a request that never reached the server stays blocked until a read and separate new intent",async () => {
  const browser=await journey.browser.newContext({viewport:{width:390,height:844},locale:"ar"}),page=await browser.newPage();
  await journey.browserLogin(page,"owner");await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  const form=page.getByTestId(`next-session-${visitId}`);
  await form.getByRole("button",{name:"حجز الجلسة القادمة",exact:true}).click();await form.getByText("الطبيب المسؤول الحالي: طبيب الحالة التجريبي").waitFor();
  const later=(await journey.db.query("SELECT to_char($1::date+35,'YYYY-MM-DD') AS d",[date])).rows[0].d;
  await form.getByLabel("التاريخ",{exact:true}).fill(later);let posts=0;
  await page.route(`**/api/visits/${visitId}/next`,async route=>{posts++; if(posts===1)await route.abort("failed");else await route.continue();});
  await form.getByRole("button",{name:"تأكيد حجز الجلسة القادمة",exact:true}).click();await form.getByRole("alert").filter({hasText:"لم تتأكد نتيجة الحجز"}).waitFor();
  await form.getByRole("button",{name:"تحقق من نتيجة الحجز"}).click();await form.getByRole("alert").filter({hasText:"لم يظهر موعد مطابق"}).waitFor();
  expect(posts).toBe(1);expect(await form.getByRole("button",{name:"تأكيد حجز الجلسة القادمة",exact:true}).count()).toBe(0);
  await form.getByRole("button",{name:"راجعت المواعيد وأريد محاولة جديدة"}).click();await form.getByText("الطبيب المسؤول الحالي: طبيب الحالة التجريبي").waitFor();
  expect(posts).toBe(1);await form.getByRole("button",{name:"تأكيد حجز الجلسة القادمة",exact:true}).click();
  await form.getByRole("status").filter({hasText:"حُجزت الجلسة القادمة"}).waitFor();expect(posts).toBe(2);
  expect(Number((await journey.db.query("SELECT count(*) FROM appointments WHERE patient_id=$1 AND scheduled_date=$2",[patientId,later])).rows[0].count)).toBe(1);
  await browser.close();expect(await journey.ddlLog()).toEqual([]);
});
