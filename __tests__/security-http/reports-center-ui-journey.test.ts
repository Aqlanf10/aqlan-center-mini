import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * (P1-2) مركز التقارير في متصفحٍ حقيقي على التطبيق المبني.
 *
 * العيب الذي يحرسه هذا الاختبار: الصفحة كانت تنهار لكل مستخدم («This page couldn't
 * load») لأن المسار أعاد التقرير مسطّحًا بينما الصفحة تقرأ `data.result` — والمسار
 * نفسه كان يعيد 200. اختبار الشاشات بـHTTP لا يرى انهيار العميل؛ هذا يراه: يفتح
 * كل قسم وكل تقرير، ويفشل عند أي خطأ صفحة (pageerror) أو غياب عنوان التقرير.
 */

const SECTIONS: Array<{ label: string; reports: string[] }> = [
  {
    label: "ذكاء العيادة",
    reports: [
      "ملخّص العيادة", "أداء المواعيد", "استغلال الأطباء", "استغلال الكراسي", "ذكاء خطط العلاج",
      "علاج غير مجدول", "ذكاء المختبر", "تحويل المرضى الجدد", "ذكاء المتابعة", "الاتجاهات الشهرية",
    ],
  },
  { label: "تقارير تشغيلية", reports: ["التقرير اليومي", "سجل الزيارات", "تقارير المرضى"] },
  { label: "تقارير مالية", reports: ["التقرير الشهري", "التقرير السنوي", "تقرير التحصيل", "الخدمات والإجراءات"] },
  { label: "المديونية والتحصيل", reports: ["تقارير المديونية", "أعمار الديون"] },
  { label: "سريرية وتخصصية", reports: ["التقرير حسب التخصص"] },
  { label: "تقارير الأطباء", reports: ["الطبيب والإنتاجية"] },
];

let browser: Browser;
let securityHarness: Awaited<ReturnType<typeof harness>>;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

async function openReports(width: number, height: number): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width, height }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(securityHarness.sessions.admin.cookie), url: baseUrl }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/reports`);
  await page.getByRole("heading", { name: "مركز التقارير", exact: true }).waitFor();
  return { context, page, errors };
}

/** ينتظر انتهاء التحميل ثم يثبت أن التقرير رُسم بعنوانه، لا خطأ ولا صفحة انهيار. */
async function expectReportRendered(page: Page, errors: string[], label: string) {
  await page.getByText(/^جارٍ إعداد /).waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
  const title = page.locator("main h2").first();
  try {
    await title.waitFor({ timeout: 30_000 });
  } catch (error) {
    throw new Error(`${label}: لم يُرسم التقرير — أخطاء الصفحة: ${JSON.stringify(errors)} — ${String(error)}`);
  }
  expect(await page.getByText("This page couldn't load").count(), label).toBe(0);
  // تنبيه الخطأ داخل الصفحة (لا مُعلِن المسارات الذي يحقنه Next.js بدور alert).
  const alerts = page.locator("main [role=alert]");
  expect(await alerts.count(), `${label}: ${await alerts.allTextContents()}`).toBe(0);
  expect(errors, label).toEqual([]);
}

beforeAll(async () => {
  securityHarness = await harness();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
}, 240_000);

afterAll(async () => {
  await browser?.close();
});

describe("مركز التقارير — لا انهيار في أي تقرير", () => {
  it("سطح المكتب: كل قسم وكل تقرير يُرسم بلا خطأ صفحة", async () => {
    const { context, page, errors } = await openReports(1440, 1050);
    try {
      await expectReportRendered(page, errors, "التحميل الأول");
      const sections = page.getByRole("navigation", { name: "أقسام التقارير" });
      for (const section of SECTIONS) {
        await sections.getByRole("button", { name: section.label }).click();
        await expectReportRendered(page, errors, section.label);
        for (const report of section.reports) {
          await page.getByRole("button", { name: report, exact: true }).click();
          await expectReportRendered(page, errors, `${section.label} › ${report}`);
        }
      }
    } finally {
      await context.close();
    }
  }, 180_000);

  it("الهاتف (390px): الصفحة تُرسم بلا خطأ صفحة", async () => {
    const { context, page, errors } = await openReports(390, 844);
    try {
      await expectReportRendered(page, errors, "الهاتف");
    } finally {
      await context.close();
    }
  }, 120_000);
});

describe("عقد مسار التقارير", () => {
  it("يعيد التقرير داخل `result` مع وقت الإعداد ومُعدّه — العقد الذي تقرؤه الصفحة", async () => {
    const response = await fetch(`${baseUrl}/api/reports?report=daily`, {
      headers: { cookie: securityHarness.sessions.admin.cookie },
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(typeof payload.result?.title).toBe("string");
    expect(typeof payload.generatedAt).toBe("string");
    expect(payload.generatedBy).toBe("secadmin");
  });

  it("نوع تقرير مجهول ⇒ 400 برسالة عربية، لا تفاصيل استثناء", async () => {
    const response = await fetch(`${baseUrl}/api/reports?report=nope`, {
      headers: { cookie: securityHarness.sessions.admin.cookie },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe("نوع تقرير غير معروف.");
  });
});
