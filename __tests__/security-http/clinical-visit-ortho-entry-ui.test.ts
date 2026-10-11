import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { baseUrl, harness } from "./_server";
import { missingBridge } from "../fixtures/ortho-strategy";

// CI-only built-page acceptance. The isolated HTTP harness owns authentication.
// All browser API reads and all writes are intercepted with synthetic fixtures;
// no clinical save, sign, inventory, lab or financial write reaches the server.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });
const visitId = 98312;
const patientId = 98311;
const doctorId = 98313;
const clinicalPath = `/api/visits/${visitId}/clinical`;
const signedDestination = `/patients/${patientId}?tab=account`;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
function clinicalVisit(ortho = true) {
  return {
    id: visitId, patientId, patientName: "مريض تقويم تجريبي", chiefComplaint: "", examination: "", diagnosis: "", treatmentDone: "", nextPlan: "",
    doctorId, status: "open", signedAt: null, signedBy: null, invoiceId: null, addendum: null,
    procedures: [], totalMinor: 0, planItemsMatched: 0, planTitle: null, planWarning: null,
    ortho: ortho ? {
      caseId: 98314, appliance: "fixed_metal", phase: "aligning", slot: "022", upperWire: "014 NiTi", lowerWire: "012 NiTi",
      lastAdjustment: "2026-09-01", daysSinceLast: 28, lastDone: "تبديل سابق تجريبي", elastics: "none", elasticNote: null,
      suggestedUpper: "016 NiTi", suggestedLower: "014 NiTi", visitAdjustmentId: null, legacyBaseline: true, nextWeeks: 4, adjustmentBillingClass: "LEGACY_INCLUDED",
    } : null,
    plannedVisit: { id: 98315, title: "متابعة تقويم مخطّطة", sequence: 3, planTitle: "خطة تقويم تجريبية", doctorId, durationMinutes: 30 },
    previousVisit: { id: 98310, date: "2026-09-01", treatmentDone: "إجراء سابق تجريبي", proceduresSummary: null, nextPlan: "خطة الزيارة السابقة" },
    latestDiagnosis: { text: "تشخيص سابق للمرجع فقط", date: "2026-08-01" },
    activeCases: [{ id: 98316, kind: "specialty", title: "حالة أخرى تجريبية", specialty: "endo", status: "active", responsibleName: "طبيب مسؤول تجريبي", doneSteps: 1, totalSteps: 3, nextStep: "خطوة الحالة التالية" }],
    suggestions: { chiefComplaint: "سبب الموعد المخطّط", nextPlan: null, doctorId },
    outstanding: [], billingCurrency: "YER", sessionPricing: [], labOrders: [],
  };
}
function diagnosisVersions() {
  return [
    { id: 98321, version: 7, orthoCaseId: 98314, content: { note: "تحديث جزئي لتشخيص الحالة التجريبية" },
      label: "مراجعة جزئية", createdBy: "طبيب القيد الأحدث", createdAt: "2026-10-03T09:00:00Z" },
    { id: 98320, version: 3, orthoCaseId: 98314, content: { skeletal: "صنف هيكلي قديم للمرجع" },
      label: null, createdBy: "طبيب القيد السابق", createdAt: "2026-09-01T09:00:00Z" },
  ];
}
function note(page: Page, label: string) {
  return page.locator(`#visit-notes label:has(> span:has-text("${label}")) > textarea`);
}
async function fixture(width: number, ortho = true, regimen: "ordinary" | "baseline" | "ongoing" | "recorded-none" = "ordinary") {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const writes: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const diagnosisReads: string[] = [];
  const strategyReads: string[] = [];
  let diagnosisResponse: { body: unknown; status: number } = { body: { diagnoses: diagnosisVersions() }, status: 200 };
  let stored: Record<string, unknown> = clinicalVisit(ortho);
  if (regimen === "baseline") stored.ortho = { ...(stored.ortho as object), lastAdjustment: null,
    daysSinceLast: null, lastDone: null, elastics: null, elasticNote: "صنف ثانٍ 3/16 — ليلًا" };
  if (regimen === "ongoing") stored.ortho = { ...(stored.ortho as object), elastics: "class_ii",
    elasticNote: "3/16 خفيفة — ليلًا", nextWeeks: 6 };
  if (regimen === "recorded-none") stored.ortho = { ...(stored.ortho as object), elastics: "none",
    elasticNote: null, nextWeeks: 8 };
  let pendingSave: Route | null = null;
  let holdSave = false;
  let rejectSign = false;
  await context.route("**/*", async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname; const method = request.method();
    if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${path}`); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (path === clinicalPath && method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>; writes.push(body);
        if (!("action" in body)) {
          stored = { ...stored, ...body };
          if (holdSave) { pendingSave = route; return; }
          await json(route, { ok: true }); return;
        }
        if (body.action === "sign") {
          if (rejectSign) { await json(route, { message: "منع تجريبي من قواعد التوقيع" }, 409); return; }
          stored = { ...stored, status: "signed", signedAt: "2026-10-04T10:00:00Z", signedBy: "طبيب تجريبي",
            ortho: stored.ortho ? { ...(stored.ortho as object), visitAdjustmentId: 98317 } : null };
          await json(route, { patientId, invoiceId: null, invoiceCurrency: "YER", duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null }); return;
        }
      }
      unexpected.push(`${method} ${path}`); await json(route, { message: "Unexpected synthetic write blocked" }, 409); return;
    }
    if (path === `/api/patients/${patientId}/diagnoses` && url.search === "?orthoCaseId=98314") {
      diagnosisReads.push(url.pathname + url.search);
      await json(route, diagnosisResponse.body, diagnosisResponse.status);
    }
    else if (method === "GET" && path === "/api/ortho/98314/strategy" && url.search === "" && ortho) {
      strategyReads.push(path);
      await json(route, { ...missingBridge(patientId), orthoCaseId: 98314 });
    }
    else if (path === clinicalPath) await json(route, stored);
    else if (path === `/api/visits/${visitId}/billing-preview`) await json(route, { duesByCurrency: {}, mixedCurrencies: false, zeroReason: "شدّة مشمولة" });
    else if (path === `/api/visits/${visitId}/materials`) await json(route, { lines: [], patientId });
    else if (path === `/api/patients/${patientId}`) await json(route, { id: patientId, medicalAlert: null, phone: null });
    else if (path === `/api/patients/${patientId}/prescriptions`) await json(route, { prescriptions: [], suggestions: [] });
    else if (path === "/api/services") await json(route, []);
    else if (path === "/api/parties") await json(route, [{ id: doctorId, name: "طبيب تجريبي" }]);
    else if (path === "/api/booking-requests") await json(route, []);
    else if (path === "/api/lab") await json(route, { late: 0 });
    else if (path === "/api/messages") await json(route, { unread: 0, urgent: 0 });
    else if (path === "/api/auth/me") await json(route, { username: "secadmin", role: "admin" });
    else if (path.startsWith("/api/") || path.startsWith("/print/")) { unexpected.push(`${method} ${path}`); await json(route, { message: "Unexpected synthetic read blocked" }, 404); }
    else if (request.isNavigationRequest() && `${path}${url.search}` === signedDestination) {
      // A canonical sign result carries this patient ID into account checkout.
      // Keep that exact destination inert, then reopen the real visit to verify
      // its signed freeze without reading an unrelated synthetic patient page.
      await route.fulfill({ contentType: "text/html", body: "<html dir=rtl><body>وجهة تجريبية بعد التوقيع</body></html>" });
    } else await route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/visits/${visitId}`);
    await page.locator("#visit-notes").waitFor();
    await page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }).waitFor();
    return { context, page, writes, unexpected, errors, diagnosisReads, strategyReads,
      setDiagnosisResponse: (body: unknown, status = 200) => { diagnosisResponse = { body, status }; },
      holdSave: () => { holdSave = true; },
      finishSave: async () => { if (!pendingSave) throw new Error("No synthetic save pending"); holdSave = false; await json(pendingSave, { ok: true }); pendingSave = null; },
      rejectSign: (value: boolean) => { rejectSign = value; },
    };
  } catch (error) { await context.close(); throw error; }
}
const start = (page: Page) => page.getByRole("button", { name: "+ شدّة هذه الزيارة (تُحفظ مع التوقيع)", exact: true });
const review = (page: Page) => page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true });
const done = (page: Page) => page.getByRole("textbox", { name: "ما نُفّذ في الشدّة", exact: true });
const assertSafe = (f: Awaited<ReturnType<typeof fixture>>) => { expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]); };

