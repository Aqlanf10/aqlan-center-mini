import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { RetentionEvent } from "../../lib/ortho-retention-events";
import type { RetentionPersistenceCommand } from "../../lib/ortho-retention-command";
import type { FollowupRow } from "../../lib/ortho-followup";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });

// Seed only an existing legacy case/bridge. Documentary milestones are written
// through the actual built API and journal, not inserted as trusted JSON.
async function recordedCase() {
  const patientName = `متابعة تثبيت اصطناعية ${randomUUID().slice(0, 8)}`;
  const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [randomUUID(), patientName])).rows[0].id as number;
  const caseId = (await db.query("INSERT INTO ortho_cases(patient_id,status,phase,created_by) VALUES($1,'retention','retention','secadmin') RETURNING id", [patientId])).rows[0].id as number;
  await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic retained case',$2,'secadmin')", [patientId, caseId]);
  const ledger = `/api/ortho/${caseId}/retention-ledger`;
  const recovery = await authedGet(`${ledger}/recovery?patientId=${patientId}`, h.sessions.admin);
  expect(recovery.status).toBe(200);
  const binding = await recovery.json();
  const identity = { patientId, clinicalCaseId: binding.scope.clinicalCaseId as number, actorId: binding.actorId as number };
  let headId: number | null = null;
  const occurrence = (occurredOn: string) => ({ occurredOn, dateProvenance: "historical_source" as const, sourceNote: "PRIVATE-SYNTHETIC-SOURCE-NOTE" });
  const append = async (content: RetentionEvent) => {
    const command: RetentionPersistenceCommand = { schemaVersion: 2, clientRequestId: randomUUID(), expectedHeadId: headId,
      reason: "Synthetic API documentary event", arch: "upper", supersedesEntryId: null, archCorrectionReason: null, expectedDocuments: [], content };
    const response = await authedMutation(ledger, h.sessions.admin, "POST", JSON.stringify({ ...identity, command }));
    const saved = await response.json(); expect(response.status, JSON.stringify(saved)).toBe(201);
    expect(saved.entryId).toBeGreaterThan(0); headId = saved.entryId as number;
    const acknowledged = await authedMutation(`${ledger}/recovery`, h.sessions.admin, "POST", JSON.stringify({ ...identity,
      commandId: command.clientRequestId, requestFingerprint: saved.requestFingerprint, action: "acknowledge" }));
    expect(acknowledged.status).toBe(200);
    return headId;
  };
  const deviceId = await append({ kind: "device_delivery", occurrence: occurrence("2026-10-01"), note: "PRIVATE-SYNTHETIC-CLINICAL-NOTE",
    documentIds: [], deviceType: "removable", description: "PRIVATE-SYNTHETIC-DEVICE-DESCRIPTION", extent: "Synthetic upper arch", labOrderId: null });
  const instructionId = await append({ kind: "followup_intent", occurrence: occurrence("2026-10-01"), note: "", documentIds: [],
    device: { deviceId, expectedDeviceRevisionId: deviceId }, dueOn: "2026-11-15", intervalDays: null, scope: "PRIVATE-SYNTHETIC-INSTRUCTION-SCOPE" });
  const reviewId = await append({ kind: "device_review", occurrence: occurrence("2026-10-15"), note: "", documentIds: [],
    device: { deviceId, expectedDeviceRevisionId: instructionId }, observations: {
      fit: { state: "not_assessed", note: "" }, breakage: { state: "not_assessed", note: "" }, loss: { state: "unknown", note: "" },
      hygiene: { state: "not_assessed", note: "" }, adherence: { state: "not_assessed", note: "" }, relapse: { state: "not_assessed", note: "" },
    } });
  return { patientId, caseId, patientName, deviceId, instructionId, reviewId };
}

