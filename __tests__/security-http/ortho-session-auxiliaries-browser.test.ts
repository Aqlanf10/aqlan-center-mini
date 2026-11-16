import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import type { ProblemSourceRead, ProblemSourceCommand } from "../../lib/ortho-problem-sources";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

// Owner, #483 2026-11-13 23:17/23:20 UTC, and Dot, #483 6867852606 (migration 0132): optional auxiliary
// appliances in the adjustment session, documentation only. Checked with synthetic data on the built app at
// 390px and 1280px:
// - the section is collapsed and unselected; saving without opening it keeps the routine 3 actions and
//   stores "not recorded";
// - an earlier session reads as "not recorded", never as "none", and nothing is prefilled from it;
// - a list with «آخر» is chosen, saved and reopened; an explicit "none" is a separate state.
// One session per case: the writer attaches a session to today's visit and returns the existing one on a
// second save in the same visit (unchanged behaviour), so each state uses its own synthetic case.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
const out = ".settings-ui-artifacts/ortho-session-auxiliaries";
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

async function fixedCase(width: number, label: string) {
  const patientName = `SYN auxiliaries ${label} ${width}`;
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
  // A new appliance type (owner, #483) through the real treatment-start command.
  await post(`/api/ortho/${caseId}/treatment-start`, { patientId, command: { schemaVersion: 1, clientRequestId: randomUUID(),
    reason: "Synthetic explicit treatment start", confirmed: true, appliance: "self_ligating_metal", arches: "both",
    slot: "022", startDate: today, plannedMonths: 18, bracketSystem: "SYN passive SL" } });
  // A session saved before 0132: its auxiliaries are NULL ("not recorded").
  await db.query(`INSERT INTO ortho_adjustments(case_id,done_on,elastics,next_weeks,done,recorded_by)
    VALUES($1,CURRENT_DATE-28,'none',4,'SYN earlier session','synthetic')`, [caseId]);
  await post("/api/visits", { patientId, patientName });
  return { patientId, caseId };
}

async function openForm(page: Page) {
  await page.getByRole("button", { name: "⚡ سجّل شدّة وجلسة جديدة الآن", exact: true }).click();
  const form = page.locator("form").filter({ has: page.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }) });
  await form.waitFor(); return form;
}
const optionValues = (page: Page, label: string) => page.getByRole("combobox", { name: label, exact: true }).locator("option").evaluateAll(nodes => nodes.map(n => (n as HTMLOptionElement).value));


const rows = async (caseId: number) => (await db.query("SELECT done,auxiliaries,auxiliary_other FROM ortho_adjustments WHERE case_id=$1 ORDER BY id", [caseId])).rows;
type Mode = "untouched" | "list" | "none";
const EXPECTED: Record<Mode, { auxiliaries: string[] | null; auxiliary_other: string | null; text: string }> = {
  untouched: { auxiliaries: null, auxiliary_other: null, text: "غير مسجّلة في هذه الجلسة" },
  list: { auxiliaries: ["tad", "other"], auxiliary_other: "SYN Pendulum", text: "TAD / Mini-screw، آخر: SYN Pendulum" },
  none: { auxiliaries: [], auxiliary_other: null, text: "لا أجهزة مساعدة (سُجّل صراحةً)" },
};

for (const width of [390, 1280]) for (const mode of ["untouched", "list", "none"] as const) it(`saves auxiliaries "${mode}" in one session and reopens it at ${width}px`, async () => {
  const { patientId, caseId } = await fixedCase(width, mode);
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let actions = 0;
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho`);
    const form = await openForm(page); actions++;
    // Collapsed, unselected, and not carried over from the earlier session.
    const section = form.getByTestId("adjustment-auxiliaries");
    expect(await section.evaluate(node => (node as HTMLDetailsElement).open)).toBe(false);
    expect(await form.getByTestId("adjustment-auxiliaries-state").textContent()).toBe("غير مسجّلة في هذه الجلسة");
    if (mode !== "untouched") {
      await section.locator("summary").click();
      expect(await section.getByRole("checkbox", { checked: true }).count()).toBe(0);
    }
    if (mode === "list") {
      await form.getByRole("checkbox", { name: "TAD / Mini-screw", exact: true }).check();
      await form.getByRole("checkbox", { name: "آخر", exact: true }).check();
      await form.getByRole("textbox", { name: "اسم الجهاز المساعد الآخر", exact: true }).fill("SYN Pendulum");
      await page.screenshot({ path: `${out}/form-${mode}-${width}.png` });
    }
    if (mode === "none") await form.getByRole("checkbox", { name: "لا توجد أجهزة مساعدة في هذه الجلسة", exact: true }).check();
    expect(await form.getByTestId("adjustment-auxiliaries-state").textContent()).toBe(EXPECTED[mode].text);
    await form.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }).fill(`SYN session ${mode}`); actions++;
    await form.getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).click(); actions++;
    await page.getByText("سُجّلت الشدّة في زيارة اليوم.", { exact: true }).waitFor();
    // The routine path without the optional section stays at 3 actions.
    if (mode === "untouched") expect(actions).toBe(3);
    const { text, ...saved } = EXPECTED[mode];
    expect(await rows(caseId)).toEqual([
      { done: "SYN earlier session", auxiliaries: null, auxiliary_other: null },
      { done: `SYN session ${mode}`, ...saved },
    ]);
    // Reopen: the earlier session reads "not recorded"; this session reads its own state.
    await page.reload(); await page.getByText("سُجّلت الشدّة في زيارة اليوم.", { exact: true }).waitFor();
    if (mode === "list") await page.getByTestId("session-auxiliaries").filter({ hasText: text }).first().waitFor();
    else expect(await page.getByTestId("session-auxiliaries").count()).toBe(0);
    const details = page.locator("details").filter({ has: page.getByText(/تفاصيل الجلسة المسجلة #/) });
    for (let index = 0; index < await details.count(); index++) await details.nth(index).locator("summary").click();
    const shown = await details.getByText(/^(غير مسجّلة في هذه الجلسة|لا أجهزة مساعدة \(سُجّل صراحةً\)|TAD \/ Mini-screw، آخر: SYN Pendulum)$/).allTextContents();
    expect(shown).toEqual([text, "غير مسجّلة في هذه الجلسة"]);
    await page.screenshot({ path: `${out}/history-${mode}-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 300_000);
