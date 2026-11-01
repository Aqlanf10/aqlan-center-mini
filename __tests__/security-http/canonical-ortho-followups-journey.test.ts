import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { seedCanonicalOrthoFollowups } from "../fixtures/canonical-ortho-followups";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ACCOUNTS = {
  owner: { username: "canon-of-owner", password: "Canon#FollowOwner1", role: "admin", display: "مالك تجريبي" },
  own: { username: "canon-of-own", password: "Canon#FollowOwn1", role: "doctor", doctor: true, display: "طبيب متابعة تجريبي", patientScope: "own", appointmentScope: "none", grants: { "clinical.ortho.view": true } },
  all: { username: "canon-of-all", password: "Canon#FollowAll1", role: "reception", display: "قارئ متابعة تجريبي", patientScope: "all", appointmentScope: "all", grants: { "clinical.ortho.view": true } },
  schedule: { username: "canon-of-schedule", password: "Canon#FollowSchedule1", role: "doctor", doctor: true, display: "طبيب جدول تجريبي", patientScope: "all", appointmentScope: "own", grants: { "clinical.ortho.view": true } },
  denied: { username: "canon-of-denied", password: "Canon#FollowDenied1", role: "admin", display: "مدير بلا تقويم", patientScope: "all", appointmentScope: "all", grants: { "clinical.xrays.view": true } },
  none: { username: "canon-of-none", password: "Canon#FollowNone1", role: "doctor", display: "بلا نطاق مرضى", patientScope: "none", appointmentScope: "all", grants: { "clinical.ortho.view": true } },
} as const;
let journey: CanonicalJourney<keyof typeof ACCOUNTS>;
let caseId = 0;
let ids: Awaited<ReturnType<typeof seedCanonicalOrthoFollowups>>;
beforeAll(async () => {
  journey = await openCanonicalJourney({ portOffset: 52, secret: "canonical-ortho-followups-secret-0123456789", accounts: ACCOUNTS, ownerKey: "owner", async seed(q, _users, parties) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Aden", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    ids = await seedCanonicalOrthoFollowups(q, parties.own!, parties.schedule!, today); caseId = ids.caseId;
  } });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);
