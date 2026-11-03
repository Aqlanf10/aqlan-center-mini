/** M2 slice 29: the bounded orthodontic case summary, synthetic built-app evidence. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ACCOUNTS = {
  owner: { username: "canon-oc-owner", password: "Canon#OCOwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-oc-doctor", password: "Canon#OCDoctor1", role: "doctor", doctor: true, display: "طبيب التقويم التجريبي", patientScope: "own", grants: { "clinical.ortho.view": true } },
  desk: { username: "canon-oc-desk", password: "Canon#OCDesk1", role: "reception", display: "متابعة التقويم", patientScope: "all", grants: { "clinical.ortho.view": true } },
  denied: { username: "canon-oc-denied", password: "Canon#OCDenied1", role: "admin", display: "مدير دون منحة التقويم", patientScope: "all", grants: { "clinical.plans.view": true } },
  none: { username: "canon-oc-none", password: "Canon#OCNone1", role: "doctor", doctor: true, display: "طبيب بلا نطاق", patientScope: "none", grants: { "clinical.ortho.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { own: 0, outside: 0, empty: 0, active: 0, closed: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 39, secret: "canonical-ortho-cases-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      for (const [key, name, doctor] of [["own", "مريض تقويم تجريبي", parties.doctor!], ["outside", "مريض خارج النطاق", null], ["empty", "مريض بلا حالة تقويم", parties.doctor!]] as const) {
        ids[key] = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id", [`SYN-OCJ-${key}`, name, doctor])).rows[0].id;
      }
      ids.closed = (await db.query<{ id: number }>("INSERT INTO ortho_cases(patient_id,status,start_date,created_by,note,responsible_doctor_id) VALUES($1,'completed','2024-01-01','SYN','SYN-hidden-clinical-note',$2) RETURNING id", [ids.own, parties.doctor!])).rows[0].id;
      ids.active = (await db.query<{ id: number }>("INSERT INTO ortho_cases(patient_id,status,start_date,created_by,upper_wire,responsible_doctor_id) VALUES($1,'active','2026-10-01','SYN','0.014 NiTi',$2) RETURNING id", [ids.own, parties.doctor!])).rows[0].id;
      await db.query("INSERT INTO ortho_cases(patient_id,created_by,note) VALUES($1,'SYN','SYN-outside-private')", [ids.outside]);
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: a canonical orthodontic viewer reads its patient's existing cases", async () => {
  const session = await journey.login("doctor");
  expect(session.status).toBe(200);
  expect((await journey.api(`/api/patients/${ids.own}`, session.cookie)).status).toBe(200);
  const response = await journey.api(`/api/ortho?patientId=${ids.own}`, session.cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const payload = await response.json();
  expect(payload.cases.map((row: { id: number }) => row.id)).toEqual([ids.active, ids.closed]);
  expect(payload).toMatchObject({ projection: "case-summary", hasMore: false });
  expect(JSON.stringify(payload)).not.toContain("SYN-hidden-clinical-note");
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: anonymous, an adjacent grant and scope none cannot read; owner and explicit all can", async () => {
  expect((await journey.api("/api/ortho", "")).status).toBe(401);
  for (const key of ["denied", "none"] as const) {
    const session = await journey.login(key);
    const response = await journey.api("/api/ortho", session.cookie);
    expect(response.status).toBe(403); expect((await response.json()).message).toMatch(/[؀-ۿ]/);
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  for (const key of ["owner", "desk"] as const) {
    const session = await journey.login(key);
    const response = await journey.api("/api/ortho", session.cookie);
    expect(response.status).toBe(200);
    const body = await response.json(); expect(body.cases).toHaveLength(2);
    for (const row of body.cases) expect(Object.keys(row).sort()).toEqual(["id", "patientId", "patientName", "appliance", "arches", "status", "phase", "startDate", "plannedMonths", "upperWire", "lowerWire", "responsibleDoctorId", "responsibleDoctorName", "baselineKind"].sort());
  }
});

it("HTTP: outside equals missing, legitimate empty succeeds, query filters cannot select another doctor or hidden fields", async () => {
  const session = await journey.login("doctor");
  const bodies = [];
  for (const id of [ids.outside, 2147483647]) {
    const response = await journey.api(`/api/ortho?patientId=${id}`, session.cookie);
    expect(response.status).toBe(404); bodies.push(await response.json());
  }
  expect(bodies[0]).toEqual(bodies[1]);
  const empty = await journey.api(`/api/ortho?patientId=${ids.empty}`, session.cookie);
  expect(empty.status).toBe(200); expect((await empty.json()).cases).toEqual([]);
  for (const query of ["patientId=0", "patientId=1&patientId=2", "doctorId=1", "status=active", "planId=1"]) {
    const response = await journey.api(`/api/ortho?${query}`, session.cookie);
    expect(response.status).toBe(400); expect((await response.json()).message).toMatch(/[؀-ۿ]/);
  }
});

it("HTTP: this read grant never opens the unconverted case writer", async () => {
  const session = await journey.login("doctor");
  const before = (await journey.db.query("SELECT count(*)::int AS n FROM ortho_cases")).rows[0].n;
  const response = await journey.api("/api/ortho", session.cookie, { method: "POST", body: JSON.stringify({ patientId: ids.empty }) });
  expect([401, 403]).toContain(response.status);
  expect((await journey.db.query("SELECT count(*)::int AS n FROM ortho_cases")).rows[0].n).toBe(before);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: an on-demand RTL summary uses only admitted reads, preserves the responsible doctor and fits 390px", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(), calls: string[] = [], failures: string[] = [];
    await journey.browserLogin(page, "doctor");
    // Observe requests made after authenticated entry, not an anonymous login-page
    // /auth/me response that may finish after navigation.
    const observed = new Set<unknown>();
    page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) { observed.add(request); calls.push(`${request.method()} ${path}`); } });
    page.on("response", response => { const path = new URL(response.url()).pathname; if (observed.has(response.request()) && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
    await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
    await page.getByRole("button", { name: "عرض حالات التقويم" }).waitFor();
    expect(calls).not.toContain("GET /api/ortho");
    await page.getByRole("button", { name: "عرض حالات التقويم" }).click();
    const panel = page.getByTestId("canonical-ortho-cases");
    await panel.getByText("0.014 NiTi", { exact: true }).waitFor();
    expect(await panel.getByText("SYN طبيب التقويم التجريبي", { exact: true }).count()).toBe(2);
    expect(await panel.getByRole("listitem").count()).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await page.content()).not.toMatch(/SYN-hidden-clinical-note|SYN-outside-private|مريض خارج النطاق/);
    const allowed = new RegExp(`^GET /api/(auth/me|patients/${ids.own}(/(contact|timeline))?|ortho)$`);
    expect(calls.filter(call => !allowed.test(call))).toEqual([]); expect(failures).toEqual([]);
    if (process.env.HR_EVIDENCE_DIR) {
      mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ortho-cases-390.png"), fullPage: true });
    }
    await page.getByRole("button", { name: "إغلاق الحالات" }).click();
    expect(await page.getByTestId("canonical-ortho-cases").count()).toBe(0);
    await page.getByRole("button", { name: "عرض حالات التقويم" }).click();
    await panel.getByText("0.014 NiTi", { exact: true }).waitFor();
  } finally { await context.close(); }
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: an adjacent clinical grant cannot render or fetch the ortho summary", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(), calls: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/ortho")) calls.push(request.url()); });
    await journey.browserLogin(page, "denied");
    await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
    await page.getByTestId("canonical-patient-profile").waitFor();
    expect(await page.getByRole("button", { name: "عرض حالات التقويم" }).count()).toBe(0); expect(calls).toEqual([]);
  } finally { await context.close(); }
});

it("browser: a network failure clears prior results, then an empty legitimate history is distinguishable from failure", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage(); await journey.browserLogin(page, "doctor");
    await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
    await page.getByRole("button", { name: "عرض حالات التقويم" }).click();
    const panel = page.getByTestId("canonical-ortho-cases"); await panel.getByText("0.014 NiTi", { exact: true }).waitFor();
    await page.route("**/api/ortho?*", route => route.abort());
    await panel.getByRole("button", { name: "تحديث الحالات" }).click();
    await panel.getByRole("alert").waitFor(); expect(await panel.getByRole("listitem").count()).toBe(0);
    expect(await panel.getByRole("alert").textContent()).toMatch(/[؀-ۿ]/);
    await page.unroute("**/api/ortho?*");
    await page.goto(`${journey.baseUrl}/patients/${ids.empty}`);
    await page.getByRole("button", { name: "عرض حالات التقويم" }).click();
    await page.getByText("لا توجد حالات تقويم مسجلة لهذا المريض.").waitFor();
  } finally { await context.close(); }
});

