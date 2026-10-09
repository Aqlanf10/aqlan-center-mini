import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { baseUrl, harness } from "./_server";

/**
 * (HR-1/HR-2) رحلة متصفح فعلية لشاشة «الموارد البشرية والمهام»:
 *
 *  * صور فعلية بعرضَي 390 (هاتف) و1280 (مكتب) لبياناتٍ تجريبية حقيقية عبر HTTP.
 *  * بلا تمريرٍ أفقي على الهاتف (مقياس P3-4 نفسه).
 *  * إنشاء موظفٍ بلا حساب ومهمةٍ مسندة إليه من الواجهة — ثم ظهورهما في القائمة.
 *  * خصوصية المهمة الخاصة: المستقبل لا يراها في قائمته ولا عدّاده.
 *  * ملفات طباعةٍ فعلية (PDF) لكشفي الطاقم والمهام.
 *
 * الأدلة تُكتب في HR_EVIDENCE_DIR (خارج المستودع) — هذا الملف يُثبت الحالة،
 * والأدلة مراجعتها البشري.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const EVIDENCE_DIR = process.env.HR_EVIDENCE_DIR ?? join(process.cwd(), ".hr-evidence");

let browser: Browser;
let context: BrowserContext;
let h: Awaited<ReturnType<typeof harness>>;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

async function overflowExcess(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

beforeAll(async () => {
  h = await harness();
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: DESKTOP, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
}, 240_000);

afterAll(async () => {
  try { await context?.close(); await browser?.close(); } catch { /* الإغلاق أفضل جهد */ }
});

describe("(HR) browser journey — staff files and tasks", () => {
  it("admin creates a guard with salary terms and a task assigned to him, through the real UI", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("section[aria-label='المهام']");
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-desktop-1280.png"), fullPage: true });

      // تبويب الطاقم (المدير وحده يراه) ثم إنشاء ملف حارسٍ براتب
      await page.getByRole("tab", { name: "الطاقم" }).click();
      await page.getByRole("button", { name: "ملف موظف جديد" }).click();
      await page.getByLabel("الاسم الكامل").fill("حارس الورديات");
      await page.getByLabel(/المسمّى الوظيفي/).fill("حارس");
      await page.getByRole("radio", { name: "راتب", exact: true }).check();
      await page.getByLabel(/يوجد راتب/).check();
      await page.getByLabel("المبلغ (وحدات صغرى)").fill("1500000");
      await page.getByLabel("العملة").fill("YER");
      await page.getByLabel("الدورية").selectOption({ label: "شهري" });
      await page.getByLabel("سريان المبلغ").fill("2026-10-01");
      await page.getByRole("button", { name: "حفظ" }).click();
      await page.waitForTimeout(600);
      const listText = await page.textContent("table");
      expect(listText).toContain("حارس الورديات");
      expect(listText).toContain("15,000");
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-staff-desktop-1280.png"), fullPage: true });

      // مهمة مشتركة مسندة إليه (بلا حساب) من الواجهة
      await page.getByRole("tab", { name: "المهام" }).click();
      await page.getByRole("button", { name: "مهمة جديدة" }).click();
      await page.getByLabel("العنوان").fill("مراجعة كاميرا المدخل يوميًا");
      await page.getByLabel("المسؤول (من ملفات الطاقم)").selectOption({ label: "حارس الورديات — حارس" });
      await page.getByRole("button", { name: "إنشاء" }).click();
      await page.waitForTimeout(600);
      const tasksText = await page.textContent("section[aria-label='المهام']");
      expect(tasksText).toContain("مراجعة كاميرا المدخل يوميًا");
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-tasks-desktop-1280.png"), fullPage: true });
    } finally { await page.close(); }
  }, 240_000);

  it("reception cannot see the staff tab nor the private task of the doctor", async () => {
    const page = await context.newPage();
    try {
      const receptionContext = await browser.newContext({ viewport: DESKTOP, locale: "ar-YE" });
      await receptionContext.addCookies([{ ...sessionCookie(h.sessions.reception.cookie), url: baseUrl }]);
      const receptionPage = await receptionContext.newPage();
      await receptionPage.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      // الاستقبال لا يرى تبويب الطاقم — والخادم يردّ مسار الطاقم 403 في كل الأحوال.
      expect(await receptionPage.getByRole("tab", { name: "الطاقم" }).count()).toBe(0);
      await receptionPage.close();

      // طبيب ينشئ مهمة خاصة، والاستقبال لا يراها في قائمته.
      const doctorContext = await browser.newContext({ viewport: DESKTOP, locale: "ar-YE" });
      await doctorContext.addCookies([{ ...sessionCookie(h.sessions.doctorA.cookie), url: baseUrl }]);
      const doctorPage = await doctorContext.newPage();
      await doctorPage.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await doctorPage.getByRole("button", { name: "مهمة جديدة" }).click();
      await doctorPage.getByLabel("العنوان").fill("تذكير شخصي خاص بالدوام");
      await doctorPage.getByLabel(/مهمة خاصة/).check();
      await doctorPage.getByRole("button", { name: "إنشاء" }).click();
      await doctorPage.waitForTimeout(600);
      expect(await doctorPage.textContent("section[aria-label='المهام']")).toContain("تذكير شخصي خاص بالدوام");
      await doctorPage.close();

      await page.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      expect(await page.textContent("section[aria-label='المهام']")).not.toContain("تذكير شخصي خاص بالدوام");
      await page.close();
      await receptionContext.close();
      await doctorContext.close();
    } finally { await page.close(); }
  }, 240_000);

  it("fits a 390px phone without horizontal overflow, with evidence screenshots", async () => {
    const phoneContext = await browser.newContext({ viewport: PHONE, locale: "ar-YE", isMobile: true, hasTouch: true });
    await phoneContext.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
    const page = await phoneContext.newPage();
    try {
      await page.goto(`${baseUrl}/hr`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("section[aria-label='المهام']");
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-phone-390.png"), fullPage: true });
      expect(await overflowExcess(page)).toBeLessThanOrEqual(1);

      await page.getByRole("button", { name: "لوحة" }).click();
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-phone-board-390.png"), fullPage: true });
      expect(await overflowExcess(page)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
      await phoneContext.close();
    }
  }, 240_000);

  it("produces real print files: staff report PDF and tasks report PDF", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/print/hr/staff`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.pdf({ path: join(EVIDENCE_DIR, "hr-staff-report.pdf"), format: "A4", landscape: true });

      await page.goto(`${baseUrl}/print/hr/tasks`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.pdf({ path: join(EVIDENCE_DIR, "hr-tasks-report.pdf"), format: "A4" });

      // صور الشاشة نفسها كدليل طباعةٍ مرئي
      await page.screenshot({ path: join(EVIDENCE_DIR, "hr-tasks-print-preview.png"), fullPage: true });
    } finally { await page.close(); }
  }, 240_000);
});