/** Real browser geometry, using the visible title and unchanged header controls. */
async function assertVisitHeaderLayout(page: Page, width: number) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const title = page.getByText("زيارة مفتوحة — مريض تقويم تجريبي", { exact: true });
  await expect.poll(() => title.count()).toBe(1);
  const header = title.locator("../..");
  const rx = header.getByRole("button", { name: "💊 روشتة طبية (℞)", exact: true });
  const instructions = header.getByRole("button", { name: "📋 إرشادات المريض", exact: true });
  expect(await rx.count()).toBe(1);
  expect(await instructions.count()).toBe(1);
  const geometry = await title.evaluate((element) => {
    const title = element as HTMLElement;
    const titleBlock = title.parentElement!;
    const header = titleBlock.parentElement!;
    const actions = header.querySelector("button")!.parentElement!;
    const rect = (node: Element) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const headerBox = rect(header);
    const style = getComputedStyle(header);
    const left = headerBox.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const right = headerBox.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const buttons = Array.from(actions.querySelectorAll("button"));
    return {
      title: rect(titleBlock), paragraph: rect(title), actions: rect(actions),
      buttons: buttons.map(rect), left, right, gap: parseFloat(style.rowGap),
      titleLineHeight: parseFloat(getComputedStyle(title).lineHeight),
      fits: [title, titleBlock, actions, ...buttons].every((node) => node.scrollWidth <= node.clientWidth + 1),
      pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    };
  });
  const contentWidth = geometry.right - geometry.left;
  expect(geometry.buttons).toHaveLength(2);
  expect(geometry.fits).toBe(true);
  expect(geometry.pageFits).toBe(true);
  for (const button of geometry.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(geometry.left - 1);
    expect(button.right).toBeLessThanOrEqual(geometry.right + 1);
  }
  if (width === 390) {
    // The former single flex row left about 40px for this title. It must now
    // occupy a readable first row, with the actions on their own full-width row.
    expect(geometry.title.width).toBeGreaterThanOrEqual(200);
    expect(geometry.title.width).toBeGreaterThanOrEqual(contentWidth * 0.7);
    expect(geometry.paragraph.height / geometry.titleLineHeight).toBeLessThanOrEqual(3);
    expect(geometry.actions.top).toBeGreaterThanOrEqual(geometry.title.bottom + geometry.gap - 1);
    expect(Math.abs(geometry.actions.left - geometry.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.actions.right - geometry.right)).toBeLessThanOrEqual(1);
  } else {
    // Desktop keeps the existing compact inline row and intrinsic action width.
    expect(Math.abs((geometry.actions.top + geometry.actions.bottom) / 2
      - (geometry.title.top + geometry.title.bottom) / 2)).toBeLessThanOrEqual(1);
    expect(geometry.actions.width).toBeLessThan(contentWidth * 0.6);
  }
}

