import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Dialog, type Locator } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";

// Only the unchanged disposable GitHub Actions harness may execute this suite.
// Every browser write and external origin is denied, including teardown.
describe.runIf(process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true")(
  "patient More disclosure on the built application", () => {
    let browser: Browser;
    let db: Client;
    let h: Awaited<ReturnType<typeof harness>>;
    let patientId: number;
    beforeAll(async () => {
      h = await harness();
      db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
      await db.connect();
      const doctor = (await db.query<{ party_id: number }>(
        "SELECT party_id FROM users WHERE username = 'secdoctora'")).rows[0].party_id;
      patientId = (await db.query<{ id: number }>(
        "INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض اختبار القائمة — ليس حقيقياً', $2) RETURNING id",
        [`MORE-${Date.now()}`, doctor])).rows[0].id;
      await db.query(
        "INSERT INTO visits (patient_name, patient_id, doctor_id, status) VALUES ('مريض اختبار القائمة', $1, $2, 'in_chair')",
        [patientId, doctor]);
      const caseId = (await db.query<{ id: number }>(
        "INSERT INTO clinical_cases (patient_id, specialty, title, responsible_party_id, created_by) VALUES ($1, 'endodontics', 'حالة اختبار القائمة', $2, 'secdoctora') RETURNING id",
        [patientId, doctor])).rows[0].id;
      await db.query(
        "INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 36, 'secdoctora')",
        [patientId, caseId]);
      browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    }, 240_000);
    afterAll(async () => { await browser?.close(); await db?.end(); });

    const layouts = [
      { width: 390, direction: "rtl" }, { width: 390, direction: "ltr" },
      { width: 1280, direction: "rtl" }, { width: 1280, direction: "ltr" },
    ];
    it.each(layouts)("dismisses once with pointer, touch and keyboard at $width px / $direction", async ({ width, direction }) => {
      const context = await browser.newContext({
        viewport: { width, height: 1100 }, locale: "ar-YE",
        hasTouch: width === 390, serviceWorkers: "block",
      });
      try {
        const [name, ...value] = h.sessions.admin.cookie.split("=");
        await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
        const unexpected: string[] = [], errors: string[] = [];
        let printRequests = 0;
        const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
            unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
            await route.abort(); return;
          }
          // Exercise target=_blank once without invoking the browser print UI.
          if (url.pathname === `/print/statement/${patientId}`) {
            printRequests += 1;
            await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Synthetic print destination</title>" });
            return;
          }
          await route.continue();
        });
        const page = await context.newPage();
        page.on("pageerror", error => errors.push(error.message));
        const more = page.getByTestId("patient-more-actions");
        const toggle = more.locator(":scope > summary");
        const panel = page.locator("#patient-more-actions-panel");
        const details = page.getByTestId("patient-details-toggle");
        const closed = async () => {
          await expect.poll(() => more.getAttribute("open")).toBeNull();
          expect(await toggle.getAttribute("aria-expanded")).toBe("false");
          expect(await panel.isVisible()).toBe(false);
        };
        const opened = async () => {
          await expect.poll(() => more.getAttribute("open")).not.toBeNull();
          expect(await toggle.getAttribute("aria-expanded")).toBe("true");
          expect(await panel.isVisible()).toBe(true);
        };
        const activate = async (target: Locator) => {
          if (width === 390) await target.tap(); else await target.click();
        };
        const focused = async (target: Locator) =>
          expect.poll(() => target.evaluate(element => element === document.activeElement)).toBe(true);
        const go = async () => {
          await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=endo`, { waitUntil: "domcontentloaded" });
          await page.getByTestId("endo-record").waitFor();
          await page.evaluate(dir => { document.documentElement.dir = dir; }, direction);
          expect(await details.innerText()).toBe("بيانات المريض والإجراءات");
          expect(await page.getByRole("button", { name: "المزيد", exact: true }).count()).toBe(0);
          await details.click();
          expect(await page.locator("h1:visible").count()).toBe(1);
          await closed();
        };
        await routes.run(async () => {
          await go();
          // Native summary still supports Enter and Space. Tab uses the ordinary
          // links/buttons order, without an incorrect ARIA menu/arrow-key promise.
          await toggle.focus(); await page.keyboard.press("Enter"); await opened();
          await page.keyboard.press("Tab");
          await focused(panel.locator("a[href], button").first());
          await page.keyboard.press("Escape"); await closed(); await focused(toggle);
          await page.keyboard.press("Space"); await opened();
          await panel.locator("a[href], button").last().focus();
          await page.keyboard.press("Tab"); await closed();
          expect(await more.evaluate(element => element.contains(document.activeElement))).toBe(false);
          await toggle.focus(); await page.keyboard.press("Space"); await opened();
          await page.keyboard.press("Shift+Tab"); await closed();
          expect(await more.evaluate(element => element.contains(document.activeElement))).toBe(false);

          // Repeated summary activation has exactly one owner. A double-click
          // returns to closed rather than racing a delayed native toggle event.
          for (let index = 0; index < 3; index += 1) {
            await activate(toggle); await opened();
            await activate(toggle); await closed();
          }
          await toggle.dblclick(); await closed();
          await activate(toggle); await opened();
          await panel.click({ position: { x: 3, y: 3 } }); await opened();
          const box = await panel.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
          await mkdir(".settings-ui-artifacts", { recursive: true });
          await page.screenshot({ path: `.settings-ui-artifacts/patient-more-open-${width}-${direction}.png`, fullPage: true });
          // Outside non-focusable content dismisses without a second tap.
          await activate(page.locator("h1:visible")); await closed();
          await activate(toggle); await opened();
          await activate(details); await closed();
          expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(false);
          await activate(details); await closed();

          // Selection preserves the original handler and runs it exactly once:
          // Edit opens once, and selecting it again closes that same editor.
          const edit = more.getByRole("button", { name: "✏️ تعديل بيانات الملف", exact: true });
          const editor = page.getByRole("region", { name: "تعديل البيانات", exact: true });
          await activate(toggle); await activate(edit); await closed();
          await editor.waitFor({ state: "visible" }); await focused(toggle);
          await activate(toggle); await edit.focus(); await page.keyboard.press("Enter");
          await closed(); await editor.waitFor({ state: "hidden" });

          // An action's form remains usable after disclosure dismissal.
          await activate(toggle);
          await activate(more.getByRole("button", { name: "℞ وصفة طبية", exact: true }));
          await closed();
          await page.getByRole("heading", { name: "إصدار وصفة طبية (روشتة)", exact: true }).waitFor();
          await page.getByRole("button", { name: "إلغاء", exact: true }).click();
          await closed();
          await activate(toggle);
          await activate(more.getByRole("button", { name: "✍️ إقرار طبي مستنير", exact: true }));
          await closed();
          const consent = page.getByRole("dialog").filter({
            has: page.getByRole("heading", { name: "إقرار الموافقة الطبية المستنيرة (Informed Consent)", exact: true }),
          });
          await consent.waitFor();
          const checkbox = consent.getByRole("checkbox").first();
          await checkbox.check(); await focused(checkbox);
          expect(await checkbox.isChecked()).toBe(true);
          await consent.getByRole("button", { name: "إلغاء", exact: true }).click();
          await consent.waitFor({ state: "hidden" }); await closed();

          // The destructive item still only opens its existing confirmation.
          // No confirmation is submitted, and all network writes remain denied.
          await activate(toggle);
          await activate(more.getByRole("button", { name: "🗑 حذف الملف نهائيًا", exact: true }));
          await closed();
          await page.getByRole("heading", { name: "حذف ملف المريض نهائيًا", exact: true }).waitFor();
          expect(await page.getByRole("button", { name: "حذف نهائي لا رجعة فيه", exact: true }).isEnabled()).toBe(false);
          await page.getByRole("button", { name: "إلغاء", exact: true }).click(); await closed();

          await activate(toggle);
          const popupPromise = context.waitForEvent("page");
          await activate(more.getByRole("link", { name: "🖨️ طباعة كشف حساب", exact: true }));
          const popup = await popupPromise; await popup.waitForLoadState("domcontentloaded");
          expect(await popup.title()).toBe("Synthetic print destination");
          expect(printRequests).toBe(1); await popup.close(); await closed();

          // A real document navigation and Back must not revive an open menu.
          await activate(toggle);
          await activate(more.getByRole("link", { name: "✉️ مراسلة المريض", exact: true }));
          await page.waitForURL(`${baseUrl}/messages?patient=${patientId}`);
          await page.goBack(); await page.getByTestId("endo-record").waitFor();
          await closed();
          if (!(await page.getByTestId("patient-details-panel").isVisible())) await details.click();
          await page.evaluate(dir => { document.documentElement.dir = dir; }, direction);

          // Refusal leaves the draft/URL/details untouched. The outside pointer
          // independently dismisses More before the unchanged goTo guard runs;
          // programmatic rejected navigation has no such outside interaction.
          await page.getByTestId("endo-record").click();
          await page.getByTestId("endo-note").fill("مسودة اختبار القائمة محفوظة في الشاشة");
          const before = page.url();
          await activate(toggle); await opened();
          let prompts = 0;
          const refuse = async (dialog: Dialog) => { prompts += 1; await dialog.dismiss(); };
          page.on("dialog", refuse);
          try { await activate(page.getByTestId("patient-tab-summary")); }
          finally { page.off("dialog", refuse); }
          expect(prompts).toBe(1); expect(page.url()).toBe(before); await closed();
          expect(await page.getByTestId("endo-note").inputValue()).toBe("مسودة اختبار القائمة محفوظة في الشاشة");
          expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(true);
          await activate(toggle); await opened();
          const accept = async (dialog: Dialog) => { prompts += 1; await dialog.accept(); };
          page.on("dialog", accept);
          try { await activate(page.getByTestId("patient-tab-summary")); }
          finally { page.off("dialog", accept); }
          expect(prompts).toBe(2);
          await expect.poll(() => page.getByTestId("patient-tab-summary").getAttribute("aria-current")).toBe("page");
          await closed();
          await page.reload(); await page.getByTestId("patient-tab-summary").waitFor(); await closed();
          // The restored Summary has the original full header and only the
          // pictured inner More menu, without a second More-labeled disclosure.
          expect(await page.getByTestId("patient-workspace").getAttribute("data-compact")).toBe("false");
          expect(await details.count()).toBe(0);
          expect(await page.getByTestId("patient-details-panel").isVisible()).toBe(true);
          await activate(toggle); await opened();
          await activate(page.getByRole("heading", { level: 1 })); await closed();
          await activate(toggle); await opened();
          await page.keyboard.press("Escape"); await closed(); await focused(toggle);
          expect(unexpected).toEqual([]); expect(errors).toEqual([]);
        }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
      } finally { await context.close(); }
    });
  },
);

