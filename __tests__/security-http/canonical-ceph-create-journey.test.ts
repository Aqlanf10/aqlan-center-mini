import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
const UPLOAD = { "clinical.xrays.view": true, "clinical.xrays.upload": true };
const ACCOUNTS = {
  owner: { username: "canon-create-owner", password: "Canon#CreateOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-create-own", password: "Canon#CreateOwn1", role: "doctor", doctor: true, display: "طبيب تجريبي", patientScope: "own", grants: UPLOAD },
  all: { username: "canon-create-all", password: "Canon#CreateAll1", role: "reception", display: "موظف تجريبي", patientScope: "all", grants: UPLOAD },
  read: { username: "canon-create-read", password: "Canon#CreateRead1", role: "admin", display: "قارئ صور", patientScope: "all", grants: { "clinical.xrays.view": true } },
  none: { username: "canon-create-none", password: "Canon#CreateNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: UPLOAD },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>, sequence = 0, patientId: number, documentId: number;
beforeAll(async () => { journey = await openCanonicalJourney({ portOffset: 91, secret: "canonical-ceph-create-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed() {} }); }, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
beforeEach(async () => {
  patientId = Number((await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN new study patient',$2) RETURNING id", [`SYN-CEPH-CREATE-${++sequence}`, journey.parties.own])).rows[0].id);
  documentId = (await seedCanonicalCeph(journey.db, { patientId })).documentId;
});
const create = (cookie: string, id = patientId, body: unknown = { documentId }) => journey.api(`/api/patients/${id}/ceph`, cookie, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
it("HTTP: a scoped uploader opens a draft on an existing owned image without legacy identity", async () => {
  const session = await journey.login("own"); expect(session.status).toBe(200);
  expect((await journey.api(`/api/patients/${patientId}/ceph`, session.cookie)).status).toBe(200);
  const response = await create(session.cookie); expect(response.status).toBe(201);
  const result = await response.json(); expect(result).toEqual({ id: expect.any(Number), duplicateWarning: expect.any(String) });
  expect(await journey.ddlLog()).toEqual([]);
});
const drafts = async () => (await journey.db.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'", [patientId])).rows;
const audits = async () => Number((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='ceph.create' AND entity_id IN (SELECT id::text FROM ceph_analyses WHERE patient_id=$1)", [patientId])).rows[0].n);
it.each(["owner", "all"] as const)("HTTP: %s receives only a fresh no-store acknowledgment", async key => {
  const response = await create((await journey.login(key)).cookie); expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(Object.keys(await response.json()).sort()).toEqual(["duplicateWarning", "id"]); expect(await drafts()).toHaveLength(1); expect(await audits()).toBe(1);
});
it("HTTP: anonymous, reader and none do not gain upload authority, outside equals missing", async () => {
  expect((await create("")).status).toBe(401);
  for (const key of ["read", "none"] as const) expect((await create((await journey.login(key)).cookie)).status).toBe(403);
  const outside = Number((await journey.db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYN outside create') RETURNING id", [`SYN-CCR-OUT-${sequence}`])).rows[0].id);
  const cookie = (await journey.login("own")).cookie, a = await create(cookie, outside), b = await create(cookie, 2147483647); expect(a.status).toBe(404); expect(b.status).toBe(404); expect(await a.json()).toEqual(await b.json()); expect(await drafts()).toEqual([]); expect(await audits()).toBe(0);
});
it("HTTP: body/query coercion, injected authority and clinical results are rejected without effects", async () => {
  const cookie = (await journey.login("own")).cookie;
  for (const body of [null, [], { documentId: String(documentId) }, { documentId, patientId }, { documentId, actor: "owner" }, { documentId, phase: ["during"] }, { documentId, status: "completed" }, { documentId, xrayDate: "2026-02-30" }, { documentId, measurements: [] }]) expect((await create(cookie, patientId, body)).status).toBe(400);
  const query = await journey.api(`/api/patients/${patientId}/ceph?force=1`, cookie, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId }) }); expect(query.status).toBe(400); expect(await drafts()).toEqual([]); expect(await audits()).toBe(0); expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: hidden, foreign and missing image references share a private minimal refusal", async () => {
  const cookie = (await journey.login("all")).cookie, foreignPatient = Number((await journey.db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYN private foreign') RETURNING id", [`SYN-CCR-REF-${sequence}`])).rows[0].id), foreign = await seedCanonicalCeph(journey.db, { patientId: foreignPatient });
  await journey.db.query("UPDATE patient_documents SET removed_at=NOW() WHERE id=$1", [documentId]); const bodies = [];
  for (const id of [documentId, foreign.documentId, 2147483647]) { const response = await create(cookie, patientId, { documentId: id }); expect(response.status).toBe(409); expect(response.headers.get("cache-control")).toContain("no-store"); const body = await response.json(); expect(Object.keys(body).sort()).toEqual(["code", "message"]); expect(JSON.stringify(body)).not.toMatch(/SYN|private|storage|image\/png/); bodies.push(body); }
  expect(bodies[0]).toEqual(bodies[1]); expect(bodies[1]).toEqual(bodies[2]); expect(await drafts()).toEqual([]);
});
it("HTTP: a committed response loss is discoverable by fresh reads and cannot create another current draft", async () => {
  const cookie = (await journey.login("own")).cookie; const response = await create(cookie); expect(response.status).toBe(201); // Deliberately discard its body, not a server receipt replay.
  expect((await create(cookie)).status).toBe(409); expect(await audits()).toBe(1);
  const current = await journey.api(`/api/patients/${patientId}/ceph`, cookie); expect(current.status).toBe(200); expect((await current.json()).analyses.filter((x: { status: string }) => x.status === "draft")).toHaveLength(1);
});
it("HTTP: stale session after permission revocation cannot create or fall back to legacy", async () => {
  const cookie = (await journey.login("all")).cookie, before = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.all])).rows[0].permissions;
  try { await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.xrays.upload}','false')::text WHERE id=$1", [journey.ids.all]); expect([401, 403]).toContain((await create(cookie)).status); expect(await drafts()).toEqual([]); expect(await audits()).toBe(0); }
  finally { await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [before, journey.ids.all]); }
});
it("browser: server-created empty draft is visible in the actual scoped 390px patient reader without copied clinical results", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(); await journey.browserLogin(page, "own"); await page.goto(`${journey.baseUrl}/patients/${patientId}`);
    const result = await page.evaluate(async ({ patientId, documentId }) => { const response = await fetch(`/api/patients/${patientId}/ceph`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId }) }); return { status: response.status, body: await response.json() }; }, { patientId, documentId }); expect(result.status).toBe(201);
    await page.getByRole("button", { name: "عرض دراسات السيفالومتري", exact: true }).click(); const item = page.getByTestId("canonical-ceph-studies").getByRole("listitem").filter({ has: page.getByRole("heading", { name: "مسودة غير معتمدة — قبل العلاج", exact: true }) }); await item.getByRole("button", { name: "عرض الدراسة المحفوظة", exact: true }).click();
    const saved = page.getByTestId("canonical-ceph-saved"); await saved.waitFor(); expect(await saved.textContent()).not.toMatch(/SYN saved clinical note|SYN completer|SYN private image title|SYN machine/); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await drafts()).toHaveLength(1); expect(await audits()).toBe(1); expect(await journey.ddlLog()).toEqual([]);
  } finally { await context.close(); }
});