describe("orthodontic session-first chairside entry in the built page", () => {
  it.each([1280, 390])("keeps today's documentation first and baseline reference separate at RTL width %i", async (width) => {
    const f = await fixture(width);
    try {
      expect(await f.page.locator("html").getAttribute("dir")).toBe("rtl");
      await assertVisitHeaderLayout(f.page, width);
      const session = f.page.locator("#visit-ortho-session");
      const position = await f.page.locator("#visit-ortho-session, #visit-notes, #visit-procedures").evaluateAll((nodes) => nodes.map((node) => node.id));
      expect(position).toEqual(["visit-ortho-session", "visit-notes", "visit-procedures"]);
      expect(await note(f.page, "① الشكوى الرئيسية").inputValue()).toBe("سبب الموعد المخطّط");
      await start(f.page).click();
      expect(await note(f.page, "شكوى جديدة أو تغيّر اليوم (إن وجد)").inputValue()).toBe("");
      expect(await note(f.page, "فحص اليوم (إن أُجري)").inputValue()).toBe("");
      expect(await note(f.page, "تشخيص جديد أو محدّث (إن وجد)").inputValue()).toBe("");
      expect(await f.page.locator("#visit-notes details").getAttribute("open")).toBe(null);
      expect(await done(f.page).inputValue()).toBe("");
      expect(await f.page.getByRole("textbox", { name: "السلك العلوي لهذه الشدّة", exact: true }).inputValue()).toBe("014 NiTi");
      expect(await f.page.getByRole("textbox", { name: "السلك السفلي لهذه الشدّة", exact: true }).inputValue()).toBe("012 NiTi");
      // Desktop retains current wires; mobile makes an explicit upper-arch choice.
      if (width === 390) await f.page.getByRole("button", { name: "استخدام السلك العلوي المقترح", exact: true }).click();
      await done(f.page).fill("توثيق جلسة اليوم التجريبية");
      await note(f.page, "شكوى جديدة أو تغيّر اليوم (إن وجد)").fill("شكوى جديدة تجريبية");
      await note(f.page, "الخطوة القادمة").fill("مراجعة بعد أربعة أسابيع");
      const reference = f.page.getByTestId("ortho-visit-reference");
      await reference.locator(":scope > summary").click();
      expect(await reference.textContent()).toContain("تشخيص سابق للمرجع فقط");
      expect(await reference.textContent()).toContain("طبيب مسؤول تجريبي");
      expect(await reference.locator("input, textarea, select").count()).toBe(0);
      await reference.getByTestId("ortho-strategy-reference").getByText("هذه الحالة غير مرتبطة بعد بقائمة المشاكل السريرية. لم يُنشأ رابط تلقائي.", { exact: true }).waitFor();
      expect(f.strategyReads).toEqual(["/api/ortho/98314/strategy"]);
      expect(await reference.getByRole("button").allTextContents()).toEqual(["تحديث سجل الخطة"]);
      expect(await reference.getByTestId("ortho-strategy-reference").getByRole("alert").count()).toBe(0);
      const referenceUrl = new URL((await reference.getByRole("link").getAttribute("href"))!, baseUrl);
      expect(referenceUrl.pathname).toBe(`/patients/${patientId}`);
      expect(Object.fromEntries(referenceUrl.searchParams)).toEqual({ patientId: String(patientId), orthoCaseId: "98314",
        pillar: "wires", tab: "treatment", sub: "ortho" });
      expect(await note(f.page, "فحص اليوم (إن أُجري)").inputValue()).toBe("");
      await reference.locator(":scope > summary").click();
      expect(await done(f.page).inputValue()).toBe("توثيق جلسة اليوم التجريبية");
      expect(await note(f.page, "شكوى جديدة أو تغيّر اليوم (إن وجد)").inputValue()).toBe("شكوى جديدة تجريبية");
      expect(await note(f.page, "الخطوة القادمة").inputValue()).toBe("مراجعة بعد أربعة أسابيع");
      await reference.locator(":scope > summary").click();
      expect(f.writes).toEqual([]);
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(await session.isVisible()).toBe(true);
      await mkdir(".settings-ui-artifacts", { recursive: true });
      await f.page.evaluate(() => window.scrollTo(0, 0));
      await assertVisitHeaderLayout(f.page, width);
      await f.page.screenshot({ path: `.settings-ui-artifacts/clinical-visit-ortho-entry-${width}.png`, fullPage: true });
      await review(f.page).click(); await dialog(f.page).waitFor();
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]).toMatchObject({ chiefComplaint: "شكوى جديدة تجريبية", examination: "", diagnosis: "", treatmentDone: "", procedures: [] });
      expect(f.writes[0]).not.toHaveProperty("orthoSession");
      expect(await dialog(f.page).getByTestId("ortho-session-review").textContent()).toContain("توثيق جلسة اليوم التجريبية");
      await dialog(f.page).getByRole("button", { name: "رجوع — أكمل العمل", exact: true }).click();
      expect(await done(f.page).inputValue()).toBe("توثيق جلسة اليوم التجريبية");
      await review(f.page).click(); await dialog(f.page).waitFor();
      await expect.poll(() => dialog(f.page).getByRole("button", { name: /وقّع الزيارة/ }).count()).toBe(1);
      await dialog(f.page).getByRole("button", { name: /وقّع الزيارة/ }).click();
      await f.page.waitForURL(`${baseUrl}${signedDestination}`);
      await f.page.goto(`${baseUrl}/visits/${visitId}`);
      await f.page.getByRole("textbox", { name: "ملحق", exact: true }).waitFor();
      const signs = f.writes.filter((body) => body.action === "sign");
      expect(signs).toHaveLength(1);
      expect(signs[0].orthoSession).toMatchObject({ caseId: 98314, done: "توثيق جلسة اليوم التجريبية", upperWire: width === 390 ? "016 NiTi" : "014 NiTi", lowerWire: "012 NiTi", nextWeeks: 4 });
      expect(await f.page.locator("#visit-notes textarea").evaluateAll((nodes) => nodes.every((node) => (node as HTMLTextAreaElement).disabled))).toBe(true);
      expect(await start(f.page).count()).toBe(0);
      assertSafe(f);
    } finally { await f.context.close(); }
  });

  it("locks current session edits during save, preserves the draft and keeps sign rejection visible", async () => {
    const f = await fixture(390);
    try {
      await start(f.page).click(); await done(f.page).fill("جلسة قيد الحفظ");
      f.holdSave();
      await f.page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }).click();
      await expect.poll(() => f.writes.length).toBe(1);
      expect(await done(f.page).isDisabled()).toBe(true);
      expect(await f.page.getByRole("combobox", { name: "الطبيب المعالج", exact: true }).isDisabled()).toBe(true);
      await expect(done(f.page).fill("يجب ألا يستبدل النص", { timeout: 150 })).rejects.toThrow();
      await f.page.locator("#visit-ortho-session button").evaluateAll((nodes) => nodes.forEach((node) => (node as HTMLButtonElement).click()));
      expect(await done(f.page).inputValue()).toBe("جلسة قيد الحفظ");
      await f.finishSave(); await expect.poll(() => done(f.page).isEditable()).toBe(true);
      f.rejectSign(true); await review(f.page).click(); await dialog(f.page).waitFor();
      await expect.poll(() => dialog(f.page).getByRole("button", { name: /وقّع الزيارة/ }).count()).toBe(1);
      await dialog(f.page).getByRole("button", { name: /وقّع الزيارة/ }).click();
      await expect.poll(() => f.page.getByText("منع تجريبي من قواعد التوقيع", { exact: true }).count()).toBeGreaterThan(0);
      await dialog(f.page).getByRole("button", { name: "رجوع — أكمل العمل", exact: true }).click();
      expect(await done(f.page).inputValue()).toBe("جلسة قيد الحفظ");
      expect(await f.page.getByRole("textbox", { name: "ملحق", exact: true }).count()).toBe(0);
      assertSafe(f);
    } finally { await f.context.close(); }
  });

  it.each([false, true])("leaves ordinary entry unchanged even with an active orthodontic case=%s", async (activeOrthoCase) => {
    const f = await fixture(1280, activeOrthoCase);
    try {
      expect(await f.page.locator("#visit-notes textarea").count()).toBe(5);
      expect(await note(f.page, "① الشكوى الرئيسية").inputValue()).toBe("سبب الموعد المخطّط");
      expect(await note(f.page, "② الفحص").inputValue()).toBe("");
      expect(await note(f.page, "② التشخيص").inputValue()).toBe("");
      expect(await f.page.getByRole("region", { name: "جلسة التقويم اليوم", exact: true }).count()).toBe(0);
      expect(await f.page.getByTestId("ortho-visit-reference").count()).toBe(0);
      expect(await done(f.page).count()).toBe(0);
      if (activeOrthoCase) {
        await note(f.page, "① الشكوى الرئيسية").fill("شكوى علاج آخر اليوم");
        await note(f.page, "② الفحص").fill("فحص جديد محفوظ في المسودة");
        await start(f.page).click();
        expect(await note(f.page, "شكوى جديدة أو تغيّر اليوم (إن وجد)").inputValue()).toBe("شكوى علاج آخر اليوم");
        expect(await note(f.page, "فحص اليوم (إن أُجري)").inputValue()).toBe("فحص جديد محفوظ في المسودة");
        await f.page.locator("#visit-ortho-session").getByRole("button", { name: "إلغاء", exact: true }).click();
        expect(await note(f.page, "① الشكوى الرئيسية").inputValue()).toBe("شكوى علاج آخر اليوم");
        expect(await note(f.page, "② الفحص").inputValue()).toBe("فحص جديد محفوظ في المسودة");
      }
      expect(f.writes).toEqual([]); assertSafe(f);
    } finally { await f.context.close(); }
  });
});


