/** Synthetic before/after witness for the existing immutable strategy command. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ACCOUNTS = {
  owner: { username: "canon-osw-owner", password: "Canon#OSWOwner1", role: "admin", display: "مالك اصطناعي" },
  doctor: { username: "canon-osw-doctor", password: "Canon#OSWDoctor1", role: "doctor", doctor: true, display: "طبيب اصطناعي", patientScope: "own", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true } },
  reader: { username: "canon-osw-reader", password: "Canon#OSWReader1", role: "admin", display: "قارئ اصطناعي", patientScope: "all", grants: { "clinical.ortho.view": true } },
  none: { username: "canon-osw-none", password: "Canon#OSWNone1", role: "doctor", doctor: true, display: "بلا نطاق", patientScope: "none", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true } },
  planView: { username: "canon-osw-planview", password: "Canon#OSWPlanView1", role: "reception", display: "قارئ خطط اصطناعي", patientScope: "all", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true, "clinical.plans.view": true } },
  planEdit: { username: "canon-osw-planedit", password: "Canon#OSWPlanEdit1", role: "reception", display: "محرر مخول اصطناعي", patientScope: "all", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true, "clinical.plans.view": true, "clinical.plans.edit": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
let caseId = 0, problemId = 0, patientId = 0, outsideCase = 0, planItem = 0, initialRevisionId = 0;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 103, secret: "canonical-strategy-write-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _accounts, parties) {
      const patient = (await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-OSW-1','مريض استراتيجية اصطناعي',$1) RETURNING id", [parties.doctor])).rows[0].id;
      patientId = patient;
      caseId = (await db.query("INSERT INTO ortho_cases(patient_id,status,created_by,responsible_doctor_id) VALUES($1,'active','SYN',$2) RETURNING id", [patient, parties.doctor])).rows[0].id;
      const bridge = (await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN explicit strategy bridge',$2,'SYN') RETURNING id", [patient, caseId])).rows[0].id;
      problemId = (await db.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) VALUES($1,$2,'SYN recorded problem','SYN') RETURNING id", [patient, bridge])).rows[0].id;
      const foreign = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-OSW-FOREIGN','مريض خارجي اصطناعي') RETURNING id")).rows[0].id;
      outsideCase = (await db.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [foreign])).rows[0].id;
      const plan = (await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'SYN private funding',92387,'SYN') RETURNING id", [patient])).rows[0].id;
      planItem = (await db.query("INSERT INTO plan_items(plan_id,service_name,unit_price_minor,quantity,case_id) VALUES($1,'SYN saved service',92387,1,$2) RETURNING id", [plan, bridge])).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: a scoped canonical editor appends a valid native strategy revision and replays only its exact receipt", async () => {
  const session = await journey.login("doctor"), path = `/api/ortho/${caseId}/strategy`;
  expect(session.status).toBe(200);
  expect((await journey.api(path, session.cookie)).status).toBe(200);
  const body = JSON.stringify({ schemaVersion: 1, commandId: "synthetic_strategy_append_001", expectedRevisionId: null,
    reason: "SYN explicit strategy documentation", rows: [{ problemId, objective: "SYN objective", strategy: "SYN documented plan", rationale: null, planItemIds: [] }] });
  const response = await journey.api(path, session.cookie, { method: "POST", body });
  expect(response.status).toBe(201);
  const saved = await response.json(); expect(saved).toMatchObject({ ok: true, replayed: false, revision: { version: 1 } });
  initialRevisionId = saved.revision.revisionId;
  const replay = await journey.api(path, session.cookie, { method: "POST", body });
  expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ ok: true, replayed: true, revision: { version: 1 } });
  expect((await journey.db.query("SELECT count(*)::int n FROM ortho_strategy_revisions WHERE ortho_case_id=$1", [caseId])).rows[0].n).toBe(1);
  expect(await journey.ddlLog()).toEqual([]);
});

const command = () => ({ schemaVersion: 1, commandId: "synthetic_strategy_append_002", expectedRevisionId: initialRevisionId,
  reason: "SYN explicit second revision", rows: [{ problemId, objective: "SYN objective", strategy: "SYN clinical strategy", rationale: null, planItemIds: [] as number[] }] });
it("HTTP: anonymous, no edit grant and none refuse; outside and missing are indistinguishable", async () => {
  const path = `/api/ortho/${caseId}/strategy`, body = JSON.stringify(command());
  expect((await journey.api(path, "", { method: "POST", body })).status).toBe(401);
  for (const key of ["reader", "none"] as const) {
    const login = await journey.login(key), response = await journey.api(path, login.cookie, { method: "POST", body });
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toContain("no-store");
  }
  const doctor = await journey.login("doctor"), failures = [];
  for (const id of [outsideCase, 2147483647]) {
    const response = await journey.api(`/api/ortho/${id}/strategy`, doctor.cookie, { method: "POST", body });
    expect(response.status).toBe(404); failures.push(await response.json());
  }
  expect(failures[0]).toEqual(failures[1]); expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: invalid request shape, schema and query refuse without altering stored revisions", async () => {
  const session = await journey.login("doctor"), path = `/api/ortho/${caseId}/strategy`;
  const before = (await journey.db.query("SELECT to_jsonb(r) value FROM ortho_strategy_revisions r WHERE ortho_case_id=$1 ORDER BY id", [caseId])).rows;
  for (const patch of [{ force: true }, { schemaVersion: 2 }, { reason: ["SYN"] }, { rows: [] }]) {
    const response = await journey.api(path, session.cookie, { method: "POST", body: JSON.stringify({ ...command(), ...patch }) });
    expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toContain("no-store");
  }
  const query = await journey.api(`${path}?force=1`, session.cookie, { method: "POST", body: JSON.stringify(command()) });
  expect(query.status).toBe(400); expect(query.headers.get("cache-control")).toContain("no-store");
  const malformed = await journey.api(path, session.cookie, { method: "POST", body: "{" });
  expect(malformed.status).toBe(400); expect(malformed.headers.get("cache-control")).toContain("no-store");
  expect((await journey.db.query("SELECT to_jsonb(r) value FROM ortho_strategy_revisions r WHERE ortho_case_id=$1 ORDER BY id", [caseId])).rows).toEqual(before);
});
it("HTTP: independent plan edit admits clinical linkage without money fields or changes", async () => {
  const input = command(); input.rows[0].planItemIds = [planItem];
  const path = `/api/ortho/${caseId}/strategy`, body = JSON.stringify(input);
  const financial = async () => (await journey.db.query("SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM treatment_plans t) plans,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM plan_items i) items,(SELECT count(*) FROM invoices)::int invoices")).rows;
  const before = await financial();
  for (const key of ["doctor", "planView"] as const) {
    const session = await journey.login(key), response = await journey.api(path, session.cookie, { method: "POST", body });
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: "plan_links_unavailable" });
  }
  const editor = await journey.login("planEdit"), response = await journey.api(path, editor.cookie, { method: "POST", body });
  expect(response.status).toBe(201);
  const saved = await response.json(); expect(saved).toMatchObject({ ok: true, revision: { version: 2, rows: [{ planLinks: { state: "allowed", items: [{ id: planItem, serviceName: "SYN saved service" }] } }] } });
  expect(JSON.stringify(saved)).not.toMatch(/92387|private funding|unitPrice|invoice|balance|totalMinor/);
  expect(await financial()).toEqual(before);
  const read = await journey.api(path, editor.cookie); expect(await read.json()).toMatchObject({ clinicalWritable: false, canRevise: false, choices: { problems: [], planItems: [] } });
});
it("browser: the reference reader remains unchanged and does not mount an unreviewed strategy editor", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(); await journey.browserLogin(page, "planEdit");
    const calls: string[] = []; page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/strategy")) calls.push(request.method()); });
    await page.goto(`${journey.baseUrl}/patients/${patientId}`);
    await page.getByRole("button", { name: "عرض حالات التقويم", exact: true }).click();
    await page.getByRole("button", { name: "عرض تفاصيل الحالة", exact: true }).click();
    await page.getByRole("button", { name: "عرض الاستراتيجية المحفوظة", exact: true }).click();
    const panel = page.getByTestId("canonical-ortho-strategy"); await panel.getByTestId("ortho-strategy-saved").waitFor();
    expect(await panel.getByTestId("ortho-strategy-editor").count()).toBe(0);
    expect(await panel.locator("textarea,input").count()).toBe(0);
    expect(calls.every(method => method === "GET")).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { await context.close(); }
});
it("HTTP: removed edit authority invalidates the old cookie and a fresh read-only account cannot replay", async () => {
  const original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.doctor])).rows[0].permissions;
  const stale = await journey.login("doctor"), path = `/api/ortho/${caseId}/strategy`;
  try {
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ortho.edit}','false')::text WHERE id=$1", [journey.ids.doctor]);
    const body = JSON.stringify(command());
    expect((await journey.api(path, stale.cookie, { method: "POST", body })).status).toBe(401);
    const fresh = await journey.login("doctor"); expect((await journey.api(path, fresh.cookie, { method: "POST", body })).status).toBe(403);
  } finally { await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.doctor]); }
  expect(await journey.ddlLog()).toEqual([]);
});
