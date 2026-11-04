import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import JSZip from "jszip";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { tanakaCommandV2 } from "../fixtures/ortho-assessment-tanaka";
import type { ProblemSourceRead } from "../../lib/ortho-problem-sources";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });

it("carries one saved mixed analysis through clinician-authored problem, goal, study and exports, then preserves the old study after correction", async () => {
  const patient = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'رحلة مسافة مختلطة اصطناعية') RETURNING id", [`SYN-TANAKA-STUDY-${randomUUID()}`])).rows[0].id;
  const intake = await authedMutation("/api/ortho/intake", h.sessions.admin, "POST", JSON.stringify({ patientId: patient, command: { schemaVersion: 1, clientRequestId: randomUUID(), reason: "Synthetic mixed analysis journey" } }));
  expect(intake.status).toBe(201); const { orthoCaseId: ortho } = await intake.json();
  const command = tanakaCommandV2(); command.commandId = randomUUID();
  const assessment = await authedMutation(`/api/ortho/${ortho}/assessment`, h.sessions.admin, "POST", JSON.stringify(command));
  expect(assessment.status).toBe(201); const { revision } = await assessment.json();
  const readSources = async () => {
    const response = await authedGet(`/api/ortho/${ortho}/problem-sources?patientId=${patient}`, h.sessions.admin);
    expect(response.status).toBe(200); return await response.json() as ProblemSourceRead;
  };
  const sources = await readSources(), candidate = sources.candidates.find(c => c.ref.kind === "assessment_analysis" && c.ref.member === "mixed_upper")!;
  expect(candidate.proposedLabel).toBeNull(); expect(sources.problems).toEqual([]);
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(), errors: string[] = []; page.setDefaultTimeout(20000); page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto(`${baseUrl}/patients/${patient}?tab=treatment&sub=ortho&orthoCaseId=${ortho}&pillar=diagnostics#ortho-assessment/${patient}/${ortho}/diagnosis`);
    const panel = page.getByRole("region", { name: "مصادر قائمة المشاكل الموحدة", exact: true });
    await panel.getByRole("combobox", { name: "مصدر المشكلة", exact: true }).selectOption(candidate.identity);
    expect(await panel.getByRole("textbox", { name: "المشكلة بعد مراجعة الطبيب", exact: true }).inputValue()).toBe("");
    expect(await panel.innerText()).toContain("المطلوب المقدّر 74 mm");
    await panel.getByRole("textbox", { name: "المشكلة بعد مراجعة الطبيب", exact: true }).fill("مشكلة مسافة اصطناعية فسّرها الطبيب");
    await panel.getByRole("textbox", { name: "سبب مراجعة وربط المصدر", exact: true }).fill("مراجعة تقدير المسافة مع الفحص والسجلات الاصطناعية");
    await panel.getByRole("checkbox", { name: "راجعت المصدر وأقرّ ارتباطه بهذه المشكلة", exact: true }).check();
    await panel.getByRole("button", { name: "حفظ المشكلة ومراجعة مصدرها", exact: true }).click();
    await panel.getByText("المصدر يطابق النسخة المراجعة", { exact: true }).waitFor();
    const reviewed = await readSources(); expect(reviewed.problems).toHaveLength(1); const problem = reviewed.problems[0].id;
    await page.getByRole("button", { name: "الانتقال إلى أهداف وخطة الحالة", exact: true }).click();
    const strategy = page.getByTestId("ortho-strategy-editor");
    await strategy.getByRole("button", { name: "بدء خطة الحالة من نموذج فارغ", exact: true }).click();
    await strategy.getByRole("listbox", { name: "المشكلة", exact: true }).selectOption(String(problem));
    await strategy.getByRole("textbox", { name: "الهدف (نص الطبيب)", exact: true }).fill("هدف اصطناعي يربط قياس المسافة بتقييم الطبيب");
    await strategy.getByRole("textbox", { name: "الاستراتيجية (نص الطبيب)", exact: true }).fill("خيارات يراجعها الطبيب دون قرار آلي");
    await strategy.getByRole("textbox", { name: "سبب توثيق هذه النسخة (مطلوب)", exact: true }).fill("Synthetic linked manual goal");
    await strategy.getByRole("button", { name: "حفظ نسخة خطة الحالة", exact: true }).click();
    await strategy.getByTestId("ortho-strategy-saved").waitFor();
    await page.getByRole("button", { name: /عرض الحالة/ }).click();
    const study = page.getByRole("region", { name: "دراسة حالة التقويم", exact: true });
    const picker = study.getByRole("group", { name: "اختيار مصدر حقيقي", exact: true });
    const choices = picker.getByRole("button", { name: "اختيار", exact: true });
    for (const [section, kind] of [["section_7", "assessment"], ["section_9", "problem_review"], ["section_9", "strategy"]]) {
      await study.getByLabel("إضافة المرجع إلى القسم", { exact: true }).selectOption(section);
      await study.getByLabel("نوع مصدر الدراسة", { exact: true }).selectOption(kind);
      await expect.poll(() => choices.count()).toBe(1); await choices.click();
    }
    await study.getByLabel("سبب حفظ النسخة", { exact: true }).fill("Synthetic mixed estimate with reviewed sources and goal");
    const saved = page.waitForResponse(r => r.url().includes(`/ortho/${ortho}/case-study/editor`) && r.request().method() === "POST");
    await study.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).click(); expect((await saved).status()).toBe(201);
    const review = study.getByRole("region", { name: "مراجعة الدراسة المحفوظة", exact: true });
    await review.getByRole("combobox", { name: "القسم المحفوظ المعروض", exact: true }).selectOption("section_7");
    await expect.poll(() => review.innerText()).toContain("74 mm"); expect(await review.innerText()).toContain("65 mm");
    expect(await review.innerText()).toContain("المساحة المطلوبة المقدّرة");
    await review.evaluate(el => el.scrollIntoView({ block: "start", behavior: "instant" }));
    await page.screenshot({ path: ".settings-ui-artifacts/ortho-tanaka-study-measurements.png" });
    await review.getByRole("combobox", { name: "القسم المحفوظ المعروض", exact: true }).selectOption("section_9");
    await expect.poll(() => review.innerText()).toContain("مشكلة مسافة اصطناعية فسّرها الطبيب");
    expect(await review.innerText()).toContain("هدف اصطناعي يربط قياس المسافة بتقييم الطبيب");
    await study.getByLabel("سبب حفظ النسخة", { exact: true }).fill("Synthetic clinician documentation of the saved study");
    const documented = page.waitForResponse(r => r.url().includes(`/ortho/${ortho}/case-study/editor`) && r.request().method() === "POST");
    await study.getByRole("button", { name: "توثيق النسخة المحفوظة نفسها", exact: true }).click(); expect((await documented).status()).toBe(201);
    const pptxHref = await study.getByRole("link", { name: "PowerPoint نصي قابل للتحرير", exact: true }).getAttribute("href");
    const powerpoint = await context.request.get(new URL(pptxHref!, baseUrl).href); expect(powerpoint.status()).toBe(200);
    const zip = await JSZip.loadAsync(await powerpoint.body());
    const slides = Object.keys(zip.files).filter(key => /^ppt\/slides\/slide\d+\.xml$/.test(key));
    const xml = (await Promise.all(slides.map(key => zip.file(key)!.async("text")))).join("\n");
    expect(xml).toContain("74 mm"); expect(xml).toContain("65 mm"); expect(xml).toContain("هدف اصطناعي يربط قياس المسافة بتقييم الطبيب");
    const printHref = await study.getByRole("link", { name: "طباعة النسخة المحفوظة / PDF نصي", exact: true }).getAttribute("href");
    const printed = await context.newPage();
    try {
      expect((await printed.goto(new URL(printHref!, baseUrl).href))?.status()).toBe(200);
      const before = await printed.locator("main").innerText(); expect(before).toContain("74 mm"); expect(before).toContain("65 mm");
      const correction = structuredClone(command); correction.commandId = randomUUID(); correction.expectedRevisionId = revision.id;
      correction.content.observations.observations.find(r => r.id === "width_11")!.value = { state: "measured", value: 9 };
      expect((await authedMutation(`/api/ortho/${ortho}/assessment`, h.sessions.admin, "POST", JSON.stringify(correction))).status).toBe(201);
      const changed = await readSources(); expect(changed.problems).toEqual(reviewed.problems);
      expect(changed.reviews[0].currentSourceState).not.toBe("current");
      await printed.reload(); expect(await printed.locator("main").innerText()).toBe(before);
      await printed.pdf({ path: ".settings-ui-artifacts/ortho-tanaka-study.pdf", format: "A4", printBackground: true });
    } finally { await printed.close(); }
    expect((await authedGet(pptxHref!, h.sessions.accountant)).status).toBe(403);
    expect((await db.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM visits WHERE patient_id=$1) visits", [patient])).rows).toEqual([{ invoices: 0, payments: 0, visits: 0 }]);
    expect(errors).toEqual([]);
  } catch (error) { await page.screenshot({ path: ".settings-ui-artifacts/ortho-tanaka-study-failure.png", fullPage: true }); throw error; }
  finally { await context.close(); }
});