async function captureVisitRegimen(page: Page, width: number, kind: "ongoing" | "baseline") {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.locator("#visit-ortho-session").evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const bounds = [];
  for (const label of ["مطاطات هذه الشدّة", "وصف مطاطات هذه الشدّة", "أسابيع حتى الشدّة القادمة"]) {
    const control = page.getByLabel(label, { exact: true });
    const geometry = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const points = [[rect.left + 3, rect.top + 3], [rect.right - 3, rect.top + 3],
        [rect.left + 3, rect.bottom - 3], [rect.right - 3, rect.bottom - 3],
        [rect.left + rect.width / 2, rect.top + rect.height / 2]];
      return { label: element.getAttribute("aria-label"), left: rect.left, right: rect.right,
        top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
        viewport: { width: innerWidth, height: innerHeight },
        hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); }) };
    });
    expect(geometry.width).toBeGreaterThan(70); expect(geometry.height).toBeGreaterThan(20);
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.hits).toEqual([true, true, true, true, true]);
    bounds.push(geometry);
  }
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await mkdir(".settings-ui-artifacts", { recursive: true });
  const name = `clinical-visit-regimen-${kind}-${width}`;
  await writeFile(`.settings-ui-artifacts/${name}-bounds.json`, JSON.stringify(bounds, null, 2));
  await page.screenshot({ path: `.settings-ui-artifacts/${name}.png` });
}

