import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Dialog, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { baseUrl, harness } from "./_server";

// Real built patient page, SessionProvider, canonical tab controller and CSS.
// Only existing disposable HTTP-harness identities/patients are used. Ortho
// reads are synthetic and every browser mutation is blocked or explicitly
// intercepted. No fixture SQL, real adjustment, photo upload or sign occurs.
// Native document routing is left intact; this suite does not install custom
// popstate/beforeunload handlers or manipulate React/page ownership state.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
const CASE_A = 959611, CASE_B = 959612;
const SYNTHETIC_ADJUSTMENT = 959621;
const MARKER_A = "SYNTHETIC-ORTHO-NAV-A", MARKER_B = "SYNTHETIC-ORTHO-NAV-B";
const DRAFT_A = "مسودة تقويم اصطناعية للمريض أ", DRAFT_B = "مسودة تقويم اصطناعية للمريض ب";
const DISCARD = "هناك عمل غير محفوظ في التقويم. هل تريد تجاهله ومغادرة القسم؟";
const UNCERTAIN = "نتيجة الحفظ غير مؤكدة؛ قد يكون الطلب نُفّذ. المغادرة لا تلغي الطلب ولا تعيد إرساله، وستُترك أي مسودة غير محفوظة. هل تريد مغادرة القسم؟";
const REJECTED = "رفض شدّة اصطناعي؛ لم تُكتب بيانات";
const FAILED = "تعذّر تأكيد نتيجة الشدّة الاصطناعية";
// Same tiny synthetic image fixture as patient-ortho-real-react.test.ts.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZs8AAAAASUVORK5CYII=", "base64");
const workspace = (page: Page) => page.getByTestId("patient-ortho-workspace");
const entry = (patientId = h.seeded.patientAId) =>
  `${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho&orthoNavProbe=retained#record`;
const json = (route: Route, payload: unknown, status = 200) => route.fulfill({
  status, contentType: "application/json", body: JSON.stringify(payload),
});

beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); });

type SyntheticSaved = { caseId: number; body: Record<string, unknown> };
function orthoPayload(patientId: number, saved: SyntheticSaved | null = null) {
  const second = patientId === h.seeded.patientBId;
  const caseId = second ? CASE_B : CASE_A;
  const adjustment = saved?.caseId === caseId ? { id: SYNTHETIC_ADJUSTMENT, visitId: null, visitSigned: false,
    doneOn: String(saved.body.doneOn), phase: "aligning", upperWire: String(saved.body.upperWire),
    lowerWire: String(saved.body.lowerWire), elastics: String(saved.body.elastics),
    elasticNote: String(saved.body.elasticNote), done: String(saved.body.done), nextWeeks: Number(saved.body.nextWeeks),
    note: null, recordedBy: "synthetic-browser-only", photos: [] } : null;
  return { cases: [{ id: caseId, patientId, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: second ? MARKER_B : MARKER_A, status: "active", phase: "aligning", startDate: "2026-01-01",
    plannedMonths: 24, upperWire: "014 NiTi", lowerWire: "012 NiTi", planId: null, retainer: null,
    retainerOn: null, note: null, closedAt: null, closedBy: null, closedNote: null, baselineKind: null,
    baselineRecordedAt: null, elastics: null, responsibleDoctorName: "طبيب اصطناعي", legacyFinancialMode: null,
    remainingObjectives: null, photosVisible: true, adjustments: adjustment ? [adjustment] : [], progress: { monthsElapsed: 9,
      monthsPlanned: 24, monthsRemaining: 15, percent: 37.5, overdue: false, adjustments: adjustment ? 1 : 0,
      lastAdjustment: adjustment?.doneOn ?? null, daysSinceLast: adjustment ? 0 : null } }] };
}

