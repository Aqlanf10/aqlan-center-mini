import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { authedMutation, baseUrl, harness } from "./_server";
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });
const post = (path: string, body: object, role: "doctorA" | "doctorB" | "reception" | "admin" = "doctorA") => authedMutation(path, h.sessions[role], "POST", JSON.stringify(body));
const read = (path: string, role: "doctorA" | "doctorB" | "reception" | "admin" = "reception") => fetch(`${baseUrl}${path}`, { headers: { Cookie: h.sessions[role].cookie }, redirect: "manual" });
it("doctor saves and closes visit; explicitly authorized reception reprints immutable Rx without issuing or changing it", async () => {
  const { rows: [doctor] } = await db.query("SELECT party_id FROM users WHERE username='secdoctora'");
  const { rows: [reception] } = await db.query("SELECT id, permissions FROM users WHERE username='secreception'");
  const { rows: [patient] } = await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'مريض وصفة اصطناعي',$2) RETURNING id", [`RX-PERSIST-${Date.now()}`, doctor.party_id]);
  const { rows: [visit] } = await db.query("INSERT INTO visits(patient_id,patient_name,doctor_id,diagnosis) VALUES($1,'مريض وصفة اصطناعي',$2,'Synthetic completed treatment') RETURNING id", [patient.id, doctor.party_id]);
  const setGrant = async (enabled: boolean) => {
    const result = await authedMutation(`/api/users/${reception.id}`, h.sessions.admin, "PATCH", JSON.stringify({ permissions: { ...(reception.permissions ?? {}), canPrintSavedPrescriptions: enabled } }));
    expect(result.status, await result.text()).toBe(200);
  };
  const body = { commandKey: randomUUID(), patientId: patient.id, visitId: visit.id, prescribingDoctorPartyId: doctor.party_id, diagnosis: "Synthetic private diagnosis", notes: "Synthetic private notes", items: [{ name: "SyntheticRxOnly", dose: "fixture", form: "Synthetic form", frequency: "fixture", duration: "Synthetic duration", selection: { id: "manual", amount: "Synthetic amount only", confirmed: true } }] };
  try {
    await setGrant(false);
    expect((await read(`/api/patients/${patient.id}/prescriptions/saved`)).status).toBe(403);
    const { commandKey: _key, ...legacyBody } = body;
    const keyless = await post("/api/prescriptions", legacyBody);
    expect(keyless.status).toBe(400);
    expect((await keyless.json()).code).toBe("issuance_protocol_required");
    expect(Number((await db.query("SELECT COUNT(*) AS n FROM prescriptions WHERE patient_id=$1", [patient.id])).rows[0].n)).toBe(0);
    expect((await post("/api/prescriptions", { ...body, visitId: h.seeded.visitId })).status).toBe(400);
    // Direct requests cannot downgrade new issuance to legacy by deleting metadata.
    const { selection: _review, ...withoutReview } = body.items[0];
    for (const item of [withoutReview, { name: "SyntheticRxOnly" }, { ...withoutReview, dose: "" }]) {
      expect((await post("/api/prescriptions", { ...body, items: [item] })).status).toBe(400);
    }
    expect(Number((await db.query("SELECT COUNT(*) AS n FROM prescriptions WHERE patient_id=$1", [patient.id])).rows[0].n)).toBe(0);
    for (const field of ["form", "dose", "frequency", "duration"]) {
      expect((await post("/api/prescriptions", { ...body, items: [{ ...body.items[0], [field]: "" }] })).status).toBe(400);
    }
    for (const selection of [{ ...body.items[0].selection, amount: "" }, { ...body.items[0].selection, confirmed: false }, { ...body.items[0].selection, id: "untrusted" }]) {
      expect((await post("/api/prescriptions", { ...body, items: [{ ...body.items[0], selection }] })).status).toBe(400);
    }
    const created = await post("/api/prescriptions", body); expect(created.status).toBe(201); const { id } = await created.json();
    const replay = await post("/api/prescriptions", body);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(expect.objectContaining({ id, status: "active", replayed: true }));
    expect(Number((await db.query("SELECT COUNT(*) AS n FROM prescription_issuance_commands WHERE command_key=$1", [body.commandKey])).rows[0].n)).toBe(1);
    const recoveryPath = `/api/prescriptions/commands/${body.commandKey}?patientId=${patient.id}&visitId=${visit.id}&prescribingDoctorPartyId=${doctor.party_id}`;
    const recovered = await read(recoveryPath, "doctorA");
    expect(recovered.status).toBe(200);
    const cacheDirectives = recovered.headers.get("cache-control")?.split(",").map(value => value.trim().toLowerCase());
    expect(cacheDirectives).toContain("no-store"); expect(cacheDirectives).not.toContain("public");
    expect(await recovered.json()).toEqual(expect.objectContaining({ state: "completed", id, status: "active" }));
    expect((await read(recoveryPath, "reception")).status).toBe(403);
    expect((await read(recoveryPath, "doctorB")).status).toBe(403);
    const before = (await db.query("SELECT * FROM prescriptions WHERE id=$1", [id])).rows[0];
    expect((typeof before.items === "string" ? JSON.parse(before.items) : before.items)[0].selection).toEqual(body.items[0].selection);
    expect(before.visit_id).toBe(visit.id); expect(before.created_by).toBe("secdoctora"); expect(before.prescribing_doctor_party_id).toBe(doctor.party_id);
    const signed = await post(`/api/visits/${visit.id}/clinical`, { action: "sign" }); expect(signed.status, await signed.text()).toBe(200);
    expect((await db.query("SELECT signed_at FROM visits WHERE id=$1", [visit.id])).rows[0].signed_at).toBeTruthy();
    await setGrant(true);
    const listPath = `/api/patients/${patient.id}/prescriptions/saved?visitId=${visit.id}`;
    const listed = await read(listPath); expect(listed.status).toBe(200);
    const payload = await listed.json(); expect(payload.prescriptions).toEqual([expect.objectContaining({ id, visitId: visit.id, prescribingDoctorName: before.prescribing_doctor_name })]);
    expect(Object.keys(payload)).toEqual(["prescriptions", "nextCursor"]); expect(payload.nextCursor).toBeNull();
    expect(Object.keys(payload.prescriptions[0]).sort()).toEqual(["createdAt", "id", "prescribingDoctorName", "visitId"].sort());
    expect((await read(`/api/patients/${patient.id}/prescriptions`)).status).toBe(403);
    expect((await read(`/api/patients/${patient.id}/prescriptions/saved?visitId=${h.seeded.visitId}`)).status).toBe(404);
    // Existing reception scope is all patients; doctor B still cannot read this patient.
    expect((await read(listPath, "doctorB")).status).toBe(403);
    const printPath = `/print/prescription/${patient.id}?rx=${id}`;
    const html = await (await read(printPath)).text(); expect(html).toContain("SyntheticRxOnly"); expect(html).toContain("Synthetic amount only"); expect(html).toContain(before.prescribing_doctor_name);
    for (const path of [`/print/prescription/${patient.id}?draft=1&items=[]`, `/print/prescription/${patient.id}`, `/print/prescription/${h.seeded.patientBId}?rx=${id}`, `/print/prescription/${patient.id}?rx=99999999`]) expect((await read(path)).status).toBe(404);
    // A saved ID cannot legitimize draft payloads in URLs, even for clinicians/admins.
    // These requests use only this job's disposable synthetic patient and record.
    for (const role of ["doctorA", "admin"] as const) {
      for (const query of [
        { draft: "1", items: "[]" },
        { rx: String(id), draft: "1" }, { rx: String(id), items: "[]" },
        { rx: String(id), diagnosis: "Synthetic URL override" }, { rx: String(id), notes: "" },
      ] as Array<Record<string, string>>) {
        const response = await read(`/print/prescription/${patient.id}?${new URLSearchParams(query)}`, role);
        expect(response.status).toBe(404);
      }
      expect((await db.query("SELECT * FROM prescriptions WHERE id=$1", [id])).rows[0]).toEqual(before);
      expect(Number((await db.query("SELECT COUNT(*) AS n FROM prescriptions WHERE patient_id=$1", [patient.id])).rows[0].n)).toBe(1);
    }
    for (const method of ["POST", "PATCH"] as const) expect((await authedMutation("/api/prescriptions", h.sessions.reception, method, JSON.stringify({ ...body, prescribingDoctorPartyId: 999 }))).status).toBeGreaterThanOrEqual(400);
    expect((await post(`/api/prescriptions/${id}/void`, { reason: "forbidden" }, "reception")).status).toBe(403);
    expect((await post("/api/print-log", { docType: "prescription", docId: id, patientId: h.seeded.patientBId }, "reception")).status).toBe(404);
    expect((await post("/api/print-log", { docType: "prescription", docId: 99999999, patientId: patient.id }, "reception")).status).toBe(404);
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.reception.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    await context.addInitScript(() => { const w = window as typeof window & { syntheticPrintCount: number }; w.syntheticPrintCount = 0; window.print = () => { w.syntheticPrintCount++; }; });
    const page = await context.newPage();
    try {
      await mkdir(".settings-ui-artifacts/prescription-reprint", { recursive: true });
      for (const suffix of ["", `?tab=today&checkoutVisit=${visit.id}`]) {
        await page.goto(`${baseUrl}/patients/${patient.id}${suffix}`);
        await page.locator("summary").filter({ hasText: /^الوصفات المحفوظة(?: للزيارة #\d+)?$/ }).click();
        const link = page.getByRole("link", { name: "فتح الوصفة للطباعة", exact: true }); await link.waitFor(); expect(await link.getAttribute("href")).toBe(printPath);
        await page.screenshot({ path: `.settings-ui-artifacts/prescription-reprint/${suffix ? "checkout" : "patient"}.png`, fullPage: true });
      }
      await page.goto(`${baseUrl}${printPath}`);
      expect(await page.getByRole("button", { name: "اطبع", exact: true }).getAttribute("data-print-document-action")).not.toBeNull();
      await page.getByRole("button", { name: "اطبع", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as typeof window & { syntheticPrintCount: number }).syntheticPrintCount)).toBe(1);
      await setGrant(false); await page.getByRole("button", { name: "اطبع", exact: true }).click(); await page.getByRole("alert").waitFor();
      expect(await page.evaluate(() => (window as typeof window & { syntheticPrintCount: number }).syntheticPrintCount)).toBe(1);
      await page.screenshot({ path: ".settings-ui-artifacts/prescription-reprint/revoked-print.png", fullPage: true });
    } finally { await context.close(); }
    expect((await db.query("SELECT printed_by FROM document_prints WHERE doc_type='prescription' AND doc_id=$1", [String(id)])).rows).toEqual([{ printed_by: "secreception" }]);
    expect((await db.query("SELECT * FROM prescriptions WHERE id=$1", [id])).rows[0]).toEqual(before);
    expect(Number((await db.query("SELECT COUNT(*) AS n FROM prescriptions WHERE patient_id=$1", [patient.id])).rows[0].n)).toBe(1);
    await setGrant(true);
    const voided = await post(`/api/prescriptions/${id}/void`, { reason: "Synthetic cancellation after print verification" }); expect(voided.status, await voided.text()).toBe(200);
    expect((await (await read(listPath)).json()).prescriptions).toEqual([]);
    expect((await read(printPath)).status).toBe(404);
    expect((await post("/api/print-log", { docType: "prescription", docId: id, patientId: patient.id }, "reception")).status).toBe(404);
  } finally { await db.query("UPDATE users SET permissions=$1 WHERE id=$2", [reception.permissions, reception.id]); }
}, 120_000);


it("finds an older visit prescription beyond 50 newer records without crossing patient, visit or status", async () => {
  const { rows: [doctor] } = await db.query("SELECT party_id FROM users WHERE username='secdoctora'");
  const { rows: [reception] } = await db.query("SELECT id,permissions FROM users WHERE username='secreception'");
  const patient = (await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'Synthetic old Rx picker',$2) RETURNING id", [`RX-OLDER-${Date.now()}`, doctor.party_id])).rows[0].id;
  const oldVisit = (await db.query("INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES($1,'Old visit',$2) RETURNING id", [patient, doctor.party_id])).rows[0].id;
  const newerVisit = (await db.query("INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES($1,'Newer visit',$2) RETURNING id", [patient, doctor.party_id])).rows[0].id;
  const oldRx = (await db.query("INSERT INTO prescriptions(patient_id,visit_id,items,created_by,prescribing_doctor_name,created_at) VALUES($1,$2,'[{\"name\":\"SyntheticLegacyRx\"}]','synthetic-fixture','Original old doctor','2020-01-01T00:00:00Z') RETURNING id", [patient, oldVisit])).rows[0].id;
  await db.query("INSERT INTO prescriptions(patient_id,visit_id,items,created_by,created_at) SELECT $1,$2,'[]','synthetic-fixture','2026-01-01T00:00:00.000123Z'::timestamptz FROM generate_series(1,60) n", [patient, newerVisit]);
  await db.query("INSERT INTO prescriptions(patient_id,visit_id,items,created_by,status) VALUES($1,$2,'[]','synthetic-void','void'),($3,$4,'[]','synthetic-other','active')", [patient, oldVisit, h.seeded.patientBId, h.seeded.visitId]);
  try {
    // Synthetic fixture grant only; restore exact prior value in finally.
    await db.query("UPDATE users SET permissions=$1 WHERE id=$2", [{ ...(reception.permissions ?? {}), canPrintSavedPrescriptions: true }, reception.id]);
    const legacyBefore = (await db.query("SELECT * FROM prescriptions WHERE id=$1", [oldRx])).rows[0];
    const legacyPrint = await read(`/print/prescription/${patient}?rx=${oldRx}`);
    expect(legacyPrint.status).toBe(200);
    expect(await legacyPrint.text()).toContain("SyntheticLegacyRx");
    expect((await db.query("SELECT * FROM prescriptions WHERE id=$1", [oldRx])).rows[0]).toEqual(legacyBefore);
    const response = await read(`/api/patients/${patient}/prescriptions/saved?visitId=${oldVisit}`); expect(response.status).toBe(200);
    expect((await response.json()).prescriptions).toEqual([{ id: oldRx, visitId: oldVisit, createdAt: "2020-01-01T00:00:00.000Z", prescribingDoctorName: "Original old doctor" }]);
    const newest = await (await read(`/api/patients/${patient}/prescriptions/saved?visitId=${newerVisit}`)).json();
    expect(newest.prescriptions).toHaveLength(50); expect(newest.prescriptions.every((rx: { visitId: number }) => rx.visitId === newerVisit)).toBe(true);
    expect((await read(`/api/patients/${h.seeded.patientBId}/prescriptions/saved?visitId=${oldVisit}`)).status).toBe(404);
    const firstPage = await (await read(`/api/patients/${patient}/prescriptions/saved`)).json();
    expect(firstPage.prescriptions).toHaveLength(50); expect(firstPage.nextCursor).toEqual(expect.any(String));
    // Newer inserts do not shift the keyset or duplicate rows on the next page.
    const inserted = (await db.query("INSERT INTO prescriptions(patient_id,visit_id,items,created_by,created_at) VALUES($1,$2,'[]','synthetic-new','2026-10-30T10:00:00Z') RETURNING id", [patient, newerVisit])).rows[0].id;
    const nextUrl = `/api/patients/${patient}/prescriptions/saved?cursor=${firstPage.nextCursor}`;
    const secondPage = await (await read(nextUrl)).json();
    expect(secondPage.prescriptions).toHaveLength(11); expect(secondPage.nextCursor).toBeNull();
    const ids = [...firstPage.prescriptions, ...secondPage.prescriptions].map((rx: { id: number }) => rx.id);
    expect(new Set(ids).size).toBe(61); expect(ids).toContain(oldRx); expect(ids).not.toContain(inserted);
    expect((await read(nextUrl, "doctorB")).status).toBe(403);
    expect((await read(`/api/patients/${h.seeded.patientBId}/prescriptions/saved?cursor=${firstPage.nextCursor}`)).status).toBe(400);
    expect((await read(`/api/patients/${patient}/prescriptions/saved?visitId=${newerVisit}&cursor=${firstPage.nextCursor}`)).status).toBe(400);
    expect((await read(`/api/patients/${patient}/prescriptions/saved?cursor=invalid`)).status).toBe(400);
    await db.query("UPDATE users SET permissions=$1 WHERE id=$2", [{ ...(reception.permissions ?? {}), canPrintSavedPrescriptions: false }, reception.id]);
    expect((await read(nextUrl)).status).toBe(403);
    await db.query("UPDATE users SET permissions=$1 WHERE id=$2", [{ ...(reception.permissions ?? {}), canPrintSavedPrescriptions: true }, reception.id]);
    const context = await browser.newContext();
    try {
      const pair = h.sessions.reception.cookie.split(";")[0], split = pair.indexOf("=");
      await context.addCookies([{ name: pair.slice(0, split), value: pair.slice(split + 1), url: baseUrl }]);
      const page = await context.newPage(); await page.goto(`${baseUrl}/patients/${patient}`);
      const picker = page.locator("details").filter({ has: page.locator("summary", { hasText: "الوصفات المحفوظة" }) });
      await picker.locator("summary").click();
      await expect.poll(() => picker.getByRole("link", { name: "فتح الوصفة للطباعة" }).count()).toBe(50);
      await page.route("**/prescriptions/saved?cursor=*", route => route.abort("failed"), { times: 1 });
      await picker.getByRole("button", { name: "تحميل المزيد من الوصفات" }).click();
      await picker.getByRole("alert").waitFor();
      expect(await picker.getByRole("link", { name: "فتح الوصفة للطباعة" }).count()).toBe(50);
      await expect.poll(() => picker.getByRole("button", { name: "تحميل المزيد من الوصفات" }).isEnabled()).toBe(true);
      await picker.getByRole("button", { name: "تحميل المزيد من الوصفات" }).click();
      await expect.poll(() => picker.getByRole("link", { name: "فتح الوصفة للطباعة" }).count()).toBe(62);
      expect(await picker.getByRole("link", { name: "فتح الوصفة للطباعة" }).last().getAttribute("href")).toBe(`/print/prescription/${patient}?rx=${oldRx}`);
      expect(await picker.getByRole("button", { name: "تحميل المزيد من الوصفات" }).count()).toBe(0);
    } finally { await context.close(); }
    expect(Number((await db.query("SELECT COUNT(*) AS n FROM prescriptions WHERE patient_id=$1", [patient])).rows[0].n)).toBe(63);
  } finally { await db.query("UPDATE users SET permissions=$1 WHERE id=$2", [reception.permissions, reception.id]); }
}, 120_000);

it("actual PG catalogue detector keeps unrelated binding artifacts legacy and quarantines any canonical footprint", async () => {
  const { readStaffEntryMode } = await import("../../lib/legacy-staff-schema.mjs");
  const schema = "aqlan_identity_1234567890abcdef";
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`CREATE TABLE ${schema}.users(id int); CREATE TABLE ${schema}.parties(id int); CREATE TABLE ${schema}.clinic_owner_binding_state(id int)`);
    expect(await readStaffEntryMode(db, schema)).toBe("legacy");
    await db.query(`CREATE TABLE ${schema}.staff_authority_control(id int)`);
    expect(await readStaffEntryMode(db, schema)).toBe("canonical");
    await db.query(`DROP TABLE ${schema}.staff_authority_control; ALTER TABLE ${schema}.users ADD COLUMN authorization_epoch bigint`);
    expect(await readStaffEntryMode(db, schema)).toBe("canonical");
    await db.query(`ALTER TABLE ${schema}.users DROP COLUMN authorization_epoch; CREATE FUNCTION ${schema}.staff_restore_hold_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`);
    expect(await readStaffEntryMode(db, schema)).toBe("canonical");
    await db.query(`ALTER FUNCTION ${schema}.staff_restore_hold_guard() RENAME TO synthetic_guard; CREATE TRIGGER staff_restore_hold_guard_row BEFORE INSERT ON ${schema}.users FOR EACH ROW EXECUTE FUNCTION ${schema}.synthetic_guard()`);
    expect(await readStaffEntryMode(db, schema)).toBe("canonical");
    await db.query(`DROP TRIGGER staff_restore_hold_guard_row ON ${schema}.users`);
    expect(await readStaffEntryMode(db, schema)).toBe("legacy");
  } finally { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
});