it("HTTP: a canonical ortho reader can read clinical follow-up without inheriting appointment access", async () => {
  const session = await journey.login("own"); expect(session.status).toBe(200);
  const response = await journey.api("/api/ortho/followups", session.cookie);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ projection: "ortho-followups", appointmentCoverage: "none", rows: [{ caseId }] });
  expect(body.rows[0].buckets).not.toContain("no_appointment");
  expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: anonymous, adjacent grants and no patient scope fail; URL parameters never expand authority", async () => {
  expect((await journey.api("/api/ortho/followups", "")).status).toBe(401);
  for (const key of ["denied", "none"] as const) expect((await journey.api("/api/ortho/followups", (await journey.login(key)).cookie)).status).toBe(403);
  const session = await journey.login("owner");
  for (const query of ["scope=all", `patientId=${ids.outside}`, "includeMoney=true", "doctorId=1", "date=2024-01-01"]) {
    const response = await journey.api(`/api/ortho/followups?${query}`, session.cookie); expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toContain("no-store");
  }
});
it("HTTP: appointment none, own and all are separate projections, with no rich legacy payload", async () => {
  for (const key of ["own", "schedule", "all", "owner"] as const) {
    const response = await journey.api("/api/ortho/followups", (await journey.login(key)).cookie); expect(response.status).toBe(200);
    const body = await response.json(); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(Object.keys(body).sort()).toEqual(["appointmentCoverage", "hasMore", "projection", "rows", "today"]);
    expect(body.rows).toHaveLength(key === "own" ? 1 : 2);
    const row = body.rows.find((r: { caseId: number }) => r.caseId === caseId);
    if (key === "own") { expect(body.appointmentCoverage).toBe("none"); expect(row.schedule).toBeNull(); }
    else if (key === "schedule") { expect(body.appointmentCoverage).toBe("own"); expect(row.schedule.nextAppointment.id).toBe(ids.otherBooking); expect(body.rows.every((r: { buckets: string[] }) => !r.buckets.includes("no_appointment"))).toBe(true); }
    else { expect(body.appointmentCoverage).toBe("all"); expect(row.schedule.nextAppointment.id).toBe(ids.ownBooking); }
    expect(JSON.stringify(body)).not.toMatch(/SYN private|patientPhone|upperWire|planId|clinicalCaseId|Minor|currency|invoice|payment|financial/i);
  }
  expect(await journey.ddlLog()).toEqual([]);
});
it("HTTP: malformed historical bridge gives a bounded Arabic error, without repair or private identifiers", async () => {
  const bridge = (await journey.db.query("INSERT INTO clinical_cases(patient_id,ortho_case_id,specialty,title,created_by) VALUES($1,$2,'orthodontics','SYN foreign bridge','SYN') RETURNING id", [ids.outside, caseId])).rows[0].id;
  try {
    const response = await journey.api("/api/ortho/followups", (await journey.login("all")).cookie); expect(response.status).toBe(409);
    const body = await response.json(); expect(body.code).toBe("ortho_followup_reference"); expect(body.message).toMatch(/[؀-ۿ]/); expect(JSON.stringify(body)).not.toMatch(/SYN|SELECT|patientId|caseId/);
  } finally { await journey.db.query("DELETE FROM clinical_cases WHERE id=$1", [bridge]); }
});
async function openBoard(page: import("playwright").Page, key: keyof typeof ACCOUNTS = "own") {
  await journey.browserLogin(page, key); await page.goto(`${journey.baseUrl}/ortho`);
  const panel = page.getByTestId("canonical-ortho-followups"); await panel.getByRole("link", { name: "SYN followup patient", exact: true }).waitFor(); return panel;
}
it("browser: the clinical board fits 390px without legacy money, contact or booking actions", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
  try {
    const page = await context.newPage(), calls: string[] = []; page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/ortho")) calls.push(`${request.method()} ${path}`); });
    const panel = await openBoard(page);
    expect(await panel.getByTestId("canonical-ortho-followup-row").count()).toBe(1);
    expect(await panel.textContent()).not.toMatch(/SYN private|SYN outside|بلا موعد متابعة دورية مؤكّد|غياب مسجّل سابقًا/);
    expect(await panel.getByText("صلاحية التقويم لا تمنح تفاصيل المواعيد.", { exact: false }).count()).toBe(1);
    expect(await panel.locator('a[href*="wa.me"],input,textarea,select').count()).toBe(0);
    expect(calls).toEqual(["GET /api/ortho/followups"]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (process.env.HR_EVIDENCE_DIR) { mkdirSync(process.env.HR_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HR_EVIDENCE_DIR, "ortho-followups-390.png"), fullPage: true }); }
  } finally { await context.close(); }
});
it("browser: own schedule states its coverage and never offers a false absence filter", async () => {
  const context = await journey.browser.newContext();
  try { const page = await context.newPage(), panel = await openBoard(page, "schedule"); expect(await panel.getByRole("button", { name: /بلا موعد متابعة دورية/ }).count()).toBe(0); await panel.getByText("المواعيد والغياب المسجّل تخص الطبيب", { exact: false }).waitFor(); expect(await panel.getByText("11:00", { exact: false }).count()).toBe(1); expect(await panel.getByText("10:00", { exact: false }).count()).toBe(0); }
  finally { await context.close(); }
});
it("browser: refresh failure clears prior names instead of pretending the list is empty", async () => {
  const context = await journey.browser.newContext();
  try {
    const page = await context.newPage(), panel = await openBoard(page);
    await page.route("**/api/ortho/followups", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "تعذّر التحميل التجريبي" }) }));
    await panel.getByRole("button", { name: "تحديث المتابعة" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("canonical-ortho-followup-row").count()).toBe(0); expect(await panel.textContent()).not.toContain("SYN followup");
  } finally { await context.close(); }
});
it("browser and HTTP: withdrawing the ortho grant clears an open board and rejects stale or fresh sessions", async () => {
  const context = await journey.browser.newContext(), original = (await journey.db.query("SELECT permissions FROM users WHERE id=$1", [journey.ids.all])).rows[0].permissions;
  try {
    const stale = await journey.login("all"), page = await context.newPage(), panel = await openBoard(page, "all");
    await journey.db.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}','2'),'{grants,clinical.ortho.view}','false')::text WHERE id=$1", [journey.ids.all]);
    await panel.getByRole("button", { name: "تحديث المتابعة" }).click(); await panel.getByRole("alert").waitFor(); expect(await panel.getByTestId("canonical-ortho-followup-row").count()).toBe(0);
    expect([401, 403]).toContain((await journey.api("/api/ortho/followups", stale.cookie)).status);
    expect((await journey.api("/api/ortho/followups", (await journey.login("all")).cookie)).status).toBe(403);
  } finally { await context.close(); await journey.db.query("UPDATE users SET permissions=$1 WHERE id=$2", [original, journey.ids.all]); }
});
it("browser: a late reply to a retired refresh cannot restore old clinical names", async () => {
  const context = await journey.browser.newContext();
  let release: (() => void) | undefined;
  try {
    const page = await context.newPage(), panel = await openBoard(page);
    const body = await (await journey.api("/api/ortho/followups", (await journey.login("own")).cookie)).json();
    const held = new Promise<void>(resolve => { release = resolve; }); let first = true;
    let markEntered: (() => void) | undefined; const entered = new Promise<void>(resolve => { markEntered = resolve; });
    await page.route("**/api/ortho/followups", async route => {
      if (first) { first = false; markEntered!(); await held; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }).catch(() => undefined); }
      else await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "فشل التحديث الأحدث" }) });
    });
    await panel.getByRole("button", { name: "تحديث المتابعة" }).click(); await page.waitForFunction(() => !document.querySelector('[data-testid="canonical-ortho-followup-row"]'));
    await entered; await panel.getByRole("button", { name: "تحديث المتابعة" }).click(); await panel.getByRole("alert").waitFor(); release!();
    await page.waitForTimeout(200); expect(await panel.getByTestId("canonical-ortho-followup-row").count()).toBe(0);
  } finally { release?.(); await context.close(); }
});