type Write = { path: string; body: unknown; status: 201 | 409 | 500; release: () => void };
async function fixture(width: number) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  // Admin can legitimately open both existing patients. Doctor A cannot be
  // used to fake authorization to B merely by replacing an Ortho response.
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [], downloads: string[] = [], documents: string[] = [];
  const writes: Write[] = [], dialogs: string[] = [];
  let armed: { path: string; status: 201 | 409 | 500 } | null = null;
  let syntheticSaved: SyntheticSaved | null = null;
  let expectedDialog: { message: string; accept: boolean; seen: boolean } | null = null;
  const dialogWork = new Set<Promise<void>>();
  const reads = new Map<number, number>();
  context.on("request", request => {
    if (request.isNavigationRequest() && request.resourceType() === "document") documents.push(request.url());
  });
  const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${url.pathname}`); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (method === "POST" && armed?.path === url.pathname && url.search === "") {
        const status = armed.status; armed = null;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const body = request.postDataJSON() as Record<string, unknown>;
        writes.push({ path: url.pathname, body, status, release });
        await gate;
        if (status === 201) {
          // A single explicitly armed synthetic success reaches the actual
          // NextAppointmentCard without a server write or React state injection.
          // Later GETs project only this in-memory synthetic adjustment.
          syntheticSaved = { caseId: Number(url.pathname.split("/").at(-1)), body };
          await json(route, { id: SYNTHETIC_ADJUSTMENT, visitId: null }, 201); return;
        }
        await json(route, { message: status === 409 ? REJECTED : FAILED }, status); return;
      }
      unexpected.push(`${method} ${url.pathname}${url.search}`); await route.abort(); return;
    }
    const patientId = Number(url.searchParams.get("patientId"));
    const knownPatient = patientId === h.seeded.patientAId || patientId === h.seeded.patientBId;
    if (method === "GET" && url.pathname === "/api/ortho" && knownPatient) {
      expect([...url.searchParams.entries()]).toEqual([["patientId", String(patientId)]]);
      reads.set(patientId, (reads.get(patientId) ?? 0) + 1);
      await json(route, orthoPayload(patientId, syntheticSaved)); return;
    }
    if (method === "GET" && url.pathname === "/api/plans" && knownPatient) {
      await json(route, { plans: [] }); return;
    }
    // Patient identity, workflow, session and all remaining reads use the real
    // authenticated harness routes. A malformed/denied patient cannot be hidden
    // by these synthetic Ortho rows.
    await route.continue();
  });
  const page = await context.newPage();
  context.on("page", () => unexpected.push("unexpected new page"));
  page.on("pageerror", error => errors.push(error.message));
  page.on("download", download => downloads.push(download.suggestedFilename()));
  page.on("dialog", (dialog: Dialog) => {
    const work = (async () => {
      dialogs.push(dialog.message());
      const allowed = expectedDialog;
      if (!allowed || allowed.seen || dialog.type() !== "confirm" || dialog.message() !== allowed.message) {
        unexpected.push(`unexpected ${dialog.type()} dialog: ${dialog.message()}`);
        await dialog.dismiss(); return;
      }
      allowed.seen = true;
      await (allowed.accept ? dialog.accept() : dialog.dismiss());
    })().catch(error => { errors.push(String(error)); });
    dialogWork.add(work); void work.finally(() => dialogWork.delete(work));
  });
  const assertIsolated = () => {
    expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(downloads).toEqual([]);
    expect(armed).toBeNull(); expect(expectedDialog).toBeNull();
  };
  return { page, context, writes, dialogs, documents, reads,
    arm: (status: 201 | 409 | 500, caseId = CASE_A) => {
      expect(armed).toBeNull(); armed = { path: `/api/ortho/${caseId}`, status };
    },
    prompt: async (accept: boolean, action: () => Promise<unknown>, message = DISCARD) => {
      expect(expectedDialog).toBeNull();
      const expected = { message, accept, seen: false }; expectedDialog = expected;
      const before = dialogs.length;
      try {
        await action(); await expect.poll(() => expected.seen).toBe(true);
        await Promise.all([...dialogWork]); await settle(page);
        expect(dialogs.slice(before)).toEqual([message]);
      } finally { expectedDialog = null; }
    },
    release: async (index = 0) => {
      const write = writes[index]; expect(write).toBeDefined();
      const pending = page.waitForResponse(response => response.request().method() === "POST"
        && new URL(response.url()).pathname === write.path);
      write.release(); const response = await pending;
      expect(response.status()).toBe(write.status); expect(await response.finished()).toBeNull();
      if (write.status === 201) {
        await ready(page);
        await workspace(page).getByRole("button", { name: "📅 حجز الموعد المقترح الآن", exact: true }).waitFor();
      } else if (write.status === 500) await page.getByTestId("ortho-write-uncertain").waitFor();
      else await workspace(page).getByRole("alert").filter({ hasText: REJECTED }).waitFor();
      await settle(page);
    },
    run: (body: () => Promise<void>) => routes.run(async () => {
      try {
        const response = await page.goto(entry(), { waitUntil: "domcontentloaded" });
        expect(response?.status()).toBe(200); await ready(page, MARKER_A);
        await body();
        await Promise.all([...dialogWork]); expect(context.pages()).toHaveLength(1); assertIsolated();
      } finally { for (const write of writes) write.release(); }
    }, assertIsolated),
  };
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function selected(page: Page, testId: string) {
  await expect.poll(() => page.getByTestId(testId).getAttribute("aria-current")).toBe("page");
}
async function ready(page: Page, marker = MARKER_A) {
  await selected(page, "patient-subtab-ortho");
  await expect.poll(() => workspace(page).getAttribute("data-read-state")).toBe("ready");
  await expect.poll(() => workspace(page).innerText()).toContain(marker);
}
async function chooseTreatment(page: Page, sub: string) {
  const select = page.getByTestId("patient-treatment-section");
  if (await select.isVisible()) await select.selectOption(sub);
  else await page.getByTestId(`patient-subtab-${sub}`).click();
}
async function openAdjustment(page: Page) {
  await workspace(page).getByRole("button", { name: /سجّل شدّة وجلسة جديدة الآن/ }).click();
  await workspace(page).getByLabel("ما نُفّذ في الشدّة", { exact: true }).waitFor();
}
async function dirtyAdjustment(page: Page, text = DRAFT_A) {
  await openAdjustment(page);
  const view = workspace(page);
  await view.getByLabel("ما نُفّذ في الشدّة", { exact: true }).fill(text);
  await view.getByLabel("أسابيع حتى الشدّة القادمة", { exact: true }).fill("7");
  await view.getByLabel("السلك العلوي", { exact: true }).selectOption("012 NiTi");
  await view.getByLabel("السلك السفلي", { exact: true }).selectOption("014 NiTi");
  await view.getByLabel("اختيار صور", { exact: true }).setInputFiles({ name: "synthetic-ortho-navigation.png", mimeType: "image/png", buffer: PNG });
  await view.getByLabel("دور صور الجلسة", { exact: true }).selectOption("progress");
  await view.getByLabel("وجه الصورة", { exact: true }).selectOption("smile");
  await view.getByTestId("ortho-photo-queue-preview").waitFor();
  await expect.poll(() => view.getByRole("img", { name: "صورة الجلسة", exact: true })
    .evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  return snapshot(page);
}
async function snapshot(page: Page) {
  return {
    fields: await workspace(page).locator("input:not([type=file]),textarea,select").evaluateAll(elements => elements.map(element => ({
      label: element.getAttribute("aria-label"), value: (element as HTMLInputElement).value,
    }))),
    photos: await workspace(page).getByRole("img", { name: "صورة الجلسة", exact: true }).evaluateAll(images => images.map(image => ({
      source: image.getAttribute("src"), complete: (image as HTMLImageElement).complete,
      width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight,
    }))),
  };
}
async function retained(page: Page, url: string, historyLength: number, expected: Awaited<ReturnType<typeof snapshot>>) {
  await settle(page); expect(page.url()).toBe(url);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await selected(page, "patient-subtab-ortho");
  const select = page.getByTestId("patient-treatment-section");
  if (await select.isVisible()) expect(await select.inputValue()).toBe("ortho");
  expect(await snapshot(page)).toEqual(expected);
}
async function returnToFreshOrtho(page: Page, marker = MARKER_A) {
  await page.getByTestId("patient-tab-treatment").click();
  await chooseTreatment(page, "ortho"); await ready(page, marker);
  expect(await workspace(page).getByLabel("ما نُفّذ في الشدّة", { exact: true }).count()).toBe(0);
  expect(await workspace(page).getByRole("img", { name: "صورة الجلسة", exact: true }).count()).toBe(0);
  await openAdjustment(page);
  expect(await workspace(page).getByLabel("ما نُفّذ في الشدّة", { exact: true }).inputValue()).toBe("");
  expect(await workspace(page).getByLabel("أسابيع حتى الشدّة القادمة", { exact: true }).inputValue()).toBe("4");
  expect(await workspace(page).getByLabel("السلك العلوي", { exact: true }).inputValue()).toBe("014 NiTi");
  expect(await workspace(page).getByLabel("السلك السفلي", { exact: true }).inputValue()).toBe("012 NiTi");
  expect(await workspace(page).getByTestId("ortho-write-uncertain").count()).toBe(0);
}
async function capture(page: Page, width: number) {
  const field = workspace(page).getByLabel("ما نُفّذ في الشدّة", { exact: true });
  await field.scrollIntoViewIfNeeded(); await page.evaluate(async () => { await document.fonts.ready; });
  const geometry = await page.evaluate(() => ({ dir: document.documentElement.dir,
    viewportWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth, historyLength: history.length }));
  const artifact = `.settings-ui-artifacts/patient-ortho-navigation-${width}`;
  await writeFile(`${artifact}.json`, `${JSON.stringify({ url: page.url(), geometry, draft: await snapshot(page) }, null, 2)}\n`);
  await page.screenshot({ path: `${artifact}.png` });
  expect(geometry.dir).toBe("rtl"); expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
}

describe("Ortho leave guard on the real built RTL patient page", () => {
  it.each([1280, 390])("does not treat untouched adjustment defaults as dirty at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      await openAdjustment(f.page);
      await f.page.getByTestId("patient-tab-summary").click(); await selected(f.page, "patient-tab-summary");
      await returnToFreshOrtho(f.page);
      await chooseTreatment(f.page, "plans"); await selected(f.page, "patient-subtab-plans");
      expect(f.dialogs).toEqual([]); expect(f.writes).toEqual([]); expect(f.documents).toHaveLength(1);
    });
  });

  it.each([1280, 390])("becomes clean after reverting fields and removing every queued photo at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      await openAdjustment(f.page);
      const view = workspace(f.page), initial = await snapshot(f.page);
      const done = view.getByLabel("ما نُفّذ في الشدّة", { exact: true });
      const weeks = view.getByLabel("أسابيع حتى الشدّة القادمة", { exact: true });
      const upper = view.getByLabel("السلك العلوي", { exact: true });
      const lower = view.getByLabel("السلك السفلي", { exact: true });
      await done.fill(DRAFT_A); await weeks.fill("7");
      await upper.selectOption("012 NiTi"); await lower.selectOption("014 NiTi");
      await done.fill(""); await weeks.fill("4");
      await upper.selectOption("014 NiTi"); await lower.selectOption("012 NiTi");
      expect(await snapshot(f.page)).toEqual(initial);
      // Net-empty input is clean even though actual edits occurred earlier.
      await f.page.getByTestId("patient-tab-summary").click(); await selected(f.page, "patient-tab-summary");
      expect(f.dialogs).toEqual([]);
      await returnToFreshOrtho(f.page);
      const beforePhoto = await snapshot(f.page);
      await view.getByLabel("اختيار صور", { exact: true }).setInputFiles({
        name: "synthetic-ortho-removed.png", mimeType: "image/png", buffer: PNG,
      });
      await view.getByTestId("ortho-photo-queue-preview").waitFor();
      const photo = view.getByRole("img", { name: "صورة الجلسة", exact: true });
      expect(await photo.count()).toBe(1);
      await photo.locator("..").getByRole("button", { name: "حذف", exact: true }).click();
      expect(await photo.count()).toBe(0);
      expect(await view.getByTestId("ortho-photo-queue-preview").count()).toBe(0);
      expect(await snapshot(f.page)).toEqual(beforePhoto);
      await chooseTreatment(f.page, "plans"); await selected(f.page, "patient-subtab-plans");
      expect(f.dialogs).toEqual([]); expect(f.writes).toEqual([]); expect(f.documents).toHaveLength(1);
    });
  });

  it.each([1280, 390])("opens an untouched next-appointment form, goes Back and leaves without a dirty prompt at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      await openAdjustment(f.page);
      const view = workspace(f.page);
      await view.getByLabel("ما نُفّذ في الشدّة", { exact: true }).fill(DRAFT_A);
      const doneOn = await view.getByLabel("تاريخ الشدّة", { exact: true }).inputValue();
      expect(await view.getByRole("img", { name: "صورة الجلسة", exact: true }).count()).toBe(0);
      expect(await view.getByTestId("ortho-photo-queue-preview").count()).toBe(0);
      // NextAppointmentCard is reachable only from the adjustment success
      // callback. This response is synthetic and never forwarded to the server;
      // no queued files means there must not even be an attempted photo upload.
      f.arm(201); await view.getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).click();
      await expect.poll(() => f.writes.length).toBe(1);
      expect(f.writes[0].path).toBe(`/api/ortho/${CASE_A}`);
      expect(f.writes[0].body).toEqual({ doneOn, upperWire: "014 NiTi", lowerWire: "012 NiTi",
        elastics: "none", elasticNote: "", done: DRAFT_A, nextWeeks: 4 });
      await f.release();
      const book = view.getByRole("button", { name: "📅 حجز الموعد المقترح الآن", exact: true });
      await expect.poll(() => book.isEnabled()).toBe(true); await book.click();
      const date = view.getByLabel("تاريخ الجلسة القادمة", { exact: true });
      const time = view.getByLabel("وقت الجلسة القادمة", { exact: true });
      await date.waitFor();
      expect(await date.inputValue()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(await time.inputValue()).toBe("16:00");
      // Opening and closing presentation alone must not mark date/time dirty.
      await view.getByRole("button", { name: "رجوع", exact: true }).click();
      await book.waitFor(); expect(await date.count()).toBe(0);
      const before = f.page.url(), length = await f.page.evaluate(() => history.length);
      await f.page.getByTestId("patient-tab-summary").click(); await selected(f.page, "patient-tab-summary");
      expect(f.page.url()).not.toBe(before); expect(await f.page.evaluate(() => history.length)).toBe(length);
      expect(f.dialogs).toEqual([]);
      await returnToFreshOrtho(f.page);
      // The route guard would fail the suite on any appointments, document or
      // extra adjustment POST, even if it was attempted during cleanup.
      expect(f.writes.map(write => [write.path, write.status])).toEqual([[`/api/ortho/${CASE_A}`, 201]]);
      expect(f.documents).toHaveLength(1);
    });
  });

  it.each([1280, 390])("retains exact fields and queued photos on cancelled tab/subtab departure, then discards explicitly at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      const expected = await dirtyAdjustment(f.page), original = f.page.url(), length = await f.page.evaluate(() => history.length);
      expect(expected.photos).toHaveLength(1); expect(expected.photos[0].source).toMatch(/^blob:/);
      for (const action of [() => f.page.getByTestId("patient-tab-summary").click(),
        () => f.page.getByTestId("patient-tab-files").click(), () => chooseTreatment(f.page, "plans")]) {
        await f.prompt(false, action); await retained(f.page, original, length, expected);
      }
      await capture(f.page, width);
      await f.prompt(true, () => f.page.getByTestId("patient-tab-summary").click());
      await selected(f.page, "patient-tab-summary");
      expect(await f.page.evaluate(() => history.length)).toBe(length);
      await returnToFreshOrtho(f.page);
      // A newly registered child guard must still work after the old child has
      // cleaned up; no retained prior form may suppress the new confirmation.
      await workspace(f.page).getByLabel("ما نُفّذ في الشدّة", { exact: true }).fill(DRAFT_B);
      await f.prompt(false, () => chooseTreatment(f.page, "plans"));
      expect(await workspace(f.page).getByLabel("ما نُفّذ في الشدّة", { exact: true }).inputValue()).toBe(DRAFT_B);
      expect(f.writes).toEqual([]); expect(f.documents).toHaveLength(1);
    });
  });

  it.each([1280, 390])("blocks departure without a prompt during POST and preserves the rejected draft at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      const expected = await dirtyAdjustment(f.page), original = f.page.url(), length = await f.page.evaluate(() => history.length);
      f.arm(409); await workspace(f.page).getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).click();
      await expect.poll(() => f.writes.length).toBe(1);
      expect(f.writes[0].body).toMatchObject({ done: DRAFT_A, upperWire: "012 NiTi", lowerWire: "014 NiTi", nextWeeks: 7 });
      for (const action of [() => f.page.getByTestId("patient-tab-summary").click(), () => chooseTreatment(f.page, "plans")]) {
        await action(); await retained(f.page, original, length, expected); expect(f.dialogs).toEqual([]);
      }
      await f.release(); await retained(f.page, original, length, expected);
      expect(f.dialogs).toEqual([]); expect(f.writes).toHaveLength(1);
      await f.prompt(false, () => f.page.getByTestId("patient-tab-summary").click());
      await retained(f.page, original, length, expected);
      await f.prompt(true, () => f.page.getByTestId("patient-tab-summary").click());
      await selected(f.page, "patient-tab-summary"); await returnToFreshOrtho(f.page);
      expect(f.writes).toHaveLength(1); expect(f.documents).toHaveLength(1);
    });
  });

  it.each([1280, 390])("uses a distinct uncertain-outcome prompt and never replays the frozen request at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      const expected = await dirtyAdjustment(f.page), original = f.page.url(), length = await f.page.evaluate(() => history.length);
      f.arm(500); await workspace(f.page).getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).click();
      await expect.poll(() => f.writes.length).toBe(1); await f.release();
      expect(await workspace(f.page).getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).isDisabled()).toBe(true);
      await f.prompt(false, () => chooseTreatment(f.page, "plans"), UNCERTAIN);
      await retained(f.page, original, length, expected);
      const before = f.reads.get(h.seeded.patientAId) ?? 0;
      await workspace(f.page).getByRole("button", { name: "تحديث كابينة التقويم", exact: true }).click();
      await expect.poll(() => f.reads.get(h.seeded.patientAId) ?? 0).toBeGreaterThan(before); await ready(f.page);
      await f.page.getByTestId("ortho-write-uncertain").waitFor();
      await retained(f.page, original, length, expected); expect(f.writes).toHaveLength(1);
      await f.prompt(false, () => f.page.getByTestId("patient-tab-summary").click(), UNCERTAIN);
      await retained(f.page, original, length, expected);
      await f.prompt(true, () => f.page.getByTestId("patient-tab-summary").click(), UNCERTAIN);
      await selected(f.page, "patient-tab-summary"); await returnToFreshOrtho(f.page);
      expect(f.writes).toHaveLength(1); expect(f.documents).toHaveLength(1);
    });
  });

  it.each([1280, 390])("retires A on genuine patient routing and keeps B's current guard functional at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      await dirtyAdjustment(f.page);
      // This is a real authenticated document navigation, not pushState,
      // injected anchors, React internals, URL-only replacement or a synthetic
      // patient owner. The guard is intentionally scoped to canonical tabs.
      const response = await f.page.goto(entry(h.seeded.patientBId), { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200); await ready(f.page, MARKER_B);
      expect(new URL(f.page.url()).pathname).toBe(`/patients/${h.seeded.patientBId}`);
      expect(await workspace(f.page).innerText()).not.toContain(MARKER_A);
      expect(await workspace(f.page).getByLabel("ما نُفّذ في الشدّة", { exact: true }).count()).toBe(0);
      expect(await workspace(f.page).getByRole("img", { name: "صورة الجلسة", exact: true }).count()).toBe(0);
      expect(f.dialogs).toEqual([]);
      const expectedB = await dirtyAdjustment(f.page, DRAFT_B), originalB = f.page.url(), lengthB = await f.page.evaluate(() => history.length);
      await f.prompt(false, () => f.page.getByTestId("patient-tab-summary").click());
      await retained(f.page, originalB, lengthB, expectedB);
      await f.prompt(true, () => f.page.getByTestId("patient-tab-summary").click());
      await selected(f.page, "patient-tab-summary"); await returnToFreshOrtho(f.page, MARKER_B);
      const returned = await f.page.goto(entry(), { waitUntil: "domcontentloaded" });
      expect(returned?.status()).toBe(200); await ready(f.page, MARKER_A);
      expect(await workspace(f.page).getByLabel("ما نُفّذ في الشدّة", { exact: true }).count()).toBe(0);
      expect(await workspace(f.page).getByRole("img", { name: "صورة الجلسة", exact: true }).count()).toBe(0);
      expect(f.dialogs).toEqual([DISCARD, DISCARD]); expect(f.writes).toEqual([]); expect(f.documents).toHaveLength(3);
    });
  });
});
