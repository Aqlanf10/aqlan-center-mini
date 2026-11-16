import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import type { ProblemSourceRead, ProblemSourceCommand } from "../../lib/ortho-problem-sources";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

// Measured evidence for 6838132093: a routine adjustment visit on a case in treatment, from opening the
// patient's orthodontic tab to a saved session. It counts the doctor's own actions (clicks and field
// entries) and page navigations, and saves synthetic screenshots at phone and desktop widths. The same
// script runs on the staging head (before) and the integration head (after); ORTHO_STEPS_LABEL names the
// run. Setup uses the real HTTP owners (intake, assessment, reviewed problem, strategy, treatment start,
// reception's open visit), as the daily-visit journey does. Only the earlier session, four weeks ago, is
// inserted directly, because the API records sessions on today's date.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
const label = process.env.ORTHO_STEPS_LABEL ?? "after";
const out = ".settings-ui-artifacts/ortho-routine-visit";
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(out, { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function post(path: string, body: unknown, status = 201) {
  const response = await authedMutation(path, h.sessions.admin, "POST", JSON.stringify(body));
  expect(response.status).toBe(status); return response.json();
}
async function get(path: string) {
  const response = await authedGet(path, h.sessions.admin); expect(response.status).toBe(200); return response.json();
}

async function caseInTreatment(width: number) {
  const patientName = `SYN routine visit ${label} ${width}`;
  const patientId = Number((await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [randomUUID(), patientName])).rows[0].id);
  const opened = await post("/api/ortho/intake", { patientId, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: "Synthetic assessment intake" } });
  const caseId = opened.orthoCaseId, clinicalCaseId = opened.clinicalCaseId;
  const actorId = (await get("/api/auth/me")).userId;
  const assessment = await post(`/api/ortho/${caseId}/assessment`, { ...assessmentCommandV2(), commandId: randomUUID() });
  const sources = await get(`/api/ortho/${caseId}/problem-sources?patientId=${patientId}`) as ProblemSourceRead;
  const candidate = sources.candidates.find(row => row.ref.kind === "assessment_observation" && row.ref.id === assessment.revision.id && row.ref.member === "width_11");
  if (!candidate) throw Error("Saved measurement source unavailable for explicit clinician review");
  const command: ProblemSourceCommand = { schemaVersion: 1, commandId: randomUUID(), source: candidate.ref,
    expectedReviewId: null, action: "create", problemId: null, label: "Synthetic explicitly reviewed concern",
    reason: "Synthetic clinician review only", clinicianReviewed: true };
  const problem = await post(`/api/ortho/${caseId}/problem-sources`, { patientId, clinicalCaseId, actorId, command });
  await post(`/api/ortho/${caseId}/problem-sources/recovery`, { patientId, clinicalCaseId, actorId, commandId: command.commandId,
    requestFingerprint: journeyContentHash(command), action: "acknowledge" }, 200);
  await post(`/api/ortho/${caseId}/strategy`, { schemaVersion: 1, commandId: randomUUID(), expectedRevisionId: null, reason: "Synthetic clinician-authored documentation",
    rows: [{ problemId: problem.problemId, objective: "Synthetic reviewed objective", strategy: "Synthetic documented approach", rationale: null, planItemIds: [] }] });
  const today = (await get(`/api/ortho?patientId=${patientId}`)).today;
  await post(`/api/ortho/${caseId}/treatment-start`, { patientId, command: { schemaVersion: 1, clientRequestId: randomUUID(),
    reason: "Synthetic explicit treatment start", confirmed: true, appliance: "aligners", arches: "upper",
    slot: null, startDate: today, plannedMonths: 12, bracketSystem: "" } });
  await db.query(`INSERT INTO ortho_adjustments(case_id,done_on,elastics,elastic_note,next_weeks,done,recorded_by)
    VALUES($1,CURRENT_DATE - 28,'class_ii','SYN 3/16 light, nights',4,'SYN earlier session for reference','synthetic-routine-steps')`, [caseId]);
  // Reception opens today's visit when the patient arrives; that is not the doctor's step.
  const visit = await post("/api/visits", { patientId, patientName });
  return { patientId, caseId, visitId: visit.id as number };
}

async function measure(width: number) {
  const { patientId, caseId, visitId } = await caseInTreatment(width);
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page: Page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let navigations = 0; page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  const actions: string[] = [];
  const act = async (what: string, run: () => Promise<unknown>) => { actions.push(what); await run(); };
  try {
    // Start: the doctor opens the patient's orthodontic tab (one navigation, not counted as an action).
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho`);
    const record = page.getByRole("button", { name: "⚡ سجّل شدّة وجلسة جديدة الآن", exact: true });
    // The visits section is named "مسار الأسلاك والشدّات" on staging and "زيارات المتابعة والشدّ" on the integration head.
    const visits = page.getByRole("button", { name: /^(مسار الأسلاك والشدّات|زيارات المتابعة والشدّ)$/ }).first();
    await visits.waitFor();
    await page.screenshot({ path: `${out}/${label}-case-${width}.png` });
    // A routine visit must start without a detour; when the visits section is not already open, the extra click is counted.
    if (!(await record.isVisible())) await act("open the visits section", () => visits.click());
    await act("record a new session", () => record.click());
    const form = page.locator("form").filter({ has: page.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }) });
    await form.waitFor();
    await page.screenshot({ path: `${out}/${label}-form-${width}.png` });
    await act("type what was done", () => form.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }).fill("SYN ligatures changed, elastics reviewed"));
    await act("save", () => form.getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).click());
    await page.getByText("سُجّلت الشدّة في زيارة اليوم.", { exact: true }).waitFor();
    await page.screenshot({ path: `${out}/${label}-saved-${width}.png` });
    const rows = (await db.query("SELECT visit_id,elastics,elastic_note,next_weeks FROM ortho_adjustments WHERE case_id=$1 ORDER BY id", [caseId])).rows;
    expect(rows).toHaveLength(2); expect(rows[1].visit_id).toBe(visitId);
    expect(errors).toEqual([]);
    return { width, actions, actionCount: actions.length, navigations, saved: rows[1] };
  } finally { await context.close(); }
}

it(`routine adjustment visit: actions and navigations to a saved session (${label})`, async () => {
  const results = [await measure(390), await measure(1280)];
  await writeFile(`${out}/${label}-steps.json`, JSON.stringify({ label, results }, null, 2));
  // The regimen carried into today's session is the one recorded last time, never an invented default.
  for (const result of results) expect(result.saved).toMatchObject({ elastics: "class_ii", next_weeks: 4 });
}, 300_000);
