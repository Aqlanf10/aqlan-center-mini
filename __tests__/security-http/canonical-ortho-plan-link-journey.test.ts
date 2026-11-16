import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
const GRANTS = { "clinical.ortho.view": true, "clinical.ortho.edit": true, "clinical.plans.view": true, "clinical.plans.edit": true };
const ACCOUNTS = {
 owner: { username: "canon-olink-owner", password: "Canon#PlanLinkOwner1", role: "admin", display: "مالك تجريبي" },
 own: { username: "canon-olink-own", password: "Canon#PlanLinkOwn1", role: "doctor", doctor: true, patientScope: "own", display: "طبيب تجريبي", grants: GRANTS },
 all: { username: "canon-olink-all", password: "Canon#PlanLinkAll1", role: "reception", patientScope: "all", display: "مفوّض تجريبي", grants: GRANTS },
 none: { username: "canon-olink-none", password: "Canon#PlanLinkNone1", role: "doctor", doctor: true, patientScope: "none", display: "بلا نطاق", grants: GRANTS },
 clinical: { username: "canon-olink-clinical", password: "Canon#PlanLinkClinical1", role: "admin", patientScope: "all", display: "سريري فقط", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>, patientId: number, caseId: number, planId: number, sequence = 0;
beforeAll(async () => { journey = await openCanonicalJourney({ portOffset: 100, secret: "canonical-planlink-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner", async seed() {} }); }, 300000);
afterAll(async () => { await journey?.close(); }, 60000);
beforeEach(async () => {
 patientId = (await journey.db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'SYN plan link patient',$2) RETURNING id", [`SYN-OLINK-${++sequence}`, journey.parties.own])).rows[0].id;
 caseId = (await journey.db.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [patientId])).rows[0].id;
 planId = (await journey.db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency) VALUES($1,'SYN plan',12345,'YER') RETURNING id", [patientId])).rows[0].id;
});
const path = () => `/api/ortho/${caseId}`;
const mutate = (cookie: string, body: unknown, suffix = "") => journey.api(path() + suffix, cookie, { method: "PATCH", body: JSON.stringify(body) });
const audits = async () => Number((await journey.db.query("SELECT count(*)::int n FROM audit_log WHERE action='ortho.plan_link' AND entity_id=$1", [String(caseId)])).rows[0].n);
async function input(cookie: string) { const read = await journey.api(path(), cookie); expect(read.status).toBe(200); return { expectedVersion: (await read.json()).editVersion as string, planId }; }
it("HTTP: independently authorized plan linking completes the existing held branch", async () => {
 const cookie = (await journey.login("own")).cookie;
 const read = await journey.api(path(), cookie); expect(read.status).toBe(200);
 const expectedVersion = (await read.json()).editVersion;
 const result = await journey.api(path(), cookie, { method: "PATCH", body: JSON.stringify({ expectedVersion, planId }) });
 expect(result.status).toBe(200);
 expect(await result.json()).toEqual({ ok: true, caseId, changed: true });
 expect((await journey.db.query("SELECT plan_id FROM ortho_cases WHERE id=$1", [caseId])).rows[0].plan_id).toBe(planId);
});
it.each(["owner", "all"] as const)("HTTP: %s gets a minimal no-store acknowledgment and no funding projection", async key => {
 const cookie = (await journey.login(key)).cookie, result = await mutate(cookie, await input(cookie));
 expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toContain("no-store"); expect(await result.json()).toEqual({ ok: true, caseId, changed: true });
 expect(await audits()).toBe(1); expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: anonymous, none and clinical-only accounts cannot link or unlink", async () => {
 const body = await input((await journey.login("owner")).cookie);
 expect((await mutate("", body)).status).toBe(401);
 for (const key of ["none", "clinical"] as const) {
  const cookie = (await journey.login(key)).cookie;
  for (const value of [planId, null]) expect((await mutate(cookie, { ...body, planId: value })).status).toBe(403);
 }
 expect(await audits()).toBe(0);
});
it("HTTP: outside and absent cases have identical replies with no legacy fallback", async () => {
 const owner = (await journey.login("owner")).cookie, body = await input(owner), own = (await journey.login("own")).cookie;
 await journey.db.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [patientId]);
 const outside = await mutate(own, body), absent = await journey.api("/api/ortho/2147483647", own, { method: "PATCH", body: JSON.stringify(body) });
 expect(outside.status).toBe(404); expect(absent.status).toBe(404); expect(await outside.json()).toEqual(await absent.json()); expect(await audits()).toBe(0);
});
it("HTTP: strict exact inputs reject coercion, mixed actions and URL overrides", async () => {
 const cookie = (await journey.login("own")).cookie, body = await input(cookie);
 for (const value of [{ ...body, planId: [planId] }, { ...body, planId: String(planId) }, { ...body, phase: "working" }, { ...body, force: true }, { planId }]) expect((await mutate(cookie, value)).status).toBe(400);
 expect((await mutate(cookie, body, "?force=1")).status).toBe(400); expect(await audits()).toBe(0);
});
it("HTTP: fresh unlink, no-op and delayed replay keep native effect counts", async () => {
 const cookie = (await journey.login("own")).cookie, original = await input(cookie);
 expect((await mutate(cookie, original)).status).toBe(200);
 expect((await mutate(cookie, original)).status).toBe(409);
 const noop = await mutate(cookie, await input(cookie)); expect(await noop.json()).toEqual({ ok: true, caseId, changed: false }); expect(await audits()).toBe(1);
 expect((await mutate(cookie, { ...await input(cookie), planId: null })).status).toBe(200); expect(await audits()).toBe(2);
 expect((await mutate(cookie, original)).status).toBe(409);
});
it("HTTP: revocation invalidates prepared claims and fresh login cannot reuse old authority", async () => {
 const cookie = (await journey.login("own")).cookie, body = await input(cookie), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.own])).rows[0].permissions;
 try {
  await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.plans.edit}','false')::text WHERE id=$1", [journey.ids.own]);
  expect((await mutate(cookie, body)).status).toBe(401);
  expect((await mutate((await journey.login("own")).cookie, body)).status).toBe(403); expect(await audits()).toBe(0);
 } finally { await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.own]); }
});
it("HTTP: disabled session is rejected without fallback; CSRF cannot mutate", async () => {
 const cookie = (await journey.login("own")).cookie, body = await input(cookie);
 const csrf = await journey.api(path(), cookie, { method: "PATCH", headers: { Origin: "https://synthetic-other.invalid" }, body: JSON.stringify(body) }); expect(csrf.status).toBe(403);
 await journey.db.query("UPDATE users SET is_active=false WHERE id=$1", [journey.ids.own]);
 try { expect((await mutate(cookie, body)).status).toBe(401); expect(await audits()).toBe(0); }
 finally { await journey.db.query("UPDATE users SET is_active=true WHERE id=$1", [journey.ids.own]); }
});
it("browser transport: a lost committed reply does not replay and an old observation conflicts", async () => {
 const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 } });
 try {
  const page = await context.newPage(); await journey.browserLogin(page, "own");
  const body = await page.evaluate(async ({ url, planId }) => { const r = await fetch(url); return { expectedVersion: (await r.json()).editVersion as string, planId }; }, { url: path(), planId });
  let sends = 0;
  await page.route(`**/api/ortho/${caseId}`, async route => {
   if (route.request().method() !== "PATCH") return route.continue(); sends++;
   const committed = await route.fetch(); expect(committed.status()).toBe(200); await route.abort("failed");
  });
  const outcome = await page.evaluate(async ({ url, body }) => { try { await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return "responded"; } catch { return "unknown"; } }, { url: path(), body });
  expect(outcome).toBe("unknown"); await page.reload(); expect(sends).toBe(1); expect(await audits()).toBe(1);
  const cookie = (await journey.login("own")).cookie; expect((await mutate(cookie, body)).status).toBe(409); expect(await audits()).toBe(1);
  expect(await journey.ddlLog()).toEqual([]);
 } finally { await context.close(); }
});