it.each([390, 1280])("reads persisted retention instructions on the built board without treating a review as fulfillment at %ipx", async width => {
  const fixture = await recordedCase();
  const response = await authedGet("/api/ortho/followups", h.sessions.admin); expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const board = await response.json() as { buckets: { bucket: string; rows: FollowupRow[] }[] };
  const row = board.buckets.find(bucket => bucket.bucket === "retention")?.rows.find(item => item.caseId === fixture.caseId);
  expect(row).toMatchObject({ patientId: fixture.patientId, dueDate: null, daysSinceLast: null, dueBasis: "retention_schedule_unavailable",
    retentionContext: { state: "available", instructionState: "recorded", earliestRecordedDate: "2026-11-15",
      instructions: [{ eventId: fixture.instructionId, deviceId: fixture.deviceId, resolvedDate: "2026-11-15" }],
      devices: [{ deviceId: fixture.deviceId, reviews: [{ eventId: fixture.reviewId, timing: { occurredOn: "2026-10-15" } }] }] } });
  expect(row?.buckets.some(bucket => bucket.startsWith("lapsed_"))).toBe(false);
  expect(JSON.stringify(row)).not.toContain("PRIVATE-SYNTHETIC");
  const printed = await authedGet("/print/ortho-followups?bucket=retention", h.sessions.admin);
  expect(printed.status).toBe(200);
  const printedHtml = await printed.text();
  expect(printedHtml).toContain(fixture.patientName);
  expect(printedHtml).toContain("2026-11-15");
  expect(printedHtml).toContain("2026-10-15");
  expect(printedHtml).toContain('<details open=""');
  expect(printedHtml).not.toContain("PRIVATE-SYNTHETIC");
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const writes: string[] = [], errors: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`); return route.abort();
    }
    return route.continue();
  });
  try {
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${baseUrl}/ortho`);
    await page.getByRole("button", { name: /^حالات التثبيت/ }).click();
    const card = page.locator("li").filter({ has: page.getByRole("link", { name: fixture.patientName, exact: true }) });
    await card.waitFor();
    await card.getByText("تعليمات ومراجعات التثبيت المسجلة", { exact: true }).click();
    expect(await card.innerText()).toContain("2026-11-15");
    expect(await card.innerText()).toContain("2026-10-15");
    expect(await card.innerText()).toContain("مراجعة الجهاز لا تُغلق تعليمة سابقة تلقائياً");
    expect(await card.innerText()).toContain("لا موعد متابعة تقويم مؤكد");
    expect(await card.innerText()).not.toContain("PRIVATE-SYNTHETIC");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.screenshot({ path: `.settings-ui-artifacts/ortho-retention-context-${width}.png` });
    const caseLink = card.getByRole("link", { name: "ملف التقويم", exact: true });
    const target = new URL((await caseLink.getAttribute("href"))!, baseUrl);
    expect(target.pathname).toBe(`/patients/${fixture.patientId}`);
    expect(Object.fromEntries(target.searchParams)).toEqual({ tab: "treatment", sub: "ortho", patientId: String(fixture.patientId), orthoCaseId: String(fixture.caseId), pillar: "retention" });
    await caseLink.click();
    await page.getByRole("region", { name: "استعادة سجل التثبيت", exact: true }).waitFor();
    expect(new URL(page.url()).searchParams.get("orthoCaseId")).toBe(String(fixture.caseId));
    expect(new URL(page.url()).searchParams.get("pillar")).toBe("retention");
    expect(await page.getByTestId("ortho-context-unavailable").count()).toBe(0);
    expect(writes).toEqual([]); expect(errors).toEqual([]);
    const counts = (await db.query(`SELECT (SELECT count(*)::int FROM ortho_retention_entries WHERE patient_id=$1) entries,
      (SELECT count(*)::int FROM appointments WHERE patient_id=$1) appointments,
      (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,
      (SELECT count(*)::int FROM patient_opening_balances WHERE patient_id=$1) opening`, [fixture.patientId])).rows[0];
    expect(counts).toEqual({ entries: 3, appointments: 0, invoices: 0, opening: 0 });
  } finally { await context.close(); }
});
