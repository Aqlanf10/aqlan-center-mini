import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ANALYZE = { "clinical.xrays.view": true, "clinical.ceph.analyze": true };
const ACCOUNTS = {
  owner: { username: "canon-copy-owner", password: "Canon#CopyOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-copy-own", password: "Canon#CopyOwn1", role: "doctor", doctor: true, display: "طبيب تجريبي", patientScope: "own", grants: ANALYZE },
  all: { username: "canon-copy-all", password: "Canon#CopyAll1", role: "reception", display: "محلل تجريبي", patientScope: "all", grants: ANALYZE },
  read: { username: "canon-copy-read", password: "Canon#CopyRead1", role: "admin", display: "قارئ صور", patientScope: "all", grants: { "clinical.xrays.view": true } },
  none: { username: "canon-copy-none", password: "Canon#CopyNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: ANALYZE },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>, sequence = 0;
let patientId: number, studyId: number;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 63, secret: "canonical-ceph-copy-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed() {} });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
beforeEach(async () => {
  patientId = Number((await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN correction patient',$2) RETURNING id", [`SYN-CEPH-COPY-${++sequence}`, journey.parties.own])).rows[0].id);
  studyId = (await seedCanonicalCeph(journey.db, { patientId })).id;
  await journey.db.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'SYN_OLD_CODE',1.25,2.75,'manual','SYN original')", [studyId]);
});
/** Canonical correction contract: the fingerprint of the correction source observed in the canonical study read. */
async function observedToken(cookie: string, id = studyId) {
  const response = await journey.api(`/api/ceph/${id}`, cookie); if (response.status !== 200) return { schemaVersion: 1, expectedFingerprint: "0".repeat(64) };
  const study = await response.json(); expect(JSON.stringify(study)).not.toMatch(/documentId|orthoCaseId|sourceSha256/);
  return { schemaVersion: 1, expectedFingerprint: study.correctionSource?.state === "available" ? study.correctionSource.fingerprint : "0".repeat(64) };
}
const copy = async (cookie: string, id = studyId, body?: unknown) => journey.api(`/api/ceph/${id}/duplicate`, cookie, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body === undefined ? await observedToken((await journey.login("owner")).cookie, id) : body),
});
it("HTTP: a scoped canonical analyst can open a correction draft without legacy identity", async () => {
  const session = await journey.login("own");
  expect(session.status).toBe(200);
  expect((await journey.api(`/api/ceph/${studyId}`, session.cookie)).status).toBe(200);
  const response = await copy(session.cookie);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: expect.any(Number) });
  expect(await journey.ddlLog()).toEqual([]);
});
const audits = async () => Number((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='ceph.create' AND entity_id IN (SELECT id::text FROM ceph_analyses WHERE patient_id=$1)", [patientId])).rows[0].n);
const drafts = async () => (await journey.db.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'", [patientId])).rows;
it.each(["owner", "all"] as const)("HTTP: %s with current scope creates a minimal no-store acknowledgment", async key => {
  const response = await copy((await journey.login(key)).cookie);
  expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toContain("no-store");
  const result = await response.json(); expect(Object.keys(result)).toEqual(["id"]); expect(result.id).not.toBe(studyId); expect(await audits()).toBe(1);
});
it("HTTP: reader/none/anonymous and foreign patients do not gain analysis authority", async () => {
  expect((await copy("")).status).toBe(401);
  for (const key of ["read", "none"] as const) expect((await copy((await journey.login(key)).cookie)).status).toBe(403);
  const outside = Number((await journey.db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYN outside ceph') RETURNING id", [`SYN-CEPH-COPY-OUT-${sequence}`])).rows[0].id), foreign = await seedCanonicalCeph(journey.db, { patientId: outside });
  const cookie = (await journey.login("own")).cookie, a = await copy(cookie, foreign.id), b = await copy(cookie, 2147483647);
  expect(a.status).toBe(404); expect(b.status).toBe(404); expect(await a.json()).toEqual(await b.json()); expect(await drafts()).toEqual([]); expect(await audits()).toBe(0);
});
it("HTTP: a missing, foreign or altered correction token and query aliases are refused without effects", async () => {
  const cookie = (await journey.login("own")).cookie, token = await observedToken(cookie);
  for (const body of [{}, [], null, "", false, 0, { actor: "owner" }, { schemaVersion: 2, expectedFingerprint: token.expectedFingerprint },
    { schemaVersion: 1, expectedCorrectionSource: { analysisId: studyId } }, { ...token, expectedFingerprint: token.expectedFingerprint.toUpperCase() }]) {
    const response = await copy(cookie, studyId, body); expect(response.status, JSON.stringify(body)).toBe(400);
  }
  const query = await journey.api(`/api/ceph/${studyId}/duplicate?force=1`, cookie, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(token) });
  expect(query.status).toBe(400); expect(await drafts()).toEqual([]); expect(await audits()).toBe(0); expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: malformed copied source refuses safely without exposing values or creating a draft", async () => {
  await journey.db.query("UPDATE ceph_analyses SET mm_per_pixel='NaN' WHERE id=$1", [studyId]);
  const response = await copy((await journey.login("own")).cookie);
  expect(response.status).toBe(409); expect(response.headers.get("cache-control")).toContain("no-store");
  const result = await response.json(); expect(Object.keys(result).sort()).toEqual(["code", "message"]);
  expect(result.code).toBe("ceph_copy_conflict"); expect(JSON.stringify(result)).not.toContain("NaN");
  expect(await drafts()).toEqual([]); expect(await audits()).toBe(0);
  expect((await journey.db.query("SELECT mm_per_pixel::text AS scale FROM ceph_analyses WHERE id=$1", [studyId])).rows[0].scale).toBe("NaN");
});
async function openCopy(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "own", signed = false) {
  page.setDefaultTimeout(10000); if (!signed) await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/patients/${patientId}`);
  await page.getByRole("button", { name: "عرض دراسات السيفالومتري", exact: true }).click();
  const original = page.getByTestId("canonical-ceph-studies").getByRole("listitem").filter({ has: page.getByRole("heading", { name: "دراسة معتمدة — قبل العلاج", exact: true }) }).first();
  await original.getByRole("button", { name: "عرض الدراسة المحفوظة", exact: true }).click();
  const editor = page.getByTestId("canonical-ceph-copy"); await editor.getByRole("button", { name: "فتح نسخة تصحيح", exact: true }).click();
  return editor;
}
it("browser: 390px analyst opens one correction with two rapid clicks and sees its unapproved draft", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(), editor = await openCopy(page); let sends = 0;
    page.on("request", r => { if (r.method() === "POST" && new URL(r.url()).pathname === `/api/ceph/${studyId}/duplicate`) sends++; });
    if (process.env.HR_EVIDENCE_DIR) { mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await editor.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ceph-copy-390.png") }); }
    await editor.getByRole("button", { name: "إنشاء مسودة التصحيح", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await page.getByText("أُنشئت مسودة التصحيح وسُجّل أثرها. المسودة غير معتمدة.", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "مسودة غير معتمدة — قبل العلاج", exact: true }).waitFor();
    expect(sends).toBe(1); expect(await drafts()).toHaveLength(1); expect(await audits()).toBe(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith("aqlan.ceph-copy.pending:")))).toEqual([]);
  } finally { await context.close(); }
});
it("browser: an imaging reader can read the saved study but receives no copy control", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(); await journey.browserLogin(page, "read"); await page.goto(`${journey.baseUrl}/patients/${patientId}`); await page.getByRole("button", { name: "عرض دراسات السيفالومتري", exact: true }).click(); await page.getByRole("button", { name: "عرض الدراسة المحفوظة", exact: true }).click(); await page.getByTestId("canonical-ceph-saved").waitFor(); expect(await page.getByTestId("canonical-ceph-copy").count()).toBe(0); }
  finally { await context.close(); }
});
it("browser: committed lost response is not replayed, even after the old draft is subsequently completed", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(), editor = await openCopy(page); let sends = 0, first = true;
    page.on("request", r => { if (r.method() === "POST" && new URL(r.url()).pathname === `/api/ceph/${studyId}/duplicate`) sends++; });
    await page.route(`**/api/ceph/${studyId}/duplicate`, async route => { if (!first) { await route.continue(); return; } first = false; const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort("failed"); });
    await editor.getByRole("button", { name: "إنشاء مسودة التصحيح", exact: true }).click(); await editor.getByText("طلب نسخة تصحيح سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor();
    expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toMatch(/SYN_OLD_CODE|SYN saved clinical note|SYN original/);
    await page.reload(); await page.getByRole("button", { name: "عرض دراسات السيفالومتري", exact: true }).click();
    const original = page.getByTestId("canonical-ceph-studies").getByRole("listitem").filter({ has: page.getByRole("heading", { name: "دراسة معتمدة — قبل العلاج", exact: true }) });
    await original.getByRole("button", { name: "عرض الدراسة المحفوظة", exact: true }).click(); const restored = page.getByTestId("canonical-ceph-copy");
    await restored.getByRole("button", { name: "التحقق من الدراسات الحالية", exact: true }).click(); await restored.getByText(/توجد مسودة حالية/).waitFor(); expect(sends).toBe(1); expect(await restored.getByRole("button", { name: "راجعت السجل، بدء طلب تصحيح جديد", exact: true }).count()).toBe(0);
    await journey.db.query("UPDATE ceph_analyses SET status='completed',completed_by='SYN later approval',completed_at=NOW() WHERE patient_id=$1 AND status='draft'", [patientId]);
    await restored.getByRole("button", { name: "التحقق من الدراسات الحالية", exact: true }).click(); await restored.getByRole("button", { name: "راجعت السجل، بدء طلب تصحيح جديد", exact: true }).click(); expect(sends).toBe(1);
    await restored.getByRole("button", { name: "إنشاء مسودة التصحيح", exact: true }).click(); await page.getByText("أُنشئت مسودة التصحيح وسُجّل أثرها. المسودة غير معتمدة.", { exact: true }).waitFor(); expect(sends).toBe(2); expect(await drafts()).toHaveLength(1); expect(await audits()).toBe(2);
  } finally { await context.close(); }
});
it("browser: malformed success after commit stays uncertain rather than recreating", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), editor = await openCopy(page); let sends = 0; await page.route(`**/api/ceph/${studyId}/duplicate`, async route => { sends++; const response = await route.fetch(); expect(response.status()).toBe(201); await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, id: "SYN" }) }); }); await editor.getByRole("button", { name: "إنشاء مسودة التصحيح", exact: true }).click(); await editor.getByText("طلب نسخة تصحيح سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(1); }
  finally { await context.close(); }
});
it("browser: unavailable tab storage warns and holds an uncertain request in memory", async () => {
  const context = await journey.browser.newContext();
  try {
    await context.addInitScript(() => { const get = Storage.prototype.getItem, set = Storage.prototype.setItem; Storage.prototype.getItem = function (key: string) { if (key.startsWith("aqlan.ceph-copy.pending:")) throw new DOMException("SYN unavailable", "SecurityError"); return get.call(this, key); }; Storage.prototype.setItem = function (key: string, value: string) { if (key.startsWith("aqlan.ceph-copy.pending:")) throw new DOMException("SYN unavailable", "SecurityError"); return set.call(this, key, value); }; });
    const page = await context.newPage(), editor = await openCopy(page); await editor.getByText(/الاستعادة بعد إعادة التحميل غير مضمونة/).waitFor(); let sends = 0; await page.route(`**/api/ceph/${studyId}/duplicate`, async route => { sends++; await route.abort("failed"); }); await editor.getByRole("button", { name: "إنشاء مسودة التصحيح", exact: true }).click(); await editor.getByText("طلب نسخة تصحيح سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor(); expect(sends).toBe(1);
  } finally { await context.close(); }
});
it("browser: analysis revocation while armed refuses mutation and clears the saved study", async () => {
  const context = await journey.browser.newContext(), permissions = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.all])).rows[0].permissions;
  try { const page = await context.newPage(), editor = await openCopy(page, "all"); await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ceph.analyze}','false')::text WHERE id=$1", [journey.ids.all]); await editor.getByRole("button", { name: "إنشاء مسودة التصحيح", exact: true }).click(); await page.getByTestId("canonical-ceph-study").getByRole("alert").waitFor(); expect(await page.getByTestId("canonical-ceph-saved").count()).toBe(0); expect(await drafts()).toEqual([]); expect(await audits()).toBe(0); }
  finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [permissions, journey.ids.all]); }
});
it("browser: closing before a late committed response preserves pending review", async () => {
  const context = await journey.browser.newContext(); let release!: () => void, reached!: () => void, finished!: () => void;
  const held = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { reached = r; }), done = new Promise<void>(r => { finished = r; });
  try {
    const page = await context.newPage(), editor = await openCopy(page); let sends = 0;
    await page.route(`**/api/ceph/${studyId}/duplicate`, async route => { sends++; try { const response = await route.fetch(); expect(response.status()).toBe(201); reached(); await held; await route.fulfill({ response }).catch(() => undefined); } finally { finished(); } });
    await editor.getByRole("button", { name: "إنشاء مسودة التصحيح", exact: true }).click(); await ready; await page.getByRole("button", { name: "إغلاق الدراسة المحفوظة", exact: true }).click(); release(); await done;
    expect(await page.getByTestId("canonical-ceph-copy").count()).toBe(0); await page.getByRole("button", { name: "عرض الدراسة المحفوظة", exact: true }).click();
    await page.getByTestId("canonical-ceph-copy").getByText("طلب نسخة تصحيح سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.", { exact: true }).waitFor(); expect(sends).toBe(1); expect(await audits()).toBe(1);
  } finally { release(); await context.close(); }
});