it("browser and HTTP: revocation clears the open summary; stale and fresh sessions cannot retain the grant", async () => {
  const context = await journey.browser.newContext();
  const original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.desk])).rows[0].permissions;
  try {
    const stale = await journey.login("desk");
    const page = await context.newPage(); await journey.browserLogin(page, "desk");
    await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
    await page.getByRole("button", { name: "عرض حالات التقويم" }).click();
    const panel = page.getByTestId("canonical-ortho-cases"); await panel.getByText("0.014 NiTi", { exact: true }).waitFor();
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ortho.view}','false')::text WHERE id=$1", [journey.ids.desk]);
    await panel.getByRole("button", { name: "تحديث الحالات" }).click();
    await panel.getByRole("alert").waitFor(); expect(await panel.getByRole("listitem").count()).toBe(0);
    expect((await journey.api(`/api/ortho?patientId=${ids.own}`, stale.cookie)).status).toBe(401);
    const fresh = await journey.login("desk"); expect(fresh.status).toBe(200);
    expect((await journey.api(`/api/ortho?patientId=${ids.own}`, fresh.cookie)).status).toBe(403);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.desk]); }
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: a superseded response cannot restore older case data after a newer read", async () => {
  const context = await journey.browser.newContext();
  let release!: () => void, reached!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  try {
    const page = await context.newPage(); await journey.browserLogin(page, "doctor");
    await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
    await page.getByRole("button", { name: "عرض حالات التقويم" }).click();
    const panel = page.getByTestId("canonical-ortho-cases"); await panel.getByText("0.014 NiTi", { exact: true }).waitFor();
    let first = true;
    await page.route("**/api/ortho?*", async route => {
      if (!first) { await route.continue(); return; }
      first = false;
      try {
        const response = await route.fetch(); reached(); await held;
        await route.fulfill({ response }).catch(() => undefined); // superseded fetch was aborted
      } finally { finished(); }
    });
    await panel.getByRole("button", { name: "تحديث الحالات" }).click();
    await ready;
    expect(await panel.getByRole("listitem").count()).toBe(0);
    await journey.db.query("UPDATE ortho_cases SET upper_wire='SYN-new-wire' WHERE id=$1", [ids.active]);
    await panel.getByRole("button", { name: "تحديث الحالات" }).click();
    await panel.getByText("SYN-new-wire", { exact: true }).waitFor();
    release(); await done;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await panel.getByText("SYN-new-wire", { exact: true }).count()).toBe(1);
    expect(await panel.getByText("0.014 NiTi", { exact: true }).count()).toBe(0);
    await page.unroute("**/api/ortho?*");
  } finally { release(); await context.close(); await journey.db.query("UPDATE ortho_cases SET upper_wire='0.014 NiTi' WHERE id=$1", [ids.active]); }
});
