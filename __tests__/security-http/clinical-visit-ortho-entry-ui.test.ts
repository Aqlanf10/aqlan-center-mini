import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";

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
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
function clinicalVisit(ortho = true) {
  return {
    id: visitId, patientId, patientName: "مريض تقويم تجريبي", chiefComplaint: "", examination: "", diagnosis: "", treatmentDone: "", nextPlan: "",
    doctorId, status: "open", signedAt: null, signedBy: null, invoiceId: null, addendum: null,
    procedures: [], totalMinor: 0, planItemsMatched: 0, planTitle: null, planWarning: null,
    ortho: ortho ? {
      caseId: 98314, appliance: "fixed", phase: "alignment", slot: "022", upperWire: "014 NiTi", lowerWire: "012 NiTi",
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
function note(page: Page, label: string) {
  return page.locator(`#visit-notes label:has(> span:has-text("${label}")) > textarea`);
}
async function fixture(width: number, ortho = true) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const writes: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  let stored: Record<string, unknown> = clinicalVisit(ortho);
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
          await json(route, { invoiceId: null, invoiceCurrency: "YER", duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null }); return;
        }
      }
      unexpected.push(`${method} ${path}`); await json(route, { message: "Unexpected synthetic write blocked" }, 409); return;
    }
    if (path === clinicalPath) await json(route, stored);
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
    else if (request.isNavigationRequest() && path === "/") {
      // The visit page redirects here after success. Keep the destination inert;
      // reopen the real built visit route below to verify its signed freeze.
      await route.fulfill({ contentType: "text/html", body: "<html dir=rtl><body>وجهة تجريبية بعد التوقيع</body></html>" });
    } else await route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/visits/${visitId}`);
    await page.locator("#visit-notes").waitFor();
    await page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }).waitFor();
    return { context, page, writes, unexpected, errors,
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

describe("orthodontic session-first chairside entry in the built page", () => {
  it.each([1280, 390])("keeps today's documentation first and baseline reference separate at RTL width %i", async (width) => {
    const f = await fixture(width);
    try {
      expect(await f.page.locator("html").getAttribute("dir")).toBe("rtl");
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
      await reference.locator("summary").click();
      expect(await reference.textContent()).toContain("تشخيص سابق للمرجع فقط");
      expect(await reference.textContent()).toContain("طبيب مسؤول تجريبي");
      expect(await reference.locator("input, textarea, select, button").count()).toBe(0);
      expect(await reference.getByRole("link").getAttribute("href")).toBe(`/patients/${patientId}?tab=ortho`);
      expect(await note(f.page, "فحص اليوم (إن أُجري)").inputValue()).toBe("");
      await reference.locator("summary").click();
      expect(await done(f.page).inputValue()).toBe("توثيق جلسة اليوم التجريبية");
      expect(await note(f.page, "شكوى جديدة أو تغيّر اليوم (إن وجد)").inputValue()).toBe("شكوى جديدة تجريبية");
      expect(await note(f.page, "الخطوة القادمة").inputValue()).toBe("مراجعة بعد أربعة أسابيع");
      await reference.locator("summary").click();
      expect(f.writes).toEqual([]);
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(await session.isVisible()).toBe(true);
      await mkdir(".settings-ui-artifacts", { recursive: true });
      await f.page.evaluate(() => window.scrollTo(0, 0));
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
      await f.page.waitForURL(`${baseUrl}/`);
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
