import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import type { ProblemSourceRead, ProblemSourceCommand } from "../../lib/ortho-problem-sources";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

// Owner, #483 2026-11-13: expand wire and appliance options in the adjustment session without changing
// its steps or order. Checked with synthetic data on the built app at 390px and 1280px:
// - a case started with a new appliance type (self-ligating metal) shows its label;
// - an old wire recorded outside every list is shown and kept;
// - a catalog wire and a typed "other" wire are chosen, saved and reopened;
// - the session keeps the same actions; the usual sequence is offered first.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
const out = ".settings-ui-artifacts/ortho-session-wire-options";
const LEGACY = "SYN legacy 0.0195 braided";
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

async function fixedCase(width: number) {
  const patientName = `SYN wire options ${width}`;
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
  // An old wire recorded outside every list, as historical data may hold.
  await db.query("UPDATE ortho_cases SET upper_wire=$1, lower_wire='014 NiTi' WHERE id=$2", [LEGACY, caseId]);
  await post("/api/visits", { patientId, patientName });
  return { patientId, caseId };
}

async function openForm(page: Page) {
  await page.getByRole("button", { name: "⚡ سجّل شدّة وجلسة جديدة الآن", exact: true }).click();
  const form = page.locator("form").filter({ has: page.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }) });
  await form.waitFor(); return form;
}
const optionValues = (page: Page, label: string) => page.getByRole("combobox", { name: label, exact: true }).locator("option").evaluateAll(nodes => nodes.map(n => (n as HTMLOptionElement).value));

for (const width of [390, 1280]) it(`chooses, saves and reopens catalog and other wires at ${width}px without new steps`, async () => {
  const { patientId, caseId } = await fixedCase(width);
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho`);
    // Follow-up visits are the first case section and open by default.
    const sections = page.getByRole("navigation", { name: "أقسام حالة التقويم", exact: true });
    expect((await sections.getByRole("button").first().getAttribute("aria-label"))).toBe("زيارات المتابعة والشدّ");
    await page.getByText("ثابت ذاتي الربط معدني", { exact: false }).first().waitFor();
    const form = await openForm(page);
    const upper = page.getByRole("combobox", { name: "السلك العلوي", exact: true });
    // Old off-list wire stays selected and listed; sequence first; catalog and "other" are available.
    expect(await upper.inputValue()).toBe(LEGACY);
    const values = await optionValues(page, "السلك العلوي");
    expect(values[0]).toBe(""); expect(values[1]).toBe(LEGACY); expect(values[2]).toBe("012 NiTi");
    for (const code of ["018×025 SS", "016 CuNiTi", "017×025 HA NiTi", "0175 Braided SS", "019×025 TMA", "__other__"]) expect(values).toContain(code);
    await page.screenshot({ path: `${out}/form-${width}.png` });
    await upper.selectOption("018×025 SS");
    await page.getByRole("combobox", { name: "السلك السفلي", exact: true }).selectOption("__other__");
    await form.getByRole("textbox", { name: "سلك سفلي آخر", exact: true }).fill("SYN 0.0215 lingual NiTi");
    await form.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }).fill("SYN wire change documented");
    await form.getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).click();
    await page.getByText("سُجّلت الشدّة في زيارة اليوم.", { exact: true }).waitFor();
    const saved = (await db.query("SELECT upper_wire,lower_wire FROM ortho_adjustments WHERE case_id=$1 ORDER BY id DESC LIMIT 1", [caseId])).rows[0];
    expect(saved).toEqual({ upper_wire: "018×025 SS", lower_wire: "SYN 0.0215 lingual NiTi" });
    expect((await db.query("SELECT upper_wire,lower_wire FROM ortho_cases WHERE id=$1", [caseId])).rows[0]).toEqual({ upper_wire: "018×025 SS", lower_wire: "SYN 0.0215 lingual NiTi" });
    // Reopen: the case shows the saved wires and a new session lists the typed wire as recorded.
    await page.reload(); await page.getByText("سُجّلت الشدّة في زيارة اليوم.", { exact: true }).waitFor();
    const startAgain = page.getByRole("button", { name: "⚡ سجّل شدّة وجلسة جديدة الآن", exact: true });
    const newIntent = page.getByRole("button", { name: "تسجيل شدّة جديدة مستقلة", exact: true });
    if (await startAgain.isVisible()) await startAgain.click();
    if (await newIntent.isVisible()) await newIntent.click();
    await page.getByRole("combobox", { name: "السلك السفلي", exact: true }).waitFor();
    const reopened = await optionValues(page, "السلك السفلي");
    expect(reopened).toContain("SYN 0.0215 lingual NiTi");
    expect(await page.getByRole("combobox", { name: "السلك العلوي", exact: true }).inputValue()).toBe("018×025 SS");
    await page.screenshot({ path: `${out}/reopened-${width}.png` });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 240_000);
