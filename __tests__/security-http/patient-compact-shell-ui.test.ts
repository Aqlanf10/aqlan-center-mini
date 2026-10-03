import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";
import { formatMoney } from "../../lib/money";

// Presentation proof on the built app's isolated synthetic database only.
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let patientId: number;
let alertPatientId: number;
let arrivalPatientId: number;
const stamp = Date.now();
const alertName = "مريض اختبار سلامة طويل الاسم وتفاصيله ظاهرة كاملة";

beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username = 'secdoctora'")).rows[0].party_id;
  async function seedPatient(number: string, name: string, alert: string | null) {
    const id = (await db.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name, primary_doctor_id, medical_alert) VALUES ($1, $2, $3, $4) RETURNING id",
      [number, name, doctor, alert])).rows[0].id;
    await db.query("INSERT INTO visits (patient_name, patient_id, doctor_id, status, cleared_at, cleared_by) VALUES ($1, $2, $3, 'in_chair', NOW(), 'secdoctora')", [name, id, doctor]);
    const caseId = (await db.query<{ id: number }>(
      "INSERT INTO clinical_cases (patient_id, specialty, title, responsible_party_id, created_by) VALUES ($1, 'endodontics', 'حالة اختبار العرض', $2, 'secdoctora') RETURNING id", [id, doctor])).rows[0].id;
    await db.query("INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 36, 'secdoctora')", [id, caseId]);
    return id;
  }
  patientId = await seedPatient(`SHELL-${stamp}`, "مريض اختبار الواجهة", null);
  arrivalPatientId = (await db.query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض اختبار تأكيد الزيارة', $2) RETURNING id",
    [`SHELL-ARRIVE-${stamp}`, doctor])).rows[0].id;
  alertPatientId = await seedPatient(`SHELL-ALERT-${stamp}`, alertName,
    "حساسية بنسلين · مميعات دم · تنبيه ثالث مهم [VITALS: BP=185/120, DATE=2026-10-03]");
  await db.query("INSERT INTO invoices (invoice_number, patient_id, total_minor, base_currency) VALUES ($1, $3, 12000, 'YER'), ($2, $3, 3400, 'SAR')", [`SHELL-Y-${stamp}`, `SHELL-S-${stamp}`, alertPatientId]);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function open(who: "doctorA" | "admin", id: number, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions[who].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${id}?tab=treatment&sub=endo`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("endo-record").waitFor();
  // Readiness is fetched independently of ENDO. Measure the resolved strip,
  // including its status/actions/financial projection, not its loading fallback.
  await expect.poll(() => page.getByTestId("patient-context-strip").innerText()).toContain("على الكرسي");
  await expect.poll(() => page.getByTestId("patient-context-strip").innerText()).toContain("جاهز ✓");
  return { context, page };
}
async function notCovered(page: Page, testId: string) {
  const target = page.getByTestId(testId); await target.scrollIntoViewIfNeeded();
  const hit = await target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const top = document.elementFromPoint(point.x, point.y);
    const stack = document.elementsFromPoint(point.x, point.y);
    const describe = (element: Element) => ({
      tag: element.tagName, id: element.id, testId: element.getAttribute("data-testid"),
      className: element.getAttribute("class"), label: element.getAttribute("aria-label"),
      text: element.textContent?.trim().slice(0, 160), rect: element.getBoundingClientRect().toJSON(),
      position: getComputedStyle(element).position, zIndex: getComputedStyle(element).zIndex,
    });
    let positionedAncestor = top?.parentElement ?? null;
    while (positionedAncestor && getComputedStyle(positionedAncestor).position === "static") {
      positionedAncestor = positionedAncestor.parentElement;
    }
    return {
      reachable: top === node || node.contains(top), target: describe(node), point,
      top: top ? describe(top) : null,
      closestPositionedAncestor: positionedAncestor ? describe(positionedAncestor) : null,
      stack: stack.slice(0, 5).map(describe), connected: node.isConnected,
      viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY },
      search: location.search, focused: document.activeElement ? describe(document.activeElement) : null,
    };
  });
  if (!hit.reachable) {
    // Synthetic fixture only. Preserve the exact failing viewport, not a reset
    // or full-page frame captured before the navigation that actually failed.
    console.error("PATIENT_SHELL_HIT_FAILURE", JSON.stringify({ testId, ...hit }));
    await mkdir(".settings-ui-artifacts", { recursive: true });
    await page.screenshot({ path: ".settings-ui-artifacts/patient-compact-hit-failure.png" });
  }
  expect(hit.reachable, JSON.stringify({ testId, ...hit })).toBe(true);
}

describe("compact whole-patient clinical workspace", () => {
  it("keeps the existing start-visit confirmation visible outside the closed details panel", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.doctorA.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/patients/${arrivalPatientId}?tab=today`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "🪑 بدء زيارة اليوم", exact: true }).last().click();
      await page.getByTestId("patient-success-notice").waitFor();
      expect(await page.getByTestId("patient-success-notice").innerText()).toContain("بدأت الزيارة");
      expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(false);
      expect((await db.query("SELECT id FROM visits WHERE patient_id = $1", [arrivalPatientId])).rows).toHaveLength(1);
      expect((await db.query("SELECT id FROM invoices WHERE patient_id = $1", [arrivalPatientId])).rows).toHaveLength(0);
    } finally { await context.close(); }
  });

  it("brings current entry into the initial viewport without a second sticky bar and preserves all secondary controls", async () => {
    for (const width of [1280, 390]) {
      const { context, page } = await open("doctorA", patientId, width);
      try {
        const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
        expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(false);
        expect(await page.getByTestId("patient-context-strip").evaluate((node) => getComputedStyle(node).position)).toBe("static");
        // The compact Treatment row itself must expose its last destination,
        // including horizontal scrolling when necessary on a narrow screen.
        await notCovered(page, "patient-tab-files");
        await page.evaluate(() => window.scrollTo(0, 0));
        const record = await page.getByTestId("endo-record").boundingBox();
        expect(record).not.toBeNull(); expect(record!.y + record!.height).toBeLessThan(770);
        await page.getByTestId("endo-record").click();
        const first = await page.getByTestId("endo-stage").boundingBox();
        expect(first).not.toBeNull(); expect(first!.y + first!.height).toBeLessThan(770);
        await page.getByTestId("endo-note").fill("مسودة لا تضيع عند فتح بيانات المريض");
        await page.getByTestId("patient-details-toggle").click();
        const details = page.getByTestId("patient-details-panel");
        expect(await details.isVisible()).toBe(true);
        expect(await details.getByRole("button", { name: /حجز موعد/ }).isVisible()).toBe(true);
        for (const text of ["وضع الكرسي", "الملف الشامل", "العلامات الحيوية", "ربحية الحالة"]) {
          expect(await details.getByText(text, { exact: true }).isVisible()).toBe(true);
        }
        await details.getByText("المزيد ⋯", { exact: true }).click();
        expect(await details.getByRole("button", { name: /وصفة طبية/ }).isVisible()).toBe(true);
        expect(await details.getByRole("button", { name: /حذف الملف/ }).count()).toBe(0);
        await page.getByTestId("patient-details-toggle").click();
        expect(await page.getByTestId("patient-more-actions").getAttribute("open")).toBeNull();
        expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة لا تضيع عند فتح بيانات المريض");
        if (width === 390) {
          page.once("dialog", (dialog) => dialog.dismiss());
          await page.getByTestId("patient-treatment-section").selectOption("plans");
          expect(await page.getByTestId("patient-treatment-section").inputValue()).toBe("endo");
          expect(new URL(page.url()).searchParams.get("sub")).toBe("endo");
        }
        await page.getByTestId("endo-next-step").fill("مراجعة تجريبية");
        await page.getByTestId("endo-next-step").press("Tab");
        expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("endo-save");
        await notCovered(page, "endo-save");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await mkdir(".settings-ui-artifacts", { recursive: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `.settings-ui-artifacts/patient-compact-shell-${width}.png`, fullPage: true });

        // Accepted selector navigation is distinct from the cancellation above.
        page.once("dialog", (dialog) => dialog.accept());
        if (width === 390) {
          await page.getByTestId("patient-treatment-section").selectOption("plans");
          await expect.poll(() => page.getByTestId("patient-treatment-section").inputValue()).toBe("plans");
          expect(new URL(page.url()).searchParams.get("sub")).toBe("plans");
        } else {
          await page.getByTestId("patient-tab-summary").click();
        }
        for (const tab of ["summary", "treatment", "today", "account", "files"]) {
          const button = page.getByTestId(`patient-tab-${tab}`);
          expect(await button.isVisible()).toBe(true);
          await notCovered(page, `patient-tab-${tab}`);
          await button.click();
          await expect.poll(() => button.getAttribute("aria-current")).toBe("page");
          expect(new URL(page.url()).searchParams.get("tab")).toBe(tab);
          expect(await page.getByTestId("patient-more-actions").getAttribute("open")).toBeNull();
          expect(await page.getByTestId("patient-context-strip").evaluate((node) => getComputedStyle(node).position)).toBe("static");
          if (tab === "today") {
            expect(await page.getByTestId("patient-context-strip").getAttribute("data-compact")).toBe("true");
            expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(false);
            expect(await page.getByTestId("patient-primary-action").isVisible()).toBe(true);
            expect(await page.getByTestId("patient-context-strip").evaluate((node) => getComputedStyle(node).position)).toBe("static");
          }
          if (tab === "files") await notCovered(page, "patient-tab-files");
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
  });

  it("keeps all clinical alerts and exact identity explicit, with each financial currency shown only to authorized staff", async () => {
    for (const who of ["admin", "doctorA"] as const) {
      const { context, page } = await open(who, alertPatientId, 390);
      try {
        const strip = page.getByTestId("patient-context-strip");
        await expect.poll(() => strip.innerText()).toContain("تنبيه ثالث مهم");
        for (const text of [alertName, `#SHELL-ALERT-${stamp}`, "حساسية بنسلين", "مميعات دم", "185/120"]) expect(await strip.innerText()).toContain(text);
        expect(await page.getByTestId("patient-compact-pressure-alert").isVisible()).toBe(true);
        expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(false);
        if (who === "admin") {
          await expect.poll(() => strip.innerText()).toContain(formatMoney(12000, "YER"));
          expect(await strip.innerText()).toContain(formatMoney(3400, "SAR"));
        } else {
          expect(await strip.innerText()).not.toContain(formatMoney(12000, "YER"));
          expect(await strip.innerText()).not.toContain(formatMoney(3400, "SAR"));
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await mkdir(".settings-ui-artifacts", { recursive: true });
        await page.screenshot({ path: `.settings-ui-artifacts/patient-compact-alerts-${who}.png`, fullPage: true });
      } finally { await context.close(); }
    }
  });

  it("shows a PatientEditor-saved warning with details closed even when the follow-up reads fail", async () => {
    const { context, page } = await open("doctorA", patientId, 390);
    const savedWarning = "حساسية محفوظة قبل إعادة التحميل التجريبي";
    try {
      await page.getByTestId("endo-record").click();
      await page.getByTestId("endo-note").fill("مسودة تبقى عند تعديل تنبيه المريض");
      await page.getByTestId("patient-details-toggle").click();
      await page.getByTestId("patient-details-panel").getByText("المزيد ⋯", { exact: true }).click();
      await page.getByRole("button", { name: "✏️ تعديل بيانات الملف", exact: true }).click();
      const editor = page.locator('section[aria-label="تعديل البيانات"]');
      await editor.getByPlaceholder("مثال: حساسية بنسيلين، ضغط وسكر", { exact: true }).fill(savedWarning);
      await page.route(`**/api/patients/${patientId}`, async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "تعذّر إعادة التحميل تجريبيًا" }) });
        } else await route.continue();
      });
      await page.route(`**/api/visits/readiness?patientId=${patientId}`, async (route) => {
        await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      });
      await editor.getByRole("button", { name: "حفظ التغييرات", exact: true }).click();
      await editor.waitFor({ state: "detached" });
      await page.getByTestId("patient-details-toggle").click();
      expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(false);
      await expect.poll(() => page.getByTestId("patient-context-strip").innerText()).toContain(savedWarning);
      expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة تبقى عند تعديل تنبيه المريض");
      expect((await db.query("SELECT medical_alert FROM patients WHERE id = $1", [patientId])).rows[0].medical_alert).toBe(savedWarning);
    } finally {
      await context.close();
      await db.query("UPDATE patients SET medical_alert = NULL WHERE id = $1", [patientId]);
    }
  });
});
