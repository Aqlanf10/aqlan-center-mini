/**
 * M2 slice 79 — canonical patient merge and delete, built application, owned database and
 * server. Synthetic data only.
 *
 * - HTTP: the merger merges a duplicate (audit, source gone); a file with financial history
 *   is refused in Arabic without financial counts for an actor without the ledger grant;
 *   an editor without the grant is refused (403); outside the scope reads as missing.
 * - Browser: the deleter deletes a file registered by mistake from the canonical file at
 *   390px and lands on the patient list; no failed API call; no DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-life-owner", password: "Canon#LifeOwner1", role: "admin", display: "المالك التجريبي" },
  merger: { username: "canon-life-merge", password: "Canon#LifeMerge1", role: "reception", display: "مسؤول الدمج", patientScope: "all",
    grants: { "patients.edit": true, "patients.merge": true } },
  deleter: { username: "canon-life-del", password: "Canon#LifeDel1", role: "reception", display: "مسؤول الحذف", patientScope: "all",
    grants: { "patients.edit": true, "patients.delete": true } },
  doctor: { username: "canon-life-doc", password: "Canon#LifeDoc1", role: "doctor", display: "د. ملفات تجريبي", doctor: true, patientScope: "own",
    grants: { "patients.edit": true, "patients.delete": true } },
  editor: { username: "canon-life-edit", password: "Canon#LifeEdit1", role: "reception", display: "محرر", patientScope: "all", grants: { "patients.edit": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { target: 0, source: 0, money: 0, mistaken: 0 };

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 134, secret: "canonical-patient-lifecycle-journey-secret-012345", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db) {
      const patient = async (number: string, name: string) =>
        (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ($1,$2,'0500000971') RETURNING id", [number, name])).rows[0].id;
      ids.target = await patient("SYN-LJ-T", "مريض أصلي تجريبي");
      ids.source = await patient("SYN-LJ-S", "مريض مكرر تجريبي");
      ids.money = await patient("SYN-LJ-M", "مريض برصيد تجريبي");
      ids.mistaken = await patient("SYN-LJ-X", "ملف خاطئ تجريبي");
      await db.query("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,'SAR',4000,'2026-01-01','SYN')", [ids.money]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: merge with audit; financial refusal without counts; grants and scope", async () => {
  const merger = await journey.login("merger");
  const merged = await journey.api(`/api/patients/${ids.target}/merge`, merger.cookie, { method: "POST",
    body: JSON.stringify({ duplicatePatientNumber: "SYN-LJ-S", confirmDuplicateNumber: "SYN-LJ-S", reason: "مكرر اصطناعي" }) });
  expect(merged.status).toBe(200);
  expect(merged.headers.get("cache-control")).toContain("no-store");
  expect((await merged.json()).patient).toMatchObject({ id: ids.target });
  expect((await journey.db.query("SELECT count(*)::int AS n FROM patients WHERE id=$1", [ids.source])).rows[0].n).toBe(0);
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='patient.merge' AND entity_id=$1::text", [ids.target])).rows.map(row => row.actor)).toEqual(["canon-life-merge"]);

  const deleter = await journey.login("deleter");
  const money = await journey.api(`/api/patients/${ids.money}`, deleter.cookie, { method: "DELETE", body: JSON.stringify({ confirmPatientNumber: "SYN-LJ-M" }) });
  expect(money.status).toBe(409);
  const refusal = await money.json();
  expect(refusal.message).toMatch(ARABIC);
  expect(refusal).not.toHaveProperty("counts");

  const editor = await journey.login("editor");
  const denied = await journey.api(`/api/patients/${ids.mistaken}`, editor.cookie, { method: "DELETE", body: JSON.stringify({ confirmPatientNumber: "SYN-LJ-X" }) });
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);

  const doctor = await journey.login("doctor");
  const outside = await journey.api(`/api/patients/${ids.mistaken}`, doctor.cookie, { method: "DELETE", body: JSON.stringify({ confirmPatientNumber: "SYN-LJ-X" }) });
  expect(outside.status).toBe(404);
  expect((await outside.json()).message).toMatch(ARABIC);
  expect((await journey.db.query("SELECT count(*)::int AS n FROM patients WHERE id = ANY($1::int[])", [[ids.money, ids.mistaken]])).rows[0].n).toBe(2);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the deleter deletes a mistaken file at 390px and lands on the list", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  await journey.browserLogin(page, "deleter");
  const failures: string[] = [];
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  await page.goto(`${journey.baseUrl}/patients/${ids.mistaken}`);
  const section = page.getByTestId("canonical-patient-lifecycle");
  await section.locator("summary").click();
  expect(await section.getByRole("form", { name: "دمج ملف مكرر" }).count()).toBe(0);
  const form = section.getByRole("form", { name: "حذف الملف" });
  await form.getByLabel("رقم الملف للتأكيد").fill("SYN-LJ-X");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await form.getByRole("button", { name: "حذف الملف نهائيًا" }).click();
  await page.waitForURL(url => new URL(url).pathname === "/patients");
  expect(failures).toEqual([]);
  expect((await journey.db.query("SELECT count(*)::int AS n FROM patients WHERE id=$1", [ids.mistaken])).rows[0].n).toBe(0);
  expect((await journey.db.query("SELECT actor FROM audit_log WHERE action='patient.delete' AND entity_id=$1::text", [ids.mistaken])).rows.map(row => row.actor)).toEqual(["canon-life-del"]);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});