it.each(['amoxicillin','ibuprofen'] as const)('built %s dose-profile picker issues one snapshot, recovers and preserves reception saved printing before and after closure', async ingredient => {
  const ibu=ingredient==='ibuprofen',amount=ibu?'7.5 mL (150 mg)':'4 mL (200 mg)';
  const doctor=(await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0];
  const reception=(await db.query("SELECT id,permissions FROM users WHERE username='secreception'")).rows[0];
  const patient=(await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'مريض جرعة اصطناعي',$2) RETURNING id",[`DOSE-RX-${Date.now()}`,doctor.party_id])).rows[0];
  const visit=(await db.query("INSERT INTO visits(patient_id,patient_name,doctor_id,diagnosis) VALUES($1,'مريض جرعة اصطناعي',$2,'Synthetic dose review') RETURNING id",[patient.id,doctor.party_id])).rows[0];
  const context=await browser.newContext({viewport:{width:1280,height:1000},locale:'ar-YE'});
  const receiveContext=await browser.newContext({viewport:{width:1280,height:1000},locale:'ar-YE'});
  const addSession=async (target:typeof context,role:'doctorA'|'reception')=>{const pair=h.sessions[role].cookie.split(';')[0],split=pair.indexOf('=');await target.addCookies([{name:pair.slice(0,split),value:pair.slice(split+1),url:baseUrl}]);};
  try {
    await addSession(context,'doctorA');await addSession(receiveContext,'reception');
    await context.addInitScript(()=>{window.print=()=>{};});
    const page=await context.newPage();await page.goto(`${baseUrl}/visits/${visit.id}`);
    await page.getByRole('button',{name:'💊 روشتة طبية (℞)',exact:true}).click();
    expect(await page.getByLabel('اسم الدواء للسطر 1',{exact:true}).inputValue()).toBe('');
    expect(await page.getByPlaceholder('Drug name',{exact:true}).count()).toBe(1);
    await page.locator('details[data-prescription-optional="references"] > summary').click();
    await page.locator('summary').filter({hasText:'الجرعات والتعليمات حسب الاستطباب والمرجع'}).click();
    await page.getByLabel('الملف المرجعي للجرعة',{exact:true}).selectOption(ibu?'ibuprofen-child-sdcep':'amoxicillin-child-aapd-q8');
    for(const [label,value] of Object.entries({'الاستطباب المراجع':'Synthetic clinician-reviewed indication','العمر بأشهر مكتملة من تاريخ الميلاد':'60','الوزن الحالي kg':'20',[ibu?'المقدار المختار mg/dose':'المقدار المختار mg/kg/day']:ibu?'150':'30','عدد الجرعات خلال24ساعة':'3','الفاصل الأدنى بالساعات':'8','المدة المختارة بالأيام':'5','خطة المراجعة والإيقاف':'Synthetic review and stop plan','اسم المستحضر الفعلي':'Synthetic suspension','قوة المنتج mg':ibu?'100':'250','رابط نشرة المستحضر HTTPS':'https://synthetic.invalid/product-label','أدنى عمر للمنتج بالأشهر وفق النشرة':ibu?'6':'4','المادة نفسها من جميع المصادر الأخرى mg/24h — اكتب0 بعد التحقق':'0'}))await page.getByLabel(label,{exact:true}).fill(value);
    await page.getByLabel('مادة المنتج',{exact:true}).selectOption(ingredient);
    await page.getByLabel('الشكل والطريق',{exact:true}).selectOption('oral-liquid');
    await page.getByLabel('حجم المقام mL بعد التحضير',{exact:true}).fill('5');await page.getByLabel('تدريج أداة القياس mL',{exact:true}).fill('0.1');
    if(ibu){await page.getByLabel('أقل فاصل بالساعات من نشرة المنتج',{exact:true}).fill('6');await page.getByLabel('أقصى عدد جرعات خلال24ساعة من نشرة المنتج',{exact:true}).fill('3');}
    for(const label of ['تحققت من العمر الدقيق؛ لم أستنتجه من سنة الميلاد فقط','تحققت من الوزن الحالي لهذا المريض','راجعت المادة والشكل والقوة وعمر المنتج وأداة القياس من النشرة الفعلية','راجعت الحساسية والتداخلات والحالات الخاصة؛ لا تحتاج الحالة تعديلًا خارج هذا الملف',...(ibu?[]:['قررت استطباب المضاد ومعالجة السبب؛ لا مضاد تلقائي للألم أو الخلع'])])await page.getByLabel(label,{exact:true}).check();
    const confirm=page.getByLabel('راجعت هذه المدخلات والنتيجة والتعليمات لهذا المريض',{exact:true});
    const add=page.getByRole('button',{name:'نقل الجرعة والتعليمات إلى مسودة غير مؤكدة',exact:true});
    await expect.poll(()=>page.locator('[data-dose-form]').innerText()).toContain(amount);
    await confirm.check();await page.getByLabel('الوزن الحالي kg',{exact:true}).fill('21');expect(await confirm.isChecked()).toBe(false);expect(await add.isDisabled()).toBe(true);
    await page.getByLabel('الوزن الحالي kg',{exact:true}).fill('20');await confirm.check();await page.getByLabel('قوة المنتج mg',{exact:true}).fill(ibu?'50':'125');expect(await confirm.isChecked()).toBe(false);await expect.poll(()=>page.locator('[data-dose-form]').innerText()).toContain(ibu?'15 mL (150 mg)':'8 mL (200 mg)');
    await page.getByLabel('قوة المنتج mg',{exact:true}).fill(ibu?'100':'250');await confirm.check();await add.click();
    // The calculated selection replaces the pristine blank row, not a second row.
    expect(await page.getByPlaceholder('Drug name',{exact:true}).count()).toBe(1);
    expect(await page.getByLabel('مقدار الجرعة للسطر 1',{exact:true}).inputValue()).toBe(amount);
    await page.getByLabel('راجعت الاستطباب والحساسية والشكل والتركيز والجرعة والتكرار والمدة لهذا السطر. هذا لا يلغي تنبيهات السلامة.',{exact:true}).check();
    const waitResponse=()=>page.waitForResponse(r=>new URL(r.url()).pathname==='/api/prescriptions'&&r.request().method()==='POST');
    let pending=waitResponse();await page.getByRole('button',{name:'حفظ وطباعة الوصفة (A6)',exact:true}).click();let response=await pending;
    if(response.status()===200){const preview=await response.json();expect(preview.requiresAcknowledgement).toBe(true);pending=waitResponse();await page.getByRole('button',{name:'أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا',exact:true}).click();response=await pending;}
    expect(response.status(),await response.text()).toBe(201);const saved=await response.json();const command=response.request().postDataJSON();
    const before=(await db.query('SELECT * FROM prescriptions WHERE id=$1',[saved.id])).rows[0];
    const items=typeof before.items==='string'?JSON.parse(before.items):before.items;
    expect(items[0]).toMatchObject({dose:ibu?'100 mg/5 mL':'250 mg/5 mL',frequency:ibu?'3 times daily; at least 8 hours apart':'Every 8 hours (3 doses/24h)',selection:{amount,doseReview:{version:ibu?2:1,mode:'calculated',input:{ageMonths:60,weightKg:20,product:{strengthMg:ibu?100:250,perMl:5,...(ibu?{minimumIntervalHours:6,maxAdministrationsPer24h:3}:{})}},result:{mgPerDose:ibu?150:200,mgPer24h:ibu?450:600,mlPerDose:ibu?7.5:4}}}});
    if(ibu){expect(items[0].instructionsEn).toContain('Preferably after food.');expect(items[0].frequency).toContain('at least 8 hours apart');}
    expect(before.created_by).toBe('secdoctora');expect(before.prescribing_doctor_party_id).toBe(doctor.party_id);
    const replay=await post('/api/prescriptions',command);expect(replay.status).toBe(201);expect(await replay.json()).toMatchObject({id:saved.id,replayed:true});
    const recovered=await read(`/api/prescriptions/commands/${command.commandKey}?patientId=${patient.id}&visitId=${visit.id}&prescribingDoctorPartyId=${doctor.party_id}`,'doctorA');expect(recovered.status).toBe(200);expect(await recovered.json()).toMatchObject({id:saved.id,state:'completed'});
    // Fixture-only print grant, restored exactly; never an application grant shortcut.
    await db.query('UPDATE users SET permissions=$1 WHERE id=$2',[{...(reception.permissions??{}),canPrintSavedPrescriptions:true},reception.id]);
    const printPath=`/print/prescription/${patient.id}?rx=${saved.id}`;
    expect((await read(printPath)).status).toBe(200);
    const sign=await post(`/api/visits/${visit.id}/clinical`,{action:'sign'});expect(sign.status,await sign.text()).toBe(200);
    const received=await read(printPath);expect(received.status).toBe(200);const html=await received.text();expect(html).toContain(amount);if(ibu){expect(html).toContain('Preferably after food.');expect(html).toContain('at least 8 hours apart');}for(const secret of ['weightKg','product-label','data-dose-form'])expect(html).not.toContain(secret);
    const receptionPage=await receiveContext.newPage();await receptionPage.goto(`${baseUrl}/patients/${patient.id}`);expect(await receptionPage.locator('[data-dose-profile-review]').count()).toBe(0);
    await receptionPage.goto(`${baseUrl}${printPath}`);await mkdir('.settings-ui-artifacts/prescription-dose',{recursive:true});await receptionPage.screenshot({path:`.settings-ui-artifacts/prescription-dose/saved-${ingredient}-calculated.png`,fullPage:true});await receptionPage.pdf({path:`.settings-ui-artifacts/prescription-dose/saved-${ingredient}-calculated.pdf`,preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});
    expect((await read(`/print/prescription/${patient.id}?draft=1&items=[]`)).status).toBe(404);
    expect((await db.query('SELECT * FROM prescriptions WHERE id=$1',[saved.id])).rows[0]).toEqual(before);
    expect(Number((await db.query('SELECT count(*) n FROM prescriptions WHERE patient_id=$1',[patient.id])).rows[0].n)).toBe(1);
  } finally {await context.close();await receiveContext.close();await db.query('UPDATE users SET permissions=$1 WHERE id=$2',[reception.permissions,reception.id]);}
},180_000);

