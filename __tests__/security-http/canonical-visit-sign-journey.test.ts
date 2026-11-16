/**
 * M2 slice 86 — canonical visit signing with the owner's decisions 6629149113, built
 * application, owned database and server. Synthetic data only.
 *
 * HTTP: a clinician with the sign grant signs a priced visit (no money in the reply,
 * no-store); the case doctor's "no charge" is refused while the owner's setting is off
 * (403, Arabic, nothing signed); the owner turns ortho.case_doctor_no_charge on through
 * the canonical settings route (audited). Browser at 390px: the case doctor ticks
 * "no charge", writes the reason and signs; the decision, the reason, the decider and the
 * basis are audited. No DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const SIGN = { "clinical.visits.document": true, "clinical.visits.sign": true };
const ACCOUNTS = {
  owner: { username: "canon-vs-owner", password: "Canon#VsOwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-vs-dr", password: "Canon#VsDoctor1", role: "doctor", display: "طبيب التوقيع", doctor: true, patientScope: "all", grants: SIGN },
  caseDoctor: { username: "canon-vs-case", password: "Canon#VsCase1", role: "doctor", display: "طبيب الحالة", doctor: true, patientScope: "all",
    grants: { ...SIGN, "clinical.ortho.view": true, "clinical.ortho.edit": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { plain: 0, plainPatient: 0, ortho: 0, adjustment: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 146, secret: "canonical-visit-sign-journey-secret-0123456789abcd", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      const patient = async (number: string, name: string) => (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES ($1,$2) RETURNING id", [number, name])).rows[0].id;
      const service = (await db.query<{ id: number }>("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('تحضير تاج تجريبي',31000,TRUE,TRUE,'restorative') RETURNING id")).rows[0].id;
      await db.query("INSERT INTO services (name, category, price_minor, price_configured) VALUES ('شدّة تقويم (زيارة)', 'ortho', 10000, TRUE)");
      ids.plainPatient = await patient("SYN-VSJ-1", "مريض توقيع تجريبي");
      ids.plain = (await db.query<{ id: number }>("INSERT INTO visits (patient_name, patient_id, doctor_id) VALUES ('مريض توقيع تجريبي',$1,$2) RETURNING id", [ids.plainPatient, parties.doctor])).rows[0].id;
      await db.query("INSERT INTO visit_procedures (visit_id, service_id, quantity, unit_price_minor, tooth_code, doctor_id) VALUES ($1,$2,1,31000,46,$3)", [ids.plain, service, parties.doctor]);
      const orthoPatient = await patient("SYN-VSJ-2", "مريض تقويم تجريبي");
      const kase = (await db.query<{ id: number }>(`INSERT INTO ortho_cases (patient_id, created_by, baseline_kind, baseline_recorded_at, legacy_financial_mode, responsible_doctor_id)
        VALUES ($1,'migration','legacy',NOW(),'per_session',$2) RETURNING id`, [orthoPatient, parties.caseDoctor])).rows[0].id;
      ids.ortho = (await db.query<{ id: number }>("INSERT INTO visits (patient_name, patient_id, doctor_id, diagnosis) VALUES ('مريض تقويم تجريبي',$1,$2,'متابعة تقويم') RETURNING id", [orthoPatient, parties.caseDoctor])).rows[0].id;
      ids.adjustment = (await db.query<{ id: number }>("INSERT INTO ortho_adjustments (case_id, visit_id, done, recorded_by) VALUES ($1,$2,'شدّة اصطناعية','SYN') RETURNING id", [kase, ids.ortho])).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

const post = (visitId: number, cookie: string, body: Record<string, unknown>) =>
  journey.api(`/api/visits/${visitId}/clinical`, cookie, { method: "POST", body: JSON.stringify(body) });

it("HTTP: signing, the case doctor refused while the setting is off, the owner turns it on", async () => {
  const doctor = await journey.login("doctor");
  const signed = await post(ids.plain, doctor.cookie, { action: "sign" });
  expect(signed.status).toBe(200);
  expect(signed.headers.get("cache-control")).toContain("no-store");
  const body = await signed.json();
  expect(body).toMatchObject({ id: ids.plain, status: "signed" });
  expect(JSON.stringify(body)).not.toMatch(/invoiceId|duesMinor|unitPriceMinor|totalMinor|31000/);
  expect((await journey.db.query("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1", [ids.plainPatient])).rows[0].n).toBe(1);

  const caseDoctor = await journey.login("caseDoctor");
  const refused = await post(ids.ortho, caseDoctor.cookie, { action: "sign", outsideContractDecision: { decision: "no_charge", reason: "رفض متوقع" } });
  expect(refused.status).toBe(403);
  expect((await refused.json()).message).toMatch(ARABIC);
  expect((await journey.db.query("SELECT signed_at FROM visits WHERE id=$1", [ids.ortho])).rows[0].signed_at).toBeNull();

  const owner = await journey.login("owner");
  const read = await (await journey.api("/api/settings", owner.cookie)).json();
  expect(read.__canWrite).toContain("ortho.case_doctor_no_charge");
  expect(read["ortho.case_doctor_no_charge"]).toBe("false");
  const patch = await journey.api("/api/settings", owner.cookie, { method: "PATCH", body: JSON.stringify({
    "ortho.case_doctor_no_charge": "true", __versions: { "ortho.case_doctor_no_charge": read.__versions?.["ortho.case_doctor_no_charge"] ?? null }, __reason: "تفويض طبيب الحالة اصطناعيًا" }) });
  expect(patch.status).toBe(200);
  expect((await journey.db.query("SELECT value FROM settings WHERE key='ortho.case_doctor_no_charge'")).rows[0].value).toBe("true");
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the case doctor signs with \"no charge\" and a reason (390px); decision and decider audited", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  await journey.browserLogin(page, "caseDoctor");
  const failures: string[] = [];
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await page.goto(`${journey.baseUrl}/visits/${ids.ortho}`);
  const sign = page.getByTestId("canonical-visit-sign");
  await sign.getByLabel("«بلا رسوم» لشدّة هذه الزيارة إن كانت خارج الاتفاق").check();
  await sign.getByLabel("سبب «بلا رسوم» (يُسجَّل في التدقيق)").fill("متابعة مجانية بعد كسر سلك");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await sign.getByRole("button", { name: "توقيع الزيارة" }).click();
  await page.getByTestId("canonical-visit-notice").getByText("وُقّعت الزيارة.").waitFor();
  await page.getByTestId("canonical-visit-status").getByText(/موقَّعة/).waitFor();
  expect(failures).toEqual([]);
  expect((await journey.db.query("SELECT billing_decision FROM ortho_adjustments WHERE id=$1", [ids.adjustment])).rows[0].billing_decision).toBe("no_charge");
  const [audit] = (await journey.db.query("SELECT actor, details FROM audit_log WHERE action='visit.sign' AND entity_id=$1::text", [ids.ortho])).rows;
  expect(audit).toMatchObject({ actor: "canon-vs-case", details: { قرار_الشدّة: "بلا رسوم", سبب_القرار: "متابعة مجانية بعد كسر سلك", متخذ_القرار: "canon-vs-case" } });
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});
