import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import type { ProblemSourceRead, ProblemSourceCommand } from "../../lib/ortho-problem-sources";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

// Review finding on #483 (6871207083), real browser on the built app, synthetic data only.
// Today's visit already has a session (saved from another device with its own request key). A second,
// different session typed in the screen must not be reported as saved: the existing session is named,
// every typed value and queued photo stays in the form, no photo is attached to the existing session, the
// case wires and the follow-up come from the saved session only. The one-session-per-visit rule is kept.
// A lost response is also covered: after a reload, reconciling the unsaved request puts its values back.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
const out = ".settings-ui-artifacts/ortho-session-visit-duplicate";
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
  const patientName = `SYN visit duplicate ${label} ${width}`;
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


const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const state = async (caseId: number) => ({
  adjustments: (await db.query(`SELECT id, upper_wire, lower_wire, done, next_weeks, auxiliaries, auxiliary_other
    FROM ortho_adjustments WHERE case_id=$1 ORDER BY id`, [caseId])).rows,
  photos: (await db.query("SELECT count(*)::int AS n FROM patient_documents d JOIN ortho_adjustments a ON a.id=d.adjustment_id WHERE a.case_id=$1", [caseId])).rows[0].n,
  wires: (await db.query("SELECT upper_wire, lower_wire FROM ortho_cases WHERE id=$1", [caseId])).rows[0],
  receipts: (await db.query("SELECT count(*)::int AS n FROM ortho_adjustment_requests WHERE case_id=$1", [caseId])).rows[0].n,
});
async function savedElsewhere(caseId: number) {
  const response = await authedMutation(`/api/ortho/${caseId}`, h.sessions.admin, "POST", JSON.stringify({
    upperWire: "016 NiTi", lowerWire: "", elastics: "class_ii", elasticNote: "SYN other device", done: "SYN session saved on another device",
    nextWeeks: 4, auxiliaries: ["tpa"] }), { "Content-Type": "application/json", "Idempotency-Key": `syn-other-device-${randomUUID()}` });
  expect(response.status).toBe(201); return (await response.json()).id as number;
}
async function typeSecond(page: Page, form: Awaited<ReturnType<typeof openForm>>) {
  await page.getByRole("combobox", { name: "السلك العلوي", exact: true }).selectOption("019×025 SS");
  await form.getByTestId("adjustment-auxiliaries").locator("summary").click();
  await form.getByRole("checkbox", { name: "TAD / Mini-screw", exact: true }).check();
  await form.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }).fill("SYN second intention not saved");
  await form.locator('input[type="file"]:not([capture])').setInputFiles({ name: "syn.png", mimeType: "image/png", buffer: PNG });
}
async function expectRetained(page: Page, form: Awaited<ReturnType<typeof openForm>>) {
  expect(await form.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }).inputValue()).toBe("SYN second intention not saved");
  expect(await page.getByRole("combobox", { name: "السلك العلوي", exact: true }).inputValue()).toBe("019×025 SS");
  expect(await form.getByTestId("adjustment-auxiliaries-state").textContent()).toBe("TAD / Mini-screw");
}

for (const width of [390, 1280]) it(`does not report a second session in the same visit as saved at ${width}px`, async () => {
  const { patientId, caseId } = await fixedCase(width, "screen");
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho`);
    const form = await openForm(page);
    // The first session is saved elsewhere after this screen loaded, as with a second device.
    const existingId = await savedElsewhere(caseId);
    const before = await state(caseId);
    await typeSecond(page, form);
    await form.getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).click();
    await page.getByText(new RegExp(`جلسة شدّ مسجّلة سابقًا \\(رقم ${existingId}\\)؛ لم تُحفظ هذه الجلسة`)).first().waitFor();
    // Nothing from the refused request is presented as saved: no saved-session result and no follow-up
    // derived from its interval. (The visit-sign card may say the visit has a session: that is the
    // other device's session, read from the server.)
    expect(await page.getByText("📅 الجلسة القادمة المقترحة", { exact: true }).count()).toBe(0);
    // The refusal sits beside the save button and is on screen after the click, at phone width too.
    const alert = form.getByTestId("adjustment-refused");
    expect(await alert.textContent()).toContain(`رقم ${existingId}`);
    await alert.scrollIntoViewIfNeeded(); expect(await alert.isVisible()).toBe(true);
    // The history is refreshed to show the visit's existing session; the typed draft survives the refresh.
    await page.getByText("SYN session saved on another device").first().waitFor();
    await expectRetained(page, form);
    // The queued photo is still in the form and nothing was attached to the existing session.
    expect(await form.locator("img[src^='blob:']").count()).toBeGreaterThan(0);
    expect(await state(caseId)).toEqual(before);
    // The fixture's earlier session (four weeks ago) and today's session from the other device; nothing else.
    expect(before.adjustments.map((row: { done: string }) => row.done)).toEqual(["SYN earlier session", "SYN session saved on another device"]);
    expect(before.adjustments[1]).toMatchObject({ id: existingId, upper_wire: "016 NiTi", next_weeks: 4, auxiliaries: ["tpa"] });
    expect(before.wires).toEqual({ upper_wire: "016 NiTi", lower_wire: null });
    await page.screenshot({ path: `${out}/refused-${width}.png` });
    // After a reload the history shows only the saved session.
    await page.reload(); await page.getByText("SYN session saved on another device").first().waitFor();
    expect(await page.getByText("SYN second intention not saved").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 300_000);

it("puts the unsaved values back when a lost response is reconciled after a reload", async () => {
  const { patientId, caseId } = await fixedCase(1280, "lost");
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho`);
    const form = await openForm(page);
    const existingId = await savedElsewhere(caseId);
    const before = await state(caseId);
    // The server receives the request and refuses it, but the browser never sees the answer.
    await page.route(`**/api/ortho/${caseId}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch(); await route.abort("connectionreset");
    }, { times: 1 });
    await typeSecond(page, form);
    await form.getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).click();
    await page.getByTestId("ortho-write-uncertain").waitFor();
    expect(await state(caseId)).toEqual(before);
    await page.reload();
    const again = await openForm(page).catch(async () => page.locator("form").filter({ has: page.getByTestId("adjustment-reconcile") }));
    await page.getByTestId("adjustment-reconcile").click();
    await page.getByText(new RegExp(`جلسة شدّ مسجّلة سابقًا \\(رقم ${existingId}\\)`)).first().waitFor();
    // The typed values come back from the frozen request; nothing was recorded for it.
    expect(await again.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }).inputValue()).toBe("SYN second intention not saved");
    expect(await page.getByRole("combobox", { name: "السلك العلوي", exact: true }).inputValue()).toBe("019×025 SS");
    expect(await again.getByTestId("adjustment-auxiliaries-state").textContent()).toBe("TAD / Mini-screw");
    expect(await page.getByTestId("adjustment-reconcile").count()).toBe(0);
    expect(await state(caseId)).toEqual(before);
    await page.screenshot({ path: `${out}/lost-response-restored.png` });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 300_000);
