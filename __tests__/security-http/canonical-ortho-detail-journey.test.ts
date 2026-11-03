/** M2 slice 30: the clinical orthodontic case detail, synthetic built-app evidence. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ACCOUNTS = {
  owner: { username: "canon-od-owner", password: "Canon#OCOwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-od-doctor", password: "Canon#OCDoctor1", role: "doctor", doctor: true, display: "طبيب التقويم التجريبي", patientScope: "own", grants: { "clinical.ortho.view": true } },
  desk: { username: "canon-od-desk", password: "Canon#OCDesk1", role: "reception", display: "متابعة التقويم", patientScope: "all", grants: { "clinical.ortho.view": true } },
  denied: { username: "canon-od-denied", password: "Canon#OCDenied1", role: "admin", display: "مدير دون منحة التقويم", patientScope: "all", grants: { "clinical.plans.view": true } },
  none: { username: "canon-od-none", password: "Canon#OCNone1", role: "doctor", doctor: true, display: "طبيب بلا نطاق", patientScope: "none", grants: { "clinical.ortho.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { own: 0, outside: 0, empty: 0, active: 0, closed: 0 };
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 41, secret: "canonical-ortho-detail-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
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

it("HTTP: canonical clinical viewer reads a scoped case detail", async () => {
  const session = await journey.login("doctor");
  expect(session.status).toBe(200);
  expect((await journey.api(`/api/patients/${ids.own}`, session.cookie)).status).toBe(200);
  const response = await journey.api(`/api/ortho/${ids.active}`, session.cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({ projection: "case-clinical", case: { id: ids.active, patientId: ids.own, upperWire: "0.014 NiTi" }, adjustments: [], hasMore: false });
  expect(await journey.ddlLog()).toEqual([]);
});

it("HTTP: anonymous, adjacent grants and scope none deny; all and owner retain the bounded clinical representation", async () => {
  expect((await journey.api(`/api/ortho/${ids.active}`, "")).status).toBe(401);
  for (const key of ["denied", "none"] as const) {
    const session = await journey.login(key), result = await journey.api(`/api/ortho/${ids.active}`, session.cookie);
    expect(result.status).toBe(403); expect(result.headers.get("cache-control")).toContain("no-store");
    expect((await result.json()).message).toMatch(/[؀-ۿ]/);
  }
  for (const key of ["owner", "desk", "doctor"] as const) {
    const session = await journey.login(key), response = await journey.api(`/api/ortho/${ids.closed}`, session.cookie);
    expect(response.status).toBe(200);
    const body = await response.json(); expect(body.case.note).toBe("SYN-hidden-clinical-note");
    expect(JSON.stringify(body)).not.toMatch(/planId|legacyFinancialMode|photos|visitId|visitSigned|invoice|balance/);
    expect(Object.keys(body).sort()).toEqual(["projection", "case", "adjustments", "hasMore", "progress", "today"].sort());
  }
});
it("HTTP: missing equals outside scope and URL expansions cannot fetch independent data", async () => {
  const outside = (await journey.db.query("SELECT id FROM ortho_cases WHERE patient_id=$1", [ids.outside])).rows[0].id;
  const session = await journey.login("doctor"), bodies = [];
  for (const id of [outside, 2147483647]) {
    const response = await journey.api(`/api/ortho/${id}`, session.cookie);
    expect(response.status).toBe(404); bodies.push(await response.json());
  }
  expect(bodies[0]).toEqual(bodies[1]);
  for (const path of ["0", "01", "2147483648", `${ids.active}?photos=1`, `${ids.active}?patientId=${ids.outside}`, `${ids.active}?include=finance`]) {
    const response = await journey.api(`/api/ortho/${path}`, session.cookie);
    expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toContain("no-store");
  }
});
it("HTTP: detail grant admits no case mutation or funding writer and GET has no effects", async () => {
  const session = await journey.login("doctor");
  const sql = "SELECT (SELECT count(*) FROM ortho_adjustments)::int AS adjustments,(SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM audit_log)::int AS audits";
  const before = (await journey.db.query(sql)).rows;
  expect((await journey.api(`/api/ortho/${ids.active}`, session.cookie)).status).toBe(200);
  for (const method of ["POST", "PATCH"]) {
    const response = await journey.api(`/api/ortho/${ids.active}`, session.cookie, { method, body: JSON.stringify({ phase: "finishing", planId: null, note: "SYN-unwanted" }) });
    expect([401, 403]).toContain(response.status);
  }
  expect((await journey.db.query(sql)).rows).toEqual(before);
  expect(await journey.ddlLog()).toEqual([]);
});
it("browser: on-demand clinical detail fits 390px, escapes native notes and uses only admitted APIs", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  const marker = "<b>ملاحظة تقويم اصطناعية</b>";
  await journey.db.query("UPDATE ortho_cases SET note=$1,remaining_objectives='أهداف اصطناعية للمتابعة' WHERE id=$2", [marker, ids.active]);
  const adj = (await journey.db.query("INSERT INTO ortho_adjustments(case_id,recorded_by,note,done) VALUES($1,'SYN','ملاحظة شدّة اصطناعية','تعديل سلك اصطناعي') RETURNING id", [ids.active])).rows[0].id;
  try {
    const page = await context.newPage(), calls: string[] = [];
    await journey.browserLogin(page, "doctor");
    page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/")) calls.push(`${request.method()} ${path}`); });
    await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
    await page.getByRole("button", { name: "عرض حالات التقويم" }).click();
    await page.getByRole("button", { name: "عرض تفاصيل الحالة" }).first().waitFor();
    expect(calls).not.toContain(`GET /api/ortho/${ids.active}`);
    await page.getByRole("button", { name: "عرض تفاصيل الحالة" }).first().click();
    const panel = page.getByTestId("canonical-ortho-detail");
    await panel.getByText(marker, { exact: true }).waitFor();
    await panel.getByText("ملاحظة شدّة اصطناعية", { exact: true }).waitFor();
    expect(await panel.locator("b").count()).toBe(0);
    expect(await panel.locator("img,a[href*='document'],button[type='submit']").count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const allowed = new RegExp(`^GET /api/(auth/me|patients/${ids.own}(/(contact|timeline))?|ortho(/${ids.active})?)$`);
    expect(calls.filter(call => !allowed.test(call))).toEqual([]);
    if (process.env.HR_EVIDENCE_DIR) {
      mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ortho-detail-390.png"), fullPage: true });
    }
    await panel.getByRole("button", { name: "تحديث التفاصيل" }).click();
    await panel.getByText(marker, { exact: true }).waitFor();
    await page.getByRole("button", { name: "إغلاق تفاصيل الحالة" }).click();
    expect(await page.getByTestId("canonical-ortho-detail").count()).toBe(0);
  } finally {
    await context.close();
    await journey.db.query("DELETE FROM ortho_adjustments WHERE id=$1", [adj]);
    await journey.db.query("UPDATE ortho_cases SET note=NULL,remaining_objectives=NULL WHERE id=$1", [ids.active]);
  }
});
it("browser: a failed refresh removes prior clinical data and never falls back to a legacy response", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(); await journey.browserLogin(page, "doctor");
    await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
    await page.getByRole("button", { name: "عرض حالات التقويم" }).click();
    await page.getByRole("button", { name: "عرض تفاصيل الحالة" }).last().click();
    const panel = page.getByTestId("canonical-ortho-detail"); await panel.getByText("SYN-hidden-clinical-note", { exact: true }).waitFor();
    await page.route(`**/api/ortho/${ids.closed}`, route => route.abort());
    await panel.getByRole("button", { name: "تحديث التفاصيل" }).click();
    await panel.getByRole("alert").waitFor();
    expect(await panel.getByText("SYN-hidden-clinical-note", { exact: true }).count()).toBe(0);
    expect(await panel.getByRole("alert").textContent()).toMatch(/[؀-ۿ]/);
  } finally { await context.close(); }
});
it("browser and HTTP: permission revocation clears details, stale sessions fail and fresh sessions cannot recover removed grants", async () => {
  const context = await journey.browser.newContext();
  const original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.desk])).rows[0].permissions;
  try {
    const stale = await journey.login("desk"), page = await context.newPage(); await journey.browserLogin(page, "desk");
    await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
    await page.getByRole("button", { name: "عرض حالات التقويم" }).click();
    await page.getByRole("button", { name: "عرض تفاصيل الحالة" }).last().click();
    const panel = page.getByTestId("canonical-ortho-detail"); await panel.getByText("SYN-hidden-clinical-note", { exact: true }).waitFor();
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ortho.view}','false')::text WHERE id=$1", [journey.ids.desk]);
    await panel.getByRole("button", { name: "تحديث التفاصيل" }).click();
    await panel.getByRole("alert").waitFor();
    expect(await panel.getByText("SYN-hidden-clinical-note", { exact: true }).count()).toBe(0);
    expect((await journey.api(`/api/ortho/${ids.closed}`, stale.cookie)).status).toBe(401);
    const fresh = await journey.login("desk"); expect((await journey.api(`/api/ortho/${ids.closed}`, fresh.cookie)).status).toBe(403);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.desk]); }
});
it("browser: a late clinical response cannot overwrite newer data or reopen a closed detail", async () => {
  const context = await journey.browser.newContext();
  let release!: () => void, reached!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  try {
    const page = await context.newPage(); await journey.browserLogin(page, "doctor");
    await page.goto(`${journey.baseUrl}/patients/${ids.own}`);
    await page.getByRole("button", { name: "عرض حالات التقويم" }).click();
    await page.getByRole("button", { name: "عرض تفاصيل الحالة" }).last().click();
    const panel = page.getByTestId("canonical-ortho-detail"); await panel.getByText("SYN-hidden-clinical-note", { exact: true }).waitFor();
    let first = true;
    await page.route(`**/api/ortho/${ids.closed}`, async route => {
      if (!first) { await route.continue(); return; } first = false;
      try { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }).catch(() => undefined); }
      finally { finished(); }
    });
    await panel.getByRole("button", { name: "تحديث التفاصيل" }).click(); await ready;
    await journey.db.query("UPDATE ortho_cases SET note='SYN-newer-detail' WHERE id=$1", [ids.closed]);
    await panel.getByRole("button", { name: "تحديث التفاصيل" }).click();
    await panel.getByText("SYN-newer-detail", { exact: true }).waitFor();
    release(); await done;
    expect(await panel.getByText("SYN-hidden-clinical-note", { exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "إغلاق تفاصيل الحالة" }).click();
    expect(await page.getByTestId("canonical-ortho-detail").count()).toBe(0);
  } finally { release(); await context.close(); await journey.db.query("UPDATE ortho_cases SET note='SYN-hidden-clinical-note' WHERE id=$1", [ids.closed]); }
  expect(await journey.ddlLog()).toEqual([]);
});
