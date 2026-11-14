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

// Follow-up review on #483 (6872647524), real browser on the built app, synthetic data only. Upgrade
// fixture: a receipt written before the same-visit fix binds request B (its own fingerprint) to session A,
// recorded from other values, and the browser still holds B as an unresolved request. This reproduces a
// possible historical state; it is not evidence that such rows exist.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
const out = ".settings-ui-artifacts/ortho-session-legacy-receipt";
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
  const patientName = `SYN legacy receipt ${label} ${width}`;
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

for (const width of [390, 1280]) it(`does not treat a historical receipt bound to another session as saved at ${width}px`, async () => {
  const { patientId, caseId } = await fixedCase(width, "legacy");
  const actorId = (await get("/api/auth/me")).userId as number;
  const today = (await get(`/api/ortho?patientId=${patientId}`)).today as string;
  // Session A, saved normally in today's visit.
  const a = await authedMutation(`/api/ortho/${caseId}`, h.sessions.admin, "POST", JSON.stringify({ doneOn: today, upperWire: "016 NiTi", lowerWire: "",
    elastics: "class_ii", elasticNote: "SYN A", done: "SYN session A", nextWeeks: 4, auxiliaries: ["tpa"] }),
    { "Content-Type": "application/json", "Idempotency-Key": `syn-legacy-a-${randomUUID()}` });
  expect(a.status).toBe(201); const aId = (await a.json()).id as number;
  const { rows: [{ visit_id: visitId }] } = await db.query("SELECT visit_id FROM ortho_adjustments WHERE id=$1", [aId]);
  // Request B and the receipt the pre-fix writer stored for it: B's fingerprint, A's session.
  const key = `syn-legacy-b-${randomUUID()}`;
  const bBody = { doneOn: today, upperWire: "019×025 SS", lowerWire: "014 NiTi", elastics: "none", elasticNote: "",
    done: "SYN request B never saved", nextWeeks: 8, auxiliaries: ["tad", "other"], auxiliaryOther: "SYN Pendulum" };
  const hash = adjustmentRequestHash(actorId, patientId, { caseId, visitId: null, doneOn: today, phase: null, upperWire: "019×025 SS",
    lowerWire: "014 NiTi", elastics: "none", elasticNote: null, done: "SYN request B never saved", nextWeeks: 8, note: null,
    recordedBy: "seed", auxiliaries: ["tad", "other"], auxiliaryOther: "SYN Pendulum" }, today);
  await db.query(`INSERT INTO ortho_adjustment_requests(actor_user_id,request_key,request_hash,patient_id,case_id,adjustment_id,visit_id,attached_to_today)
    VALUES($1,$2,$3,$4,$5,$6,$7,TRUE)`, [actorId, key, hash, patientId, caseId, aId, visitId]);
  const before = await state(caseId);
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  // The browser still holds B as an unresolved request, as a tab kept open across the upgrade would.
  const scope = { patientId, caseId, authority: `user:${actorId}` };
  await context.addInitScript(([storageKey, command]) => { if (!sessionStorage.getItem(storageKey)) sessionStorage.setItem(storageKey, command); },
    [`ortho-adjustment:v1:${JSON.stringify([patientId, caseId, scope.authority])}`, JSON.stringify({ version: 1, scope, key, body: JSON.stringify(bBody), receipt: null })]);
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho`);
    await page.getByRole("button", { name: "⚡ سجّل شدّة وجلسة جديدة الآن", exact: true }).click();
    const form = page.locator("form").filter({ has: page.getByTestId("adjustment-reconcile") });
    await form.waitFor();
    // A photo queued for B before the user checks the pending request.
    await form.locator('input[type="file"]:not([capture])').setInputFiles({ name: "syn-b.png", mimeType: "image/png", buffer: PNG });
    await page.getByTestId("adjustment-reconcile").click();
    const alert = page.getByTestId("adjustment-refused");
    await alert.waitFor();
    expect(await alert.textContent()).toContain(`(رقم ${aId})`);
    expect(await alert.textContent()).toContain("لم يُعتبر محفوظًا");
    // Not saved, no follow-up from B, B's values back in the form, B's photo still queued, A untouched.
    expect(await page.getByText("📅 الجلسة القادمة المقترحة", { exact: true }).count()).toBe(0);
    expect(await page.getByTestId("adjustment-reconcile").count()).toBe(0);
    const editable = page.locator("form").filter({ has: page.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }) });
    expect(await editable.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true }).inputValue()).toBe("SYN request B never saved");
    expect(await page.getByRole("combobox", { name: "السلك العلوي", exact: true }).inputValue()).toBe("019×025 SS");
    expect(await editable.getByTestId("adjustment-auxiliaries-state").textContent()).toBe("TAD / Mini-screw، آخر: SYN Pendulum");
    expect(await editable.locator("img[src^='blob:']").count()).toBeGreaterThan(0);
    await page.getByText("SYN session A").first().waitFor();
    expect(await state(caseId)).toEqual(before);
    await page.screenshot({ path: `${out}/legacy-${width}.png` });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 300_000);