describe("Today baseline elastic confirmation in the built RTL page", () => {
  it.each([1280, 390])("preserves the known regimen and interval without repeating prior work at %ipx", async (width) => {
    const f = await fixture(width, true, "ongoing");
    try {
      f.rejectSign(true); await start(f.page).click();
      const elasticClass = f.page.getByLabel("مطاطات هذه الشدّة", { exact: true });
      expect(await elasticClass.inputValue()).toBe("class_ii");
      expect(await elasticClass.locator("option:checked").textContent()).toBe("صنف ثانٍ");
      expect(await f.page.getByLabel("وصف مطاطات هذه الشدّة", { exact: true }).inputValue()).toBe("3/16 خفيفة — ليلًا");
      expect(await f.page.getByLabel("أسابيع حتى الشدّة القادمة", { exact: true }).inputValue()).toBe("6");
      expect(await done(f.page).inputValue()).toBe(""); expect(f.writes).toEqual([]);
      await captureVisitRegimen(f.page, width, "ongoing");
      await done(f.page).fill("مراجعة اليوم دون تغيير المطاطات");
      await review(f.page).click(); await dialog(f.page).waitFor();
      await dialog(f.page).getByRole("button", { name: /وقّع الزيارة/ }).click();
      await expect.poll(() => f.writes.filter((body) => body.action === "sign").length).toBe(1);
      expect(f.writes.find((body) => body.action === "sign")?.orthoSession).toMatchObject({
        elastics: "class_ii", elasticNote: "3/16 خفيفة — ليلًا", nextWeeks: 6,
        upperWire: "014 NiTi", lowerWire: "012 NiTi", done: "مراجعة اليوم دون تغيير المطاطات",
      });
      assertSafe(f);
    } finally { await f.context.close(); }
  });

  it.each([1280, 390])("requires an explicit baseline class before review or sign at %ipx", async (width) => {
    const f = await fixture(width, true, "baseline");
    try {
      f.rejectSign(true); await start(f.page).click();
      const elasticClass = f.page.getByLabel("مطاطات هذه الشدّة", { exact: true });
      expect(await elasticClass.inputValue()).toBe("");
      expect(await elasticClass.locator("option:checked").textContent()).toContain("اختر الصنف");
      expect(await f.page.getByLabel("وصف مطاطات هذه الشدّة", { exact: true }).inputValue()).toBe("صنف ثانٍ 3/16 — ليلًا");
      expect(await f.page.getByTestId("visit-baseline-elastics").textContent()).toContain("لا يُستنتج الصنف");
      expect(await done(f.page).inputValue()).toBe(""); await captureVisitRegimen(f.page, width, "baseline");
      await review(f.page).click();
      await f.page.getByRole("alert").filter({ hasText: "اختر صنف المطاطات لهذه الجلسة" }).waitFor();
      expect(await dialog(f.page).count()).toBe(0); expect(f.writes).toEqual([]);
      // Ordinary notes may still be saved: the pending adjustment never travels in this payload.
      await f.page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }).click();
      await expect.poll(() => f.writes.length).toBe(1);
      await expect.poll(() => elasticClass.isEnabled()).toBe(true);
      expect(f.writes[0]).not.toHaveProperty("orthoSession"); expect(await elasticClass.inputValue()).toBe("");
      await elasticClass.selectOption(width === 1280 ? "class_ii" : "none");
      await review(f.page).click(); await dialog(f.page).waitFor();
      expect(await dialog(f.page).getByTestId("ortho-session-review").textContent()).toContain(width === 1280 ? "صنف ثانٍ" : "بلا مطاطات");
      await dialog(f.page).getByRole("button", { name: /وقّع الزيارة/ }).click();
      await expect.poll(() => f.writes.filter((body) => body.action === "sign").length).toBe(1);
      expect(f.writes.find((body) => body.action === "sign")?.orthoSession).toMatchObject(width === 1280
        ? { elastics: "class_ii", elasticNote: "صنف ثانٍ 3/16 — ليلًا", done: "" }
        : { elastics: "none", elasticNote: "", done: "" });
      assertSafe(f);
    } finally { await f.context.close(); }
  });

  it("retains a recorded no-elastics state without demanding baseline re-entry", async () => {
    const f = await fixture(390, true, "recorded-none");
    try {
      await start(f.page).click();
      expect(await f.page.getByLabel("مطاطات هذه الشدّة", { exact: true }).inputValue()).toBe("none");
      expect(await f.page.getByLabel("أسابيع حتى الشدّة القادمة", { exact: true }).inputValue()).toBe("8");
      expect(await f.page.getByTestId("visit-baseline-elastics").count()).toBe(0);
      await review(f.page).click(); await dialog(f.page).waitFor(); assertSafe(f);
    } finally { await f.context.close(); }
  });

  it("removes the baseline class block when the staged adjustment is cancelled", async () => {
    const f = await fixture(390, true, "baseline");
    try {
      await start(f.page).click();
      await f.page.getByRole("button", { name: "إلغاء", exact: true }).click();
      await review(f.page).click(); await dialog(f.page).waitFor();
      expect(await dialog(f.page).getByTestId("ortho-session-review").count()).toBe(0);
      expect(f.writes).toHaveLength(1); expect(f.writes[0]).not.toHaveProperty("orthoSession"); assertSafe(f);
    } finally { await f.context.close(); }
  });
});

