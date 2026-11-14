import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import type { ProblemSourceRead, ProblemSourceCommand } from "../../lib/ortho-problem-sources";
import { journeyContentHash } from "../../lib/ortho-case-journey-hash";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import { adjustmentRequestHash } from "../../lib/ortho-adjustment-request-hash";

// Review on #483 (6873798343), real browser on the built app, synthetic data only.
// 1. Reload after a refusal: the typed values come back from session storage; queued photos are never
//    stored in the browser, so the page warns before a reload would lose them, offers saving them to the
//    device, and after the reload says how many were not kept. Nothing reaches the recorded session.
// 2. A receipt cached by an earlier screen (acknowledged B pointing to session A recorded from other values)
//    is not shown as saved and causes no follow-up or upload; a legitimate cached receipt still recovers.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
const out = ".settings-ui-artifacts/ortho-session-recovery";
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
  const patientName = `SYN recovery ${label} ${width}`;
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
  receipts: (await db.query("SELECT request_key, request_hash, adjustment_id FROM ortho_adjustment_requests WHERE case_id=$1 ORDER BY request_key", [caseId])).rows,
});
const bodyA = (today: string) => ({ doneOn: today, upperWire: "016 NiTi", lowerWire: "", elastics: "class_ii", elasticNote: "SYN A", done: "SYN session A", nextWeeks: 4, auxiliaries: ["tpa"] });
const bodyB = (today: string) => ({ doneOn: today, upperWire: "019×025 SS", lowerWire: "014 NiTi", elastics: "none", elasticNote: "",
  done: "SYN request B never saved", nextWeeks: 8, auxiliaries: ["tad", "other"], auxiliaryOther: "SYN Pendulum" });
async function saveA(caseId: number, today: string) {
  const response = await authedMutation(`/api/ortho/${caseId}`, h.sessions.admin, "POST", JSON.stringify(bodyA(today)),
    { "Content-Type": "application/json", "Idempotency-Key": `syn-recovery-a-${randomUUID()}` });
  expect(response.status).toBe(201); return (await response.json()) as { id: number; visitId: number };
}
async function open(width: number, init?: { storageKey: string; value: string }) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden", acceptDownloads: true });
  const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  if (init) await context.addInitScript(([key, command]) => { if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, command); }, [init.storageKey, init.value]);
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  return { context, page, errors };
}
const editableForm = (page: Page) => page.locator("form").filter({ has: page.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }) });
async function expectB(page: Page) {
  const form = editableForm(page);
  expect(await form.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }).inputValue()).toBe("SYN request B never saved");
  expect(await page.getByRole("combobox", { name: "السلك العلوي", exact: true }).inputValue()).toBe("019×025 SS");
  expect(await form.getByTestId("adjustment-auxiliaries-state").textContent()).toBe("TAD / Mini-screw، آخر: SYN Pendulum");
}

