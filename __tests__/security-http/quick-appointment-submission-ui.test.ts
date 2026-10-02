import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Route } from "playwright";
import { baseUrl, harness } from "./_server";

// The real built reception page/session, with only synthetic intercepted writes.
// No patient or appointment is created by these browser journeys.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

const patientId = 91001;
const patientName = "مريض حجز تجريبي";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status, contentType: "application/json", body: JSON.stringify(body),
});
async function fixture(width = 1280, existing = false) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const patientRequests: Route[] = [];
  const appointmentRequests: Route[] = [];
  await page.route("**/api/parties?kind=doctor", (route) => json(route, []));
  await page.route("**/api/settings/appointment-services", (route) => json(route, { services: [], chairs: 4 }));
  await page.route("**/api/patients?*", (route) => json(route, existing
    ? [{ id: patientId, fullName: patientName, patientNumber: "SYNTHETIC-BOOKING", phone: null }] : []));
  await page.route("**/api/patients", async (route) => {
    if (route.request().method() === "POST") patientRequests.push(route);
    else await json(route, []);
  });
  await page.route("**/api/appointments?*", (route) => json(route, []));
  await page.route("**/api/appointments", async (route) => {
    if (route.request().method() === "POST") appointmentRequests.push(route);
    else await json(route, []);
  });
  await page.goto(`${baseUrl}/appointments`, { waitUntil: "networkidle" });
  const open = () => page.getByRole("button", { name: /حجز موعد جديد/ }).click();
  await open();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("المريض", { exact: true }).fill(patientName);
  if (existing) await dialog.getByRole("button", { name: new RegExp(patientName) }).click();
  const submit = dialog.locator('button[type="submit"]');
  const twice = () => dialog.locator("form").evaluate((form) => {
    // Two submissions in one event turn also exercise the synchronous ref guard.
    (form as HTMLFormElement).requestSubmit();
    (form as HTMLFormElement).requestSubmit();
  });
  return { context, page, dialog, submit, open, twice, patientRequests, appointmentRequests };
}

describe("quick booking repeated and interrupted flows", () => {
  it.each([1280, 390])("keeps the %ipx dialog locked throughout both writes, then resets after success", async (width) => {
    const f = await fixture(width);
    try {
      await f.twice();
      await expect.poll(() => f.patientRequests.length).toBe(1);
      expect(await f.submit.isDisabled()).toBe(true);
      expect(await f.dialog.getByRole("button", { name: "إغلاق", exact: true }).isDisabled()).toBe(true);
      expect(await f.dialog.getByRole("button", { name: "إلغاء", exact: true }).isDisabled()).toBe(true);
      await f.page.keyboard.press("Escape");
      expect(await f.dialog.isVisible()).toBe(true);
      await f.twice();
      await json(f.patientRequests[0], { id: patientId }, 201);
      await expect.poll(() => f.appointmentRequests.length).toBe(1);
      expect(f.patientRequests).toHaveLength(1);
      expect(await f.submit.isDisabled()).toBe(true);
      expect(f.appointmentRequests[0].request().postDataJSON()).toMatchObject({ patientId, isNewPatient: true });
      await json(f.appointmentRequests[0], { id: 92001 }, 201);
      await expect.poll(() => f.dialog.count()).toBe(0);
      expect(f.patientRequests).toHaveLength(1);
      expect(f.appointmentRequests).toHaveLength(1);
      await f.open();
      expect(await f.dialog.getByLabel("المريض", { exact: true }).inputValue()).toBe("");
      expect(await f.submit.isEnabled()).toBe(true);
      // A fresh opening can still be dismissed normally after the write settles.
      await f.dialog.getByRole("button", { name: "إلغاء", exact: true }).click();
      await expect.poll(() => f.dialog.count()).toBe(0);
    } finally { await f.context.close(); }
  });

  it("releases the full booking lock after a patient-create rejection", async () => {
    const f = await fixture();
    try {
      await f.submit.click();
      await expect.poll(() => f.patientRequests.length).toBe(1);
      await json(f.patientRequests[0], { message: "تعذّر الإنشاء" }, 400);
      await expect.poll(() => f.submit.isEnabled()).toBe(true);
      expect(await f.dialog.getByRole("alert").textContent()).toContain("تعذّر إنشاء ملف للمريض الجديد");
      expect(f.appointmentRequests).toHaveLength(0);
      await f.submit.click();
      await expect.poll(() => f.patientRequests.length).toBe(2);
      await json(f.patientRequests[1], { id: patientId }, 201);
      await expect.poll(() => f.appointmentRequests.length).toBe(1);
      await json(f.appointmentRequests[0], { id: 92001 }, 201);
      await expect.poll(() => f.dialog.count()).toBe(0);
      expect(f.appointmentRequests).toHaveLength(1);
    } finally { await f.context.close(); }
  });

  it("retains a newly created patient after a booking conflict and retries only the appointment", async () => {
    const f = await fixture();
    try {
      await f.submit.click();
      await expect.poll(() => f.patientRequests.length).toBe(1);
      await json(f.patientRequests[0], { id: patientId }, 201);
      await expect.poll(() => f.appointmentRequests.length).toBe(1);
      await json(f.appointmentRequests[0], { message: "الوقت ممتلئ", canOverride: false }, 409);
      await expect.poll(() => f.submit.isEnabled()).toBe(true);
      expect(await f.dialog.getByRole("button", { name: "تغيير المريض", exact: true }).isVisible()).toBe(true);
      expect(await f.dialog.getByRole("alert").textContent()).toContain("الوقت ممتلئ");
      await f.submit.click();
      await expect.poll(() => f.appointmentRequests.length).toBe(2);
      expect(f.patientRequests).toHaveLength(1);
      expect(f.appointmentRequests[1].request().postDataJSON()).toMatchObject({ patientId, isNewPatient: true });
      await json(f.appointmentRequests[1], { id: 92001 }, 201);
      await expect.poll(() => f.dialog.count()).toBe(0);
    } finally { await f.context.close(); }
  });

  it("allows only one same-turn booking for a selected existing patient", async () => {
    const f = await fixture(1280, true);
    try {
      await f.twice();
      await expect.poll(() => f.appointmentRequests.length).toBe(1);
      expect(f.patientRequests).toHaveLength(0);
      expect(f.appointmentRequests[0].request().postDataJSON()).toMatchObject({ patientId, isNewPatient: false });
      await json(f.appointmentRequests[0], { id: 92001 }, 201);
      await expect.poll(() => f.dialog.count()).toBe(0);
      expect(f.appointmentRequests).toHaveLength(1);
    } finally { await f.context.close(); }
  });
});