async function captureDiagnosisReference(page: Page, width: number, state: "latest" | "history" | "unavailable") {
  await page.evaluate(async () => { await document.fonts.ready; });
  const reference = page.getByTestId("ortho-visit-reference");
  const controls = state === "unavailable"
    ? [reference.locator(":scope > summary"), reference.getByRole("button", { name: "إعادة تحميل التشخيص", exact: true })]
    : [reference.locator(":scope > summary"), reference.getByTestId("ortho-diagnosis-history").locator(":scope > summary")];
  const bounds = [];
  for (const control of controls) {
    await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const geometry = await control.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const points = [[rect.left + 3, rect.top + 3], [rect.right - 3, rect.top + 3],
        [rect.left + 3, rect.bottom - 3], [rect.right - 3, rect.bottom - 3],
        [rect.left + rect.width / 2, rect.top + rect.height / 2]];
      return { label: element.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: rect.width, height: rect.height, viewport: { width: innerWidth, height: innerHeight },
        hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); }) };
    });
    expect(geometry.width).toBeGreaterThan(70); expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.hits).toEqual([true, true, true, true, true]); bounds.push(geometry);
  }
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await mkdir(".settings-ui-artifacts", { recursive: true });
  const name = `clinical-visit-diagnosis-reference-${state}-${width}`;
  await writeFile(`.settings-ui-artifacts/${name}-bounds.json`, JSON.stringify(bounds, null, 2));
  await page.screenshot({ path: `.settings-ui-artifacts/${name}.png`, fullPage: true });
}

