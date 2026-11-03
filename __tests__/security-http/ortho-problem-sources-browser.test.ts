import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { Client } from "pg";
import { chromium, type Browser, type Locator } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import type { ProblemSourceRead } from "../../lib/ortho-problem-sources";
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => { h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http"); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect(); browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined }); await mkdir(".settings-ui-artifacts", { recursive: true }); });
afterAll(async () => { await browser?.close(); await db?.end(); });
async function setup() {
  const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'مصادر مشاكل اصطناعية') RETURNING id", [`SYN-PROBLEM-UI-${randomUUID()}`])).rows[0].id;
  const opened = await authedMutation("/api/ortho/intake", h.sessions.admin, "POST", JSON.stringify({ patientId, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: "حالة اصطناعية لربط المشاكل" } })); expect(opened.status).toBe(201);
  const { orthoCaseId } = await opened.json(), bytes = await sharp({ create: { width: 600, height: 240, channels: 3, background: "#34667b" } }).png().toBuffer(), sha256 = createHash("sha256").update(bytes).digest("hex");
  const form = new FormData(); form.set("patientId", String(patientId)); form.set("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "synthetic-source.png");
  form.set("command", JSON.stringify({ schemaVersion: 1, clientRequestId: randomUUID(), title: "بانوراما اصطناعية للمصدر", photoView: "panoramic", photoStage: "initial", occurrence: { state: "known", takenOn: "2026-10-01", sourceNote: "رسم لوني اصطناعي للاختبار فقط" }, file: { sha256, mimeType: "image/png", sizeBytes: bytes.length } }));
  const upload = await fetch(`${baseUrl}/api/ortho/${orthoCaseId}/record-uploads`, { method: "POST", headers: { Cookie: h.sessions.admin.cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" }, body: form }); expect(upload.status).toBe(201); const { documentId } = await upload.json();
  const command = assessmentCommandV2(); command.commandId = randomUUID();
  command.content.observations.observations.push({ id: `panoramic_v1_${documentId}_tooth_13`, definition: "clinical_finding", definitionVersion: 1, unit: "qualitative", label: "قراءة السن الاصطناعي FDI 13", target: { kind: "tooth", tooth: 13 }, value: { state: "recorded", text: "ملاحظة الطبيب الاصطناعية من الصورة" }, occurredOn: { state: "known", date: "2026-10-02" }, provenance: { performer: { state: "documented", attribution: "طبيب الاختبار" }, method: { kind: "direct_examination", version: 1, description: "قراءة الرسم الاصطناعي" }, sources: [{ kind: "document", id: documentId, version: `sha256:${sha256}` }], copiedFrom: null } });
  const saved = await authedMutation(`/api/ortho/${orthoCaseId}/assessment`, h.sessions.admin, "POST", JSON.stringify(command)); expect(saved.status).toBe(201); const assessment = await saved.json();
  return { patientId, orthoCaseId, command, revisionId: assessment.revision.id };
}
async function fillReview(panel: Locator, identity: string, label: string) {
  await panel.getByRole("combobox", { name: "مصدر المشكلة", exact: true }).selectOption(identity);
  await panel.getByRole("textbox", { name: "المشكلة بعد مراجعة الطبيب", exact: true }).fill(label);
  await panel.getByRole("textbox", { name: "سبب مراجعة وربط المصدر", exact: true }).fill("مراجعة مصدر اصطناعي صريحة");
  await panel.getByRole("checkbox", { name: "راجعت المصدر وأقرّ ارتباطه بهذه المشكلة", exact: true }).check();
}
describe("source review on the built unified orthodontic patient workflow", () => {
  it("enforces current HTTP roles, exact case/source scope and private responses", async () => {
    const x = await setup(), endpoint = `/api/ortho/${x.orthoCaseId}/problem-sources`;
    const read = await authedGet(`${endpoint}?patientId=${x.patientId}`, h.sessions.admin); expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toContain("no-store");
    const candidate = (await read.json() as ProblemSourceRead).candidates.find(c => c.category === "قراءة بانوراما")!;
    const command = { schemaVersion: 1, commandId: randomUUID(), source: candidate.ref, expectedReviewId: null, action: "create", problemId: null, label: "مشكلة اختبار صلاحيات", reason: "مراجعة اصطناعية", clinicianReviewed: true };
    const body = JSON.stringify({ patientId: x.patientId, command });
    for (const role of ["reception", "accountant", "doctorB"] as const) expect((await authedMutation(endpoint, h.sessions[role], "POST", body)).status).toBe(403);
    expect((await fetch(`${baseUrl}${endpoint}?patientId=${x.patientId}`)).status).toBe(401);
    expect((await authedGet(`${endpoint}?patientId=${h.seeded.patientBId}`, h.sessions.admin)).status).toBe(404);
    expect((await authedGet(`${endpoint}?patientId=${x.patientId}&patientId=${x.patientId}`, h.sessions.admin)).status).toBe(400);
    expect((await authedMutation(endpoint, h.sessions.admin, "POST", JSON.stringify({ patientId: x.patientId, command: { ...command, clinicianReviewed: false } }))).status).toBe(400);
    const forged = await authedMutation(endpoint, h.sessions.admin, "POST", JSON.stringify({ patientId: x.patientId, command: { ...command, source: { ...candidate.ref, version: `sha256:${"0".repeat(64)}` } } }));
    expect(forged.status).toBe(409); expect(forged.headers.get("cache-control")).toContain("no-store"); expect((await db.query("SELECT id FROM patient_problems WHERE patient_id=$1", [x.patientId])).rows).toEqual([]);
  });
  it.each([390, 1280])("keeps one problem and plan reference through lost replies, stale tabs and corrected source at %ipx", async width => {
    const x = await setup(), endpoint = `/api/ortho/${x.orthoCaseId}/problem-sources`, url = `${baseUrl}/patients/${x.patientId}?tab=treatment&sub=ortho&orthoCaseId=${x.orthoCaseId}&pillar=diagnostics#ortho-assessment/${x.patientId}/${x.orthoCaseId}/diagnosis`;
    const read = async () => { const response = await authedGet(`${endpoint}?patientId=${x.patientId}`, h.sessions.admin); const payload = await response.json(); expect(response.status, JSON.stringify(payload)).toBe(200); return payload as ProblemSourceRead; };
    const initial = await read(), pano = initial.candidates.find(c => c.category === "قراءة بانوراما")!, analysis = initial.candidates.find(c => c.ref.kind === "assessment_analysis")!;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" }), [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), stale = await context.newPage(), errors: string[] = [], sent: string[] = []; page.setDefaultTimeout(20000); stale.setDefaultTimeout(20000); page.on("pageerror", e => errors.push(e.message));
    const panel = page.getByRole("region", { name: "مصادر قائمة المشاكل الموحدة", exact: true }), stalePanel = stale.getByRole("region", { name: "مصادر قائمة المشاكل الموحدة", exact: true });
    try {
      await page.goto(url); await stale.goto(url);
      await panel.getByRole("combobox", { name: "مصدر المشكلة", exact: true }).selectOption(analysis.identity); expect(await panel.getByRole("textbox", { name: "المشكلة بعد مراجعة الطبيب", exact: true }).inputValue()).toBe("");
      await fillReview(panel, pano.identity, "مشكلة اصطناعية راجعها الطبيب"); await fillReview(stalePanel, pano.identity, "مسودة من تبويب قديم");
      await page.getByRole("button", { name: "المقابلة والتاريخ", exact: true }).click(); await page.getByRole("button", { name: "التشخيص وقائمة المشاكل", exact: true }).click();
      expect(await panel.getByRole("textbox", { name: "المشكلة بعد مراجعة الطبيب", exact: true }).inputValue()).toBe("مشكلة اصطناعية راجعها الطبيب");
      await page.route(`**${endpoint}`, async route => { if (route.request().method() !== "POST") return route.continue(); sent.push(route.request().postData()!); const response = await route.fetch(); if (sent.length === 1) { expect(response.status()).toBe(201); return route.abort("failed"); } expect(response.status()).toBe(200); return route.fulfill({ response }); });
      await panel.getByRole("button", { name: "حفظ المشكلة ومراجعة مصدرها", exact: true }).click(); await panel.getByRole("button", { name: "التحقق بإعادة نفس طلب المشكلة", exact: true }).click();
      await panel.getByText("المصدر يطابق النسخة المراجعة", { exact: true }).waitFor(); expect(sent).toHaveLength(2); expect(sent[0]).toBe(sent[1]); await page.unroute(`**${endpoint}`);
      const saved = await read(); expect(saved.problems).toHaveLength(1); const problemId = saved.problems[0].id;
      await stalePanel.getByRole("button", { name: "حفظ المشكلة ومراجعة مصدرها", exact: true }).click(); await stalePanel.getByText("تغيرت مراجعة المصدر؛ بقيت مسودتك دون تحويلها إلى النسخة الجديدة.", { exact: true }).waitFor();
      expect(await stalePanel.getByRole("textbox", { name: "المشكلة بعد مراجعة الطبيب", exact: true }).inputValue()).toBe("مسودة من تبويب قديم");
      await panel.getByRole("combobox", { name: "مصدر المشكلة", exact: true }).selectOption(analysis.identity); await panel.getByRole("combobox", { name: "طريقة ربط المشكلة", exact: true }).selectOption("link");
      await panel.getByRole("combobox", { name: "المشكلة الموجودة", exact: true }).selectOption(String(problemId)); await panel.getByRole("textbox", { name: "سبب مراجعة وربط المصدر", exact: true }).fill("ربط نتيجة القياس بعد تفسير الطبيب دون تكرار المشكلة"); await panel.getByRole("checkbox").check();
      await panel.getByRole("button", { name: "حفظ المشكلة ومراجعة مصدرها", exact: true }).click(); await expect.poll(async () => (await read()).reviews.length).toBe(2);
      await page.getByRole("button", { name: "الانتقال إلى أهداف وخطة الحالة", exact: true }).click(); const strategy = page.getByTestId("ortho-strategy-editor");
      await strategy.getByRole("button", { name: "بدء خطة الحالة من نموذج فارغ", exact: true }).click(); await strategy.getByRole("listbox", { name: "المشكلة", exact: true }).selectOption(String(problemId));
      await strategy.getByRole("textbox", { name: "الهدف (نص الطبيب)", exact: true }).fill("هدف اصطناعي مرتبط بالمشكلة نفسها"); await strategy.getByRole("textbox", { name: "الاستراتيجية (نص الطبيب)", exact: true }).fill("استراتيجية اصطناعية يكتبها الطبيب"); await strategy.getByRole("textbox", { name: "سبب توثيق هذه النسخة (مطلوب)", exact: true }).fill("اختبار ترابط الحالة"); await strategy.getByRole("button", { name: "حفظ نسخة خطة الحالة", exact: true }).click(); await strategy.getByTestId("ortho-strategy-saved").waitFor();
      const correction = structuredClone(x.command); correction.commandId = randomUUID(); correction.expectedRevisionId = x.revisionId; correction.content.observations.observations.find(o => o.id === pano.ref.member)!.value = { state: "recorded", text: "تصحيح موثق للمصدر الاصطناعي" };
      expect((await authedMutation(`/api/ortho/${x.orthoCaseId}/assessment`, h.sessions.admin, "POST", JSON.stringify(correction))).status).toBe(201);
      await page.getByRole("button", { name: "السجلات والسيفالومتري (WebCeph)", exact: true }).click(); await page.getByRole("button", { name: "التشخيص وقائمة المشاكل", exact: true }).click(); await panel.getByText("للمصدر نسخة أحدث تحتاج مراجعتك؛ لم تتغير المشكلة المحفوظة", { exact: true }).first().waitFor();
      expect((await read()).problems).toEqual(saved.problems); await panel.getByRole("combobox", { name: "مصدر المشكلة", exact: true }).selectOption(pano.identity); expect(await panel.getByRole("combobox", { name: "طريقة ربط المشكلة", exact: true }).inputValue()).toBe("link");
      expect(await panel.getByRole("combobox", { name: "المشكلة الموجودة", exact: true }).inputValue()).toBe(String(problemId)); await panel.getByRole("textbox", { name: "سبب مراجعة وربط المصدر", exact: true }).fill("مراجعة التصحيح مع إبقاء المشكلة المعتمدة"); await panel.getByRole("checkbox").check(); await panel.getByRole("button", { name: "حفظ المشكلة ومراجعة مصدرها", exact: true }).click();
      await expect.poll(async () => (await read()).reviews.length).toBe(3); await page.reload(); await panel.getByText("المصدر يطابق النسخة المراجعة", { exact: true }).waitFor();
      const final = await read(); expect(await panel.getByRole("article").count()).toBe(1); expect(final.problems).toEqual(saved.problems); expect(final.reviews.every(r => r.problemId === problemId)).toBe(true);
      expect((await authedGet(`${endpoint}?patientId=${x.patientId}`, h.sessions.doctorB)).status).toBe(403);
      expect((await db.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits", [x.patientId])).rows[0]).toEqual({ invoices: 0, payments: 0, visits: 0 });
      expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await panel.evaluate(el => el.scrollIntoView({ block: "start", behavior: "instant" })); await page.screenshot({ path: `.settings-ui-artifacts/ortho-problem-sources-${width}.png` });
      await page.route(`**${endpoint}?*`, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic source outage" }) })); await page.reload(); await panel.getByText("تعذّرت قراءة مصادر قائمة المشاكل؛ لم يُعتبر السجل فارغاً. أعد القراءة.", { exact: true }).waitFor(); expect(await panel.getByRole("combobox", { name: "مصدر المشكلة", exact: true }).isDisabled()).toBe(true);
    } catch (error) { await writeFile(`.settings-ui-artifacts/ortho-problem-sources-failure-${width}.txt`, await page.locator("body").ariaSnapshot()); throw error; } finally { await context.close(); }
  });
});
