import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Route } from "playwright";
import { mkdir } from "node:fs/promises";
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
const doctors = [{ id: 91002, name: "طبيب تجريبي أول" }, { id: 91003, name: "طبيب تجريبي آخر" }];
const services = [
  { id: 93001, code: "SYNTHETIC_CHECKUP", nameAr: "كشف تجريبي", defaultDurationMinutes: 30, bufferAfterMinutes: 0, requiresChair: true, legacyType: "consultation" },
  { id: 93002, code: "SYNTHETIC_FOLLOWUP", nameAr: "متابعة تجريبية", defaultDurationMinutes: 60, bufferAfterMinutes: 0, requiresChair: true, legacyType: "follow_up" },
];
async function fixture(width = 1280, existing = false, catalog = false, suggest = existing) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const patientRequests: Route[] = [];
  const appointmentRequests: Route[] = [];
  const waitingRequests: Route[] = [];
  await page.route("**/api/parties?kind=doctor", (route) => json(route, doctors));
  await page.route("**/api/settings/appointment-services", (route) => json(route, { services: catalog ? services : [], chairs: 4 }));
  await page.route("**/api/appointments/availability?*", (route) => json(route, { slots: [
    { time: "16:00", status: "available", label: "متاح" },
    { time: "17:00", status: "available", label: "متاح" },
    { time: "18:00", status: "booked", label: "محجوز" },
  ] }));
  await page.route("**/api/patients?*", (route) => json(route, suggest
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
  await page.route("**/api/waiting-list", async (route) => {
    if (route.request().method() === "POST") waitingRequests.push(route);
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
  return { context, page, dialog, submit, open, twice, patientRequests, appointmentRequests, waitingRequests };
}

async function expectFrozen(dialog: Locator) {
  expect(await dialog.getAttribute("aria-busy")).toBe("true");
  const controls = dialog.locator("input, select, textarea, button");
  expect(await controls.count()).toBeGreaterThan(10);
  expect(await dialog.locator("input:enabled, select:enabled, textarea:enabled, button:enabled").count()).toBe(0);
  // Fieldsets do not disable links or custom controls: fail if one is introduced
  // without an explicit pending-state guard in a future change.
  expect(await dialog.locator("a[href], [contenteditable=true], [role=button]:not(button)").count()).toBe(0);
}

describe("quick booking repeated and interrupted flows", () => {
  it.each([
    { width: 1280, catalog: false }, { width: 390, catalog: false },
    { width: 1280, catalog: true }, { width: 390, catalog: true },
  ])("freezes the RTL $width px draft (catalog: $catalog) throughout both writes, then resets", async ({ width, catalog }) => {
    const f = await fixture(width, false, catalog, true);
    try {
      const fields = {
        phone: "700000001", date: "2030-01-15", time: "16:00", duration: "45",
        doctor: "91002", chair: "2", note: "ملاحظة الحجز الأصلية",
      };
      if (catalog) await f.dialog.locator('[data-service="SYNTHETIC_CHECKUP"]').click();
      for (const [id, value] of Object.entries(fields)) {
        const field = f.dialog.locator(`[id$="-${id}"]`);
        if (["duration", "doctor", "chair"].includes(id)) await field.selectOption(value);
        else await field.fill(value);
      }
      const suggestion = f.dialog.getByRole("button", { name: /SYNTHETIC-BOOKING/ });
      await expect.poll(() => suggestion.count()).toBe(1);
      const availableSlot = f.dialog.getByRole("button", { name: "17:00 — متاح", exact: true });
      await expect.poll(() => availableSlot.count()).toBe(1);
      expect(await availableSlot.isEnabled()).toBe(true);
      expect(await f.page.locator("html").getAttribute("dir")).toBe("rtl");
      expect(await f.dialog.locator("fieldset").evaluate((panel) => {
        const bounds = panel.getBoundingClientRect();
        return panel.scrollWidth <= panel.clientWidth && bounds.left >= 0 && bounds.right <= window.innerWidth;
      })).toBe(true);
      await f.twice();
      await expect.poll(() => f.patientRequests.length).toBe(1);
      await expectFrozen(f.dialog);
      // Real input/select interaction must be refused, not merely omitted from
      // the captured payload while a different draft remains on screen.
      for (const [id, value] of Object.entries({ patient: "اسم آخر", ...fields })) {
        const field = f.dialog.locator(`[id$="-${id}"]`);
        if (["duration", "doctor", "chair"].includes(id)) {
          const alternative = id === "duration" ? "60" : id === "doctor" ? "91003" : "3";
          await expect(field.selectOption(alternative, { timeout: 150 })).rejects.toThrow();
        } else {
          const alternative = id === "date" ? "2030-01-16" : id === "time" ? "19:00" : "تغيير";
          await expect(field.fill(alternative, { timeout: 150 })).rejects.toThrow();
        }
        expect(await field.inputValue()).toBe(id === "patient" ? patientName : value);
      }
      await suggestion.click({ force: true });
      await suggestion.evaluate((button) => (button as HTMLButtonElement).click());
      await availableSlot.click({ force: true });
      await availableSlot.evaluate((button) => (button as HTMLButtonElement).click());
      const typeButtons = f.dialog.getByRole("group", { name: "نوع الموعد / الإجراء" }).getByRole("button");
      const originalTypes = await typeButtons.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-pressed")));
      await typeButtons.nth(1).click({ force: true });
      await typeButtons.nth(1).evaluate((button) => (button as HTMLButtonElement).click());
      expect(await typeButtons.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-pressed")))).toEqual(originalTypes);
      await f.page.keyboard.press("Escape");
      await f.page.keyboard.press("Tab");
      expect(await f.dialog.isVisible()).toBe(true);
      expect(await f.dialog.locator("input:focus, select:focus, textarea:focus, button:focus").count()).toBe(0);
      expect(await f.dialog.locator('[id$="-patient"]').inputValue()).toBe(patientName);
      expect(await f.dialog.locator('[id$="-time"]').inputValue()).toBe(fields.time);
      expect(await f.dialog.locator('[id$="-duration"]').inputValue()).toBe(fields.duration);
      await f.twice();
      await json(f.patientRequests[0], { id: patientId }, 201);
      await expect.poll(() => f.appointmentRequests.length).toBe(1);
      await expectFrozen(f.dialog);
      const changePatient = f.dialog.getByRole("button", { name: "تغيير المريض", exact: true });
      await changePatient.evaluate((button) => (button as HTMLButtonElement).click());
      expect(await changePatient.isVisible()).toBe(true);
      expect(await f.dialog.getByRole("heading").textContent()).toContain(patientName);
      for (const [id, value] of Object.entries(fields).filter(([id]) => id !== "phone")) {
        expect(await f.dialog.locator(`[id$="-${id}"]`).inputValue()).toBe(value);
      }
      if (catalog) {
        await mkdir(".settings-ui-artifacts", { recursive: true });
        const panel = f.dialog.locator("fieldset");
        await panel.evaluate((element) => { element.scrollTop = 0; });
        await panel.screenshot({ path: `.settings-ui-artifacts/quick-booking-frozen-${width === 390 ? "mobile" : "desktop"}.png` });
      }
      expect(f.patientRequests).toHaveLength(1);
      expect(f.patientRequests[0].request().postDataJSON()).toEqual({ fullName: patientName, phone: fields.phone });
      expect(f.appointmentRequests[0].request().postDataJSON()).toMatchObject({
        patientId, isNewPatient: true, date: fields.date, time: fields.time, note: fields.note,
        durationMinutes: 45, doctorId: 91002, chairNo: 2, appointmentType: "consultation",
        ...(catalog ? { serviceId: 93001 } : {}),
      });
      await json(f.appointmentRequests[0], { id: 92001 }, 201);
      await expect.poll(() => f.dialog.count()).toBe(0);
      expect(f.patientRequests).toHaveLength(1);
      expect(f.appointmentRequests).toHaveLength(1);
      expect(f.waitingRequests).toHaveLength(0);
      await f.open();
      expect(await f.dialog.getByLabel("المريض", { exact: true }).inputValue()).toBe("");
      expect(await f.dialog.locator('[id$="-note"]').inputValue()).toBe("");
      expect(await f.dialog.locator('[id$="-doctor"]').inputValue()).toBe("");
      expect(await f.submit.isEnabled()).toBe(true);
      await f.dialog.getByLabel("المريض", { exact: true }).fill("مريض جديد بعد النجاح");
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
      await f.dialog.getByLabel("المريض", { exact: true }).fill("اسم مصحح بعد الفشل");
      await f.dialog.locator('[id$="-date"]').fill("2030-01-16");
      await f.dialog.locator('[id$="-time"]').fill("17:00");
      await f.dialog.locator('[id$="-doctor"]').selectOption("91003");
      await f.dialog.locator('[id$="-note"]').fill("ملاحظة مصححة");
      await f.submit.click();
      await expect.poll(() => f.patientRequests.length).toBe(2);
      await expectFrozen(f.dialog);
      expect(f.patientRequests[1].request().postDataJSON().fullName).toBe("اسم مصحح بعد الفشل");
      await json(f.patientRequests[1], { id: patientId }, 201);
      await expect.poll(() => f.appointmentRequests.length).toBe(1);
      expect(f.appointmentRequests[0].request().postDataJSON()).toMatchObject({
        date: "2030-01-16", time: "17:00", doctorId: 91003, note: "ملاحظة مصححة",
      });
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
      await f.dialog.locator('[id$="-time"]').fill("17:00");
      await f.dialog.locator('[id$="-note"]').fill("إعادة محاولة بعد التعارض");
      await f.submit.click();
      await expect.poll(() => f.appointmentRequests.length).toBe(2);
      expect(f.patientRequests).toHaveLength(1);
      expect(f.appointmentRequests[1].request().postDataJSON()).toMatchObject({ patientId, isNewPatient: true, time: "17:00", note: "إعادة محاولة بعد التعارض" });
      await expectFrozen(f.dialog);
      await json(f.appointmentRequests[1], { id: 92001 }, 201);
      await expect.poll(() => f.dialog.count()).toBe(0);
    } finally { await f.context.close(); }
  });

  it("freezes override and already-open waiting-list preferences while a conflicted booking retries", async () => {
    const f = await fixture(390, true);
    try {
      await f.submit.click();
      await expect.poll(() => f.appointmentRequests.length).toBe(1);
      await json(f.appointmentRequests[0], { message: "الوقت ممتلئ", canOverride: true }, 409);
      await expect.poll(() => f.submit.isEnabled()).toBe(true);
      await f.dialog.locator('[data-action="add-to-waiting-list"]').click();
      await f.dialog.locator('[data-waiting-day="1"]').click();
      await f.dialog.locator('[data-waiting-shift]').selectOption("shift2");
      await f.dialog.locator('[data-waiting-sameday="yes"]').click();
      const override = f.dialog.locator('[id$="-override"]');
      await override.fill("حالة ألم حاد");
      await f.submit.click();
      await expect.poll(() => f.appointmentRequests.length).toBe(2);
      await expectFrozen(f.dialog);
      await expect(override.fill("سبب مختلف", { timeout: 150 })).rejects.toThrow();
      await expect(f.dialog.locator('[data-waiting-shift]').selectOption("any", { timeout: 150 })).rejects.toThrow();
      await f.dialog.locator('[data-waiting-day="1"]').evaluate((button) => (button as HTMLButtonElement).click());
      await f.dialog.locator('[data-waiting-sameday="no"]').evaluate((button) => (button as HTMLButtonElement).click());
      await f.dialog.locator('[data-action="save-to-waiting-list"]').evaluate((button) => (button as HTMLButtonElement).click());
      await f.dialog.getByRole("button", { name: "تراجع", exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
      expect(await override.inputValue()).toBe("حالة ألم حاد");
      expect(await f.dialog.locator('[data-waiting-day="1"]').getAttribute("aria-pressed")).toBe("true");
      expect(await f.dialog.locator('[data-waiting-sameday="yes"]').getAttribute("aria-pressed")).toBe("true");
      expect(await f.dialog.locator('[data-waiting-shift]').inputValue()).toBe("shift2");
      expect(f.waitingRequests).toHaveLength(0);
      expect(f.appointmentRequests[1].request().postDataJSON().overrideReason).toBe("حالة ألم حاد");
      await json(f.appointmentRequests[1], { message: "تعذّر الحجز" }, 500);
      await expect.poll(() => f.submit.isEnabled()).toBe(true);
      await override.fill("سبب مصحح");
      await f.dialog.locator('[data-waiting-sameday="no"]').click();
      expect(await f.dialog.locator('[data-waiting-sameday="no"]').getAttribute("aria-pressed")).toBe("true");
      expect(await f.dialog.locator('[data-action="save-to-waiting-list"]').isEnabled()).toBe(true);
      await f.dialog.getByRole("button", { name: "تراجع", exact: true }).click();
      expect(await f.dialog.locator('[data-action="add-to-waiting-list"]').isEnabled()).toBe(true);
      await f.dialog.getByRole("button", { name: "إلغاء", exact: true }).click();
      await expect.poll(() => f.dialog.count()).toBe(0);
      expect(f.patientRequests).toHaveLength(0);
      expect(f.waitingRequests).toHaveLength(0);
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
