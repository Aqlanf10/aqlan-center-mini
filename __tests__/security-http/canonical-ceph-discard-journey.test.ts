import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ANALYZE = { "clinical.xrays.view": true, "clinical.ceph.analyze": true };
const ACCOUNTS = {
  owner: { username: "canon-discard-owner", password: "Canon#DiscardOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-discard-own", password: "Canon#DiscardOwn1", role: "doctor", doctor: true, display: "طبيب تجريبي", patientScope: "own", grants: ANALYZE },
  all: { username: "canon-discard-all", password: "Canon#DiscardAll1", role: "reception", display: "محلل تجريبي", patientScope: "all", grants: ANALYZE },
  read: { username: "canon-discard-read", password: "Canon#DiscardRead1", role: "admin", display: "قارئ صور", patientScope: "all", grants: { "clinical.xrays.view": true } },
  none: { username: "canon-discard-none", password: "Canon#DiscardNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: ANALYZE },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>, sequence = 0;
let patientId: number, studyId: number;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 64, secret: "canonical-ceph-discard-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed() {} });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
beforeEach(async () => {
  patientId = Number((await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN correction patient',$2) RETURNING id", [`SYN-CEPH-DISCARD-${++sequence}`, journey.parties.own])).rows[0].id);
  studyId = (await seedCanonicalCeph(journey.db, { patientId })).id;
  await journey.db.query("UPDATE ceph_analyses SET status='draft',completed_at=NULL,completed_by=NULL WHERE id=$1", [studyId]);
  await journey.db.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'SYN_OLD_CODE',1.25,2.75,'manual','SYN original')", [studyId]);
});
const discard = (cookie: string, id: number, body: unknown) => journey.api(`/api/ceph/${id}`, cookie, {
  method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
it("HTTP: scoped analyst can discard an observed draft without deleting its history", async () => {
  const session = await journey.login("own");
  const read = await journey.api(`/api/ceph/${studyId}`, session.cookie); expect(read.status).toBe(200);
  const saved = await read.json();
  const response = await discard(session.cookie, studyId, { expectedVersion: saved.discardVersion, note: "SYN incorrect draft" });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, studyId, status: "discarded" });
  expect((await journey.db.query("SELECT status,note FROM ceph_analyses WHERE id=$1", [studyId])).rows).toEqual([{ status: "discarded", note: "SYN incorrect draft" }]);
});

const audits = async () => Number((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='ceph.discard' AND entity_id=$1", [String(studyId)])).rows[0].n);
const state = async () => (await journey.db.query("SELECT status FROM ceph_analyses WHERE id=$1", [studyId])).rows[0].status;
async function version(cookie: string, id = studyId) {
  const response = await journey.api(`/api/ceph/${id}`, cookie); expect(response.status).toBe(200);
  const body = await response.json(); expect(body.discardVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(body)).not.toMatch(/revision|location|xmin|ctid/); return body.discardVersion as string;
}
it.each(["owner", "all"] as const)("HTTP: %s receives a minimal no-store acknowledgment", async key => {
  const cookie = (await journey.login(key)).cookie, response = await discard(cookie, studyId, { expectedVersion: await version(cookie), note: null });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(Object.keys(await response.json()).sort()).toEqual(["ok", "status", "studyId"]); expect(await audits()).toBe(1); expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: none, read-only, anonymous and foreign scope deny without broadening access", async () => {
  const owner = (await journey.login("owner")).cookie, expectedVersion = await version(owner);
  expect((await discard("", studyId, { expectedVersion, note: null })).status).toBe(401);
  for (const key of ["read", "none"] as const) expect((await discard((await journey.login(key)).cookie, studyId, { expectedVersion, note: null })).status).toBe(403);
  await journey.db.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [patientId]);
  const own = (await journey.login("own")).cookie, foreign = await discard(own, studyId, { expectedVersion, note: null }), missing = await discard(own, 2147483647, { expectedVersion, note: null });
  expect(foreign.status).toBe(404); expect(missing.status).toBe(404); expect(await foreign.json()).toEqual(await missing.json()); expect(await state()).toBe("draft"); expect(await audits()).toBe(0);
});
it("HTTP: rejects malformed bodies, invalid versions and extra authority fields", async () => {
  const cookie = (await journey.login("own")).cookie, expectedVersion = await version(cookie);
  for (const body of [null, [], false, 0, {}, { expectedVersion }, { expectedVersion, note: {} }, { expectedVersion: [expectedVersion], note: null }, { expectedVersion, note: "x".repeat(4001) }, { expectedVersion, note: null, actor: "owner" }, { expectedVersion, note: null, force: true }]) expect((await discard(cookie, studyId, body)).status).toBe(400);
  expect((await journey.api(`/api/ceph/${studyId}?force=1`, cookie, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion, note: null }) })).status).toBe(400);
  expect(await state()).toBe("draft"); expect(await audits()).toBe(0);
});
it("HTTP: completed and child-edited studies refuse a stale intent without changing the history", async () => {
  const cookie = (await journey.login("own")).cookie, expectedVersion = await version(cookie);
  await journey.db.query("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1", [studyId]);
  expect((await discard(cookie, studyId, { expectedVersion, note: null })).status).toBe(409);
  await journey.db.query("UPDATE ceph_analyses SET status='completed',completed_at=NOW(),completed_by='SYN other' WHERE id=$1", [studyId]);
  expect((await discard(cookie, studyId, { expectedVersion, note: null })).status).toBe(409); expect(await state()).toBe("completed"); expect(await audits()).toBe(0);
});
async function openDiscard(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "own", signed = false, arm = true) {
  page.setDefaultTimeout(10000); if (!signed) await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  await page.getByRole("button", { name: "عرض دراسات السيفالومتري", exact: true }).click();
  const editor = page.getByTestId("canonical-ceph-discard"); await editor.waitFor();
  if (arm) { await editor.getByRole("button", { name: "مراجعة رفض المسودة الحالية", exact: true }).click(); await editor.getByLabel("ملاحظة الرفض (اختيارية)").waitFor(); }
  return editor;
}
it("browser: 390px explicit discard survives rapid double-click with one effect and no stored note", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(), editor = await openDiscard(page); let sends = 0;
    page.on("request", r => { if (r.method() === "DELETE" && new URL(r.url()).pathname === `/api/ceph/${studyId}`) sends++; });
    await editor.getByLabel("ملاحظة الرفض (اختيارية)").fill("SYN private discard note");
    if (process.env.HR_EVIDENCE_DIR) { mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await editor.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ceph-discard-390.png") }); }
    await editor.getByRole("button", { name: "تأكيد رفض المسودة", exact: true }).evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
    await page.getByText("رُفضت المسودة وسُجّل أثرها؛ بقيت بياناتها محفوظة.", { exact: true }).waitFor();
    expect(sends).toBe(1); expect(await audits()).toBe(1); expect(await state()).toBe("discarded");
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith("aqlan.ceph-discard.pending:")))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { await context.close(); }
});
it("browser: imaging reader has saved history but no discard control", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(); await journey.browserLogin(page, "read"); await page.goto(`${journey.baseUrl}/patients/${patientId}`); await page.getByRole("button", { name: "عرض دراسات السيفالومتري", exact: true }).click(); await page.getByRole("heading", { name: "مسودة غير معتمدة — قبل العلاج", exact: true }).waitFor(); expect(await page.getByTestId("canonical-ceph-discard").count()).toBe(0); }
  finally { await context.close(); }
});
it("browser: committed lost reply remains recoverable after draft disappearance and reload without claiming success", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(), editor = await openDiscard(page); let sends = 0;
    await editor.getByLabel("ملاحظة الرفض (اختيارية)").fill("SYN secret note");
    await page.route(`**/api/ceph/${studyId}`, async route => { if (route.request().method() !== "DELETE") return route.continue(); sends++; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort("failed"); });
    await editor.getByRole("button", { name: "تأكيد رفض المسودة", exact: true }).click(); await editor.getByText("طلب رفض سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain("SYN secret note");
    const recovered = await openDiscard(page, "own", true, false); await recovered.getByText("طلب رفض سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    await recovered.getByRole("button", { name: "التحقق من حالة المسودة", exact: true }).click(); await recovered.getByText(/هذا لا يثبت نتيجة طلب بعينه/).waitFor();
    expect(sends).toBe(1); expect(await audits()).toBe(1); expect(await page.getByText("رُفضت المسودة وسُجّل أثرها؛ بقيت بياناتها محفوظة.", { exact: true }).count()).toBe(0);
    await recovered.getByRole("button", { name: "راجعت الحالة، إغلاق المتابعة", exact: true }).click(); expect(sends).toBe(1);
  } finally { await context.close(); }
});
it("browser: uncommitted lost request requires a new review and explicit confirmation", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(), editor = await openDiscard(page); let sends = 0;
    await page.route(`**/api/ceph/${studyId}`, async route => { if (route.request().method() !== "DELETE") return route.continue(); sends++; if (sends === 1) await route.abort("failed"); else await route.continue(); });
    await editor.getByRole("button", { name: "تأكيد رفض المسودة", exact: true }).click(); await editor.getByRole("button", { name: "التحقق من حالة المسودة", exact: true }).click(); await editor.getByText(/المسودة ما زالت حالية/).waitFor();
    await editor.getByRole("button", { name: "راجعت الحالة، إغلاق المتابعة", exact: true }).click(); expect(sends).toBe(1);
    await editor.getByRole("button", { name: "مراجعة رفض المسودة الحالية", exact: true }).click(); expect(sends).toBe(1); await editor.getByRole("button", { name: "تأكيد رفض المسودة", exact: true }).click();
    await page.getByText("رُفضت المسودة وسُجّل أثرها؛ بقيت بياناتها محفوظة.", { exact: true }).waitFor(); expect(sends).toBe(2); expect(await audits()).toBe(1);
  } finally { await context.close(); }
});
it("browser: malformed success stays uncertain after commit", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(), editor = await openDiscard(page);
    await page.route(`**/api/ceph/${studyId}`, async route => { if (route.request().method() !== "DELETE") return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(200); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); });
    await editor.getByRole("button", { name: "تأكيد رفض المسودة", exact: true }).click(); await editor.getByText("طلب رفض سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor(); expect(await audits()).toBe(1);
  } finally { await context.close(); }
});
it("browser: unavailable tab storage warns without automatic retry", async () => {
  const context = await journey.browser.newContext();
  try {
    await context.addInitScript(() => { const get = Storage.prototype.getItem, set = Storage.prototype.setItem; Storage.prototype.getItem = function (key: string) { if (key.startsWith("aqlan.ceph-discard.pending:")) throw new DOMException("SYN unavailable", "SecurityError"); return get.call(this, key); }; Storage.prototype.setItem = function (key: string, value: string) { if (key.startsWith("aqlan.ceph-discard.pending:")) throw new DOMException("SYN unavailable", "SecurityError"); return set.call(this, key, value); }; });
    const page = await context.newPage(), editor = await openDiscard(page); await editor.getByText(/الاستعادة بعد إعادة التحميل غير مضمونة/).waitFor(); let sends = 0;
    await page.route(`**/api/ceph/${studyId}`, async route => { if (route.request().method() !== "DELETE") return route.continue(); sends++; await route.abort("failed"); }); await editor.getByRole("button", { name: "تأكيد رفض المسودة", exact: true }).click(); await editor.getByRole("button", { name: "التحقق من حالة المسودة", exact: true }).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(0);
  } finally { await context.close(); }
});
it("browser: child edit after review refuses a stale discard and clears entered clinical text", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), editor = await openDiscard(page); await editor.getByLabel("ملاحظة الرفض (اختيارية)").fill("SYN old intent"); await journey.db.query("UPDATE ceph_landmarks SET y=y+1 WHERE analysis_id=$1", [studyId]); await editor.getByRole("button", { name: "تأكيد رفض المسودة", exact: true }).click(); await editor.getByText(/تغيّرت المسودة أو تعذّر تثبيت حالتها/).waitFor(); expect(await editor.getByRole("textbox").count()).toBe(0); expect(await state()).toBe("draft"); expect(await audits()).toBe(0); }
  finally { await context.close(); }
});
it("browser: revocation after review refuses and clears the authorized list", async () => {
  const context = await journey.browser.newContext(), permissions = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.all])).rows[0].permissions;
  try { const page = await context.newPage(), editor = await openDiscard(page, "all"); await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ceph.analyze}','false')::text WHERE id=$1", [journey.ids.all]); await editor.getByRole("button", { name: "تأكيد رفض المسودة", exact: true }).click(); await page.getByTestId("canonical-ceph-studies").getByRole("alert").waitFor(); expect(await page.getByTestId("canonical-ceph-discard").count()).toBe(0); expect(await state()).toBe("draft"); expect(await audits()).toBe(0); }
  finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [permissions, journey.ids.all]); }
});

it("browser: closing the list before a delayed committed reply cannot restore old clinical state", async () => {
  const context = await journey.browser.newContext(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); let committed = false;
  try {
    const page = await context.newPage(), editor = await openDiscard(page);
    await page.route(`**/api/ceph/${studyId}`, async route => { if (route.request().method() !== "DELETE") return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(200); committed = true; await gate; await route.fulfill({ response }).catch(() => undefined); });
    await editor.getByRole("button", { name: "تأكيد رفض المسودة", exact: true }).click();
    await vi.waitFor(() => expect(committed).toBe(true), { timeout: 5000 }); await page.getByRole("button", { name: "إغلاق الدراسات", exact: true }).click(); release();
    expect(await page.getByTestId("canonical-ceph-discard").count()).toBe(0); expect(await page.getByText("رُفضت المسودة وسُجّل أثرها؛ بقيت بياناتها محفوظة.", { exact: true }).count()).toBe(0);
    expect(await state()).toBe("discarded"); expect(await audits()).toBe(1);
  } finally { release(); await context.close(); }
});