describe("read-only case diagnosis continuity in the built RTL page", () => {
  it.each([1280, 390])("separates partial entries and preserves today's drafts through reference history, retry and signing at %ipx", async width => {
    const f = await fixture(width);
    try {
      expect(f.diagnosisReads).toEqual([]); expect(f.strategyReads).toEqual([]);
      await start(f.page).click(); expect(f.diagnosisReads).toEqual([]);
      await note(f.page, "شكوى جديدة أو تغيّر اليوم (إن وجد)").fill("شكوى اليوم فقط");
      await f.page.locator("#visit-notes details > summary").click();
      await note(f.page, "فحص اليوم (إن أُجري)").fill("فحص اليوم فقط");
      await note(f.page, "تشخيص جديد أو محدّث (إن وجد)").fill("تشخيص اليوم فقط");
      await done(f.page).fill("شدّة اليوم فقط");
      const reference = f.page.getByTestId("ortho-visit-reference");
      const toggle = reference.locator(":scope > summary");
      await toggle.click();
      const latest = reference.getByTestId("ortho-diagnosis-latest-entry");
      await latest.waitFor();
      expect(f.diagnosisReads).toEqual([`/api/patients/${patientId}/diagnoses?orthoCaseId=98314`]);
      await expect.poll(() => f.strategyReads).toEqual(["/api/ortho/98314/strategy"]);
      expect(await latest.textContent()).toContain("تحديث جزئي لتشخيص الحالة التجريبية");
      expect(await latest.textContent()).toContain("نسخة 7");
      expect(await latest.textContent()).toContain("طبيب القيد الأحدث");
      expect(await latest.textContent()).not.toContain("صنف هيكلي قديم للمرجع");
      expect(await reference.textContent()).toContain("قد يتضمن القيد حقولًا محدّثة فقط");
      expect(await reference.textContent()).toContain("آخر تشخيص من زيارة موقّعة للمريض");
      expect(await reference.locator("input, textarea, select").count()).toBe(0);
      expect(await reference.getByRole("button", { name: /سجّل تشخيص|تحديث التشخيص|احفظ النسخة/ }).count()).toBe(0);
      const history = reference.getByTestId("ortho-diagnosis-history");
      expect(await history.getAttribute("open")).toBe(null);
      expect(await history.getByText("الصنف الهيكلي: صنف هيكلي قديم للمرجع", { exact: true }).isVisible()).toBe(false);
      await captureDiagnosisReference(f.page, width, "latest");
      await history.locator(":scope > summary").click();
      await expect.poll(() => history.getAttribute("open")).toBe("");
      expect(await history.getByText("الصنف الهيكلي: صنف هيكلي قديم للمرجع", { exact: true }).isVisible()).toBe(true);
      expect(await reference.getAttribute("open")).toBe("");
      expect(f.diagnosisReads).toHaveLength(1); await captureDiagnosisReference(f.page, width, "history");
      await toggle.click(); await expect.poll(() => f.page.getByTestId("ortho-diagnosis-reference").count()).toBe(0);
      f.setDiagnosisResponse({}, 403); await toggle.click();
      const diagnosisReference = reference.getByTestId("ortho-diagnosis-reference");
      await diagnosisReference.getByRole("alert").waitFor();
      expect(await diagnosisReference.getByRole("alert").count()).toBe(1);
      await reference.getByTestId("ortho-strategy-reference").getByText("هذه الحالة غير مرتبطة بعد بقائمة المشاكل السريرية. لم يُنشأ رابط تلقائي.", { exact: true }).waitFor();
      expect(await reference.getByTestId("ortho-strategy-reference").getByRole("alert").count()).toBe(0);
      expect(await reference.textContent()).toContain("هذا لا يعني عدم وجود تشخيص");
      expect(await reference.textContent()).not.toContain("لا تشخيص سريري مسجل لهذه الحالة بعد");
      await captureDiagnosisReference(f.page, width, "unavailable");
      f.setDiagnosisResponse({ diagnoses: [] });
      await reference.getByRole("button", { name: "إعادة تحميل التشخيص", exact: true }).click();
      await reference.getByText("لا تشخيص سريري مسجل لهذه الحالة بعد.", { exact: true }).waitFor();
      await toggle.click(); await expect.poll(() => f.page.getByTestId("ortho-diagnosis-reference").count()).toBe(0);
      f.setDiagnosisResponse({ diagnoses: diagnosisVersions() }); await toggle.click(); await latest.waitFor();
      expect(await reference.getByTestId("ortho-diagnosis-history").getAttribute("open")).toBe(null);
      expect(await note(f.page, "شكوى جديدة أو تغيّر اليوم (إن وجد)").inputValue()).toBe("شكوى اليوم فقط");
      expect(await note(f.page, "فحص اليوم (إن أُجري)").inputValue()).toBe("فحص اليوم فقط");
      expect(await note(f.page, "تشخيص جديد أو محدّث (إن وجد)").inputValue()).toBe("تشخيص اليوم فقط");
      expect(await done(f.page).inputValue()).toBe("شدّة اليوم فقط"); expect(f.writes).toEqual([]);
      await review(f.page).click(); await dialog(f.page).waitFor();
      expect(f.writes[0]).toMatchObject({ chiefComplaint: "شكوى اليوم فقط", examination: "فحص اليوم فقط", diagnosis: "تشخيص اليوم فقط", procedures: [] });
      expect(f.writes[0]).not.toHaveProperty("orthoSession");
      await dialog(f.page).getByRole("button", { name: /وقّع الزيارة/ }).click();
      await f.page.waitForURL(`${baseUrl}${signedDestination}`);
      const readsBeforeSigned = f.diagnosisReads.length;
      await f.page.goto(`${baseUrl}/visits/${visitId}`);
      await f.page.getByRole("textbox", { name: "ملحق", exact: true }).waitFor();
      expect(f.diagnosisReads).toHaveLength(readsBeforeSigned);
      expect(await f.page.getByTestId("ortho-diagnosis-reference").count()).toBe(0);
      expect(f.writes.filter(body => body.action === "sign")).toHaveLength(1);
      expect(f.writes.find(body => body.action === "sign")?.orthoSession).toMatchObject({ caseId: 98314, done: "شدّة اليوم فقط" });
      assertSafe(f);
    } finally { await f.context.close(); }
  });
});