for (const width of [390, 1280]) it(`keeps a refused session's values across a reload and warns before queued photos are lost at ${width}px`, async () => {
  const { patientId, caseId } = await fixedCase(width, "reload");
  const today = (await get(`/api/ortho?patientId=${patientId}`)).today as string;
  const { context, page, errors } = await open(width);
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho`);
    const form = await openForm(page);
    const a = await saveA(caseId, today);
    const before = await state(caseId);
    await page.getByRole("combobox", { name: "السلك العلوي", exact: true }).selectOption("019×025 SS");
    await page.getByRole("combobox", { name: "السلك السفلي", exact: true }).selectOption("014 NiTi");
    await form.getByRole("combobox", { name: "صنف المطاطات", exact: true }).selectOption("none");
    await form.getByTestId("adjustment-auxiliaries").locator("summary").click();
    await form.getByRole("checkbox", { name: "TAD / Mini-screw", exact: true }).check();
    await form.getByRole("checkbox", { name: "آخر", exact: true }).check();
    await form.getByRole("textbox", { name: "اسم الجهاز المساعد الآخر", exact: true }).fill("SYN Pendulum");
    await form.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }).fill("SYN request B never saved");
    // A photo queued BEFORE the save that will be refused.
    await form.locator('input[type="file"]:not([capture])').setInputFiles({ name: "syn-b-before.png", mimeType: "image/png", buffer: PNG });
    expect(await form.locator("img[src^='blob:']").count()).toBe(1);
    await form.getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).click();
    const alert = page.getByTestId("adjustment-refused");
    await alert.waitFor(); expect(await alert.textContent()).toContain(`رقم ${a.id}`);
    // Before any reload: the queued photo is still here, the loss is stated, and it can be saved to the device.
    await page.getByText("SYN session A").first().waitFor();
    expect(await editableForm(page).locator("img[src^='blob:']").count()).toBe(1);
    expect(await page.getByTestId("adjustment-unsaved-photos").textContent()).toContain("ستُفقد عند إعادة التحميل");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "حفظ الصور غير المرفوعة على الجهاز", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("syn-b-before.png");
    // The reload is preceded by a leave-page warning while photos are queued.
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => { dialogs.push(dialog.type()); await dialog.accept(); });
    await page.reload(); await page.getByText("SYN session A").first().waitFor();
    expect(dialogs).toContain("beforeunload");
    // After the reload: B's values come back, the notice says the photo was not kept, nothing was uploaded.
    await openForm(page);
    await expectB(page);
    const notice = await page.getByTestId("adjustment-refused").textContent();
    expect(notice).toContain("استُعيدت قيم جلسة لم تُحفظ");
    expect(notice).toContain(`رقم ${a.id}`);
    expect(notice).toContain("كانت 1 صورة في الطابور ولم تُرفع");
    expect(await editableForm(page).locator("img[src^='blob:']").count()).toBe(0);
    expect(await page.getByText("📅 الجلسة القادمة المقترحة", { exact: true }).count()).toBe(0);
    expect(await state(caseId)).toEqual(before);
    await page.screenshot({ path: `${out}/restored-${width}.png` });
    // Dismissing forgets the values: the next reload opens an empty, unrecorded session form.
    await page.getByTestId("adjustment-refusal-dismiss").click();
    await page.reload(); await page.getByText("SYN session A").first().waitFor();
    await openForm(page);
    expect(await editableForm(page).getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }).inputValue()).toBe("");
    expect(await page.getByTestId("adjustment-refused").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 300_000);

for (const width of [390, 1280]) it(`does not show a cached acknowledgement bound to another session as saved at ${width}px`, async () => {
  const { patientId, caseId } = await fixedCase(width, "cached");
  const actorId = (await get("/api/auth/me")).userId as number;
  const today = (await get(`/api/ortho?patientId=${patientId}`)).today as string;
  const a = await saveA(caseId, today);
  // What an earlier screen and server left behind: receipt B (B's fingerprint) bound to A, and the
  // browser's acknowledged command B carrying that receipt.
  const key = `syn-cached-b-${randomUUID()}`;
  const hash = adjustmentRequestHash(actorId, patientId, { caseId, visitId: null, doneOn: today, phase: null, upperWire: "019×025 SS",
    lowerWire: "014 NiTi", elastics: "none", elasticNote: null, done: "SYN request B never saved", nextWeeks: 8, note: null,
    recordedBy: "seed", auxiliaries: ["tad", "other"], auxiliaryOther: "SYN Pendulum" }, today);
  await db.query(`INSERT INTO ortho_adjustment_requests(actor_user_id,request_key,request_hash,patient_id,case_id,adjustment_id,visit_id,attached_to_today)
    VALUES($1,$2,$3,$4,$5,$6,$7,TRUE)`, [actorId, key, hash, patientId, caseId, a.id, a.visitId]);
  const before = await state(caseId);
  const scope = { patientId, caseId, authority: `user:${actorId}` };
  const storageKey = `ortho-adjustment:v1:${JSON.stringify([patientId, caseId, scope.authority])}`;
  const { context, page, errors } = await open(width, { storageKey, value: JSON.stringify({ version: 1, scope, key, body: JSON.stringify(bodyB(today)),
    receipt: { id: a.id, patientId, caseId, requestKey: key, visitId: a.visitId, attachedToToday: true } }) });
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho`);
    await page.getByRole("button", { name: "⚡ سجّل شدّة وجلسة جديدة الآن", exact: true }).click();
    const alert = page.getByTestId("adjustment-refused");
    await alert.waitFor();
    expect(await alert.textContent()).toContain(`(رقم ${a.id}) بقيم مختلفة`);
    // Not saved: no saved status for A, no new-intent shortcut, no follow-up, no reconcile; B's values back.
    expect(await page.getByText(`تم حفظ الشدّة رقم ${a.id}`).count()).toBe(0);
    expect(await page.getByTestId("adjustment-new-intent").count()).toBe(0);
    expect(await page.getByTestId("adjustment-reconcile").count()).toBe(0);
    expect(await page.getByText("📅 الجلسة القادمة المقترحة", { exact: true }).count()).toBe(0);
    await expectB(page);
    expect(await page.evaluate((k) => sessionStorage.getItem(k), storageKey)).toBeNull();
    expect(await state(caseId)).toEqual(before);
    await page.screenshot({ path: `${out}/cached-${width}.png` });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 300_000);

it("still recovers a legitimate cached acknowledgement whose session holds the request's values", async () => {
  const { patientId, caseId } = await fixedCase(1280, "legit");
  const actorId = (await get("/api/auth/me")).userId as number;
  const today = (await get(`/api/ortho?patientId=${patientId}`)).today as string;
  const key = `syn-legit-a-${randomUUID()}`;
  const saved = await authedMutation(`/api/ortho/${caseId}`, h.sessions.admin, "POST", JSON.stringify(bodyA(today)),
    { "Content-Type": "application/json", "Idempotency-Key": key });
  expect(saved.status).toBe(201); const a = await saved.json();
  const scope = { patientId, caseId, authority: `user:${actorId}` };
  const storageKey = `ortho-adjustment:v1:${JSON.stringify([patientId, caseId, scope.authority])}`;
  const { context, page, errors } = await open(1280, { storageKey, value: JSON.stringify({ version: 1, scope, key, body: JSON.stringify(bodyA(today)),
    receipt: { id: a.id, patientId, caseId, requestKey: key, visitId: a.visitId, attachedToToday: true } }) });
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho`);
    await page.getByRole("button", { name: "⚡ سجّل شدّة وجلسة جديدة الآن", exact: true }).click();
    await page.getByText(`تم حفظ الشدّة رقم ${a.id}`).first().waitFor();
    expect(await page.getByTestId("adjustment-refused").count()).toBe(0);
    await page.getByTestId("adjustment-new-intent").click();
    await editableForm(page).waitFor();
    expect(await page.evaluate((k) => sessionStorage.getItem(k), storageKey)).toBeNull();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 300_000);
