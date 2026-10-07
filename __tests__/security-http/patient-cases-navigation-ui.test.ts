import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Dialog, type Locator, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CasePlanItem, SpecialtyCase } from "../../lib/db";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { baseUrl, harness } from "./_server";

// Real built patient page, navigation, SessionProvider and CSS, using only the
// existing isolated security-harness identities. Cases and Ortho responses are
// synthetic. All browser writes are blocked except an explicitly armed,
// intercepted rejection or post-commit-like failure: none reach the server.
// This file adds no DB writer.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
const HISTORICAL = 959101, ACTIVE = 959102, BRIDGE = 959201, STANDALONE = 959202, ENDO = 959203;
const FIRST_ITEM = 959301, SECOND_ITEM = 959302;
const OPEN = "عرض قسم التقويم للمريض";
const DISCARD = "هناك عمل غير محفوظ في الحالات والمشاكل. هل تريد تجاهله؟";
const REJECTED = "رفض حفظ اصطناعي؛ لم تُغيّر بيانات المريض";
const UNCERTAIN_LEAVE = "نتيجة الحفظ غير مؤكدة؛ قد يكون الطلب نُفّذ. المغادرة لا تلغي الطلب ولا تعيد إرساله، وستُترك أي مسودة غير محفوظة. هل تريد مغادرة القسم؟";
const REVIEW = "إعادة تحميل الحالات للمراجعة";
const READ_UNAVAILABLE = "تعذّرت قراءة السجل الاصطناعي للمراجعة";
const HISTORICAL_TITLE = "حالة تقويم تاريخية اصطناعية مرتبطة";
const ACTIVE_TITLE = "حالة تقويم جارية اصطناعية بلا جسر";
const STANDALONE_TITLE = "تخصص تقويم مستقل بلا حالة تقويم";
const ENDO_TITLE = "حالة جذور اصطناعية قابلة للإغلاق";
const SERVICE = "علاج جذور اصطناعي";
const DRAFT = "مسودة اصطناعية يجب الاحتفاظ بها";
const WORKFLOW_ASSESSMENT = "حالة تقييم من ملخص المريض الحالي";
const WORKFLOW_LEGACY = "حالة تاريخية من ملخص المريض الحالي";
const entry = () => `${baseUrl}/patients/${h.seeded.patientAId}?tab=treatment&sub=cases&caseProbe=retained&orthoCaseId=959999&visitId=959998#record`;
const view = (page: Page) => page.getByTestId("patient-cases");
const shortcut = (page: Page, id = HISTORICAL) => page.getByTestId(`cases-open-ortho-${id}`);
const json = (route: Route, payload: unknown, status = 200) => route.fulfill({ status,
  contentType: "application/json", body: JSON.stringify(payload) });

beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); });

function casesPayload(planVisible: boolean) {
  const base: SpecialtyCase = {
    id: BRIDGE, kind: "specialty", orthoCaseId: HISTORICAL, patientId: h.seeded.patientAId,
    specialty: "orthodontics", title: HISTORICAL_TITLE, site: null, problem: "سجل تاريخي اصطناعي",
    responsiblePartyId: null, responsibleName: "طبيب اصطناعي", status: "completed", startedOn: "2023-01-01",
    completedAt: "2024-12-01T00:00:00.000Z", outcome: "اكتمل العلاج الاصطناعي", itemsTotal: 0,
    itemsDone: 0, createdBy: "synthetic-cases-navigation", waitingOn: [],
  };
  const cases: SpecialtyCase[] = [base,
    { ...base, id: null, kind: "ortho", orthoCaseId: ACTIVE, title: ACTIVE_TITLE,
      status: "active", startedOn: "2026-01-01", completedAt: null, outcome: null },
    { ...base, id: STANDALONE, orthoCaseId: null, title: STANDALONE_TITLE,
      status: "active", completedAt: null, outcome: null },
    { ...base, id: ENDO, orthoCaseId: null, specialty: "endodontics", title: ENDO_TITLE,
      status: "active", completedAt: null, outcome: null },
  ];
  const first: CasePlanItem = { id: FIRST_ITEM, planId: 959401, planTitle: "خطة اصطناعية",
    serviceName: SERVICE, category: "endodontics", toothCode: 36, status: "planned", doctorName: "طبيب اصطناعي",
    caseId: ENDO, priority: 1, sortOrder: 0 };
  return { cases, problems: [], dependencies: [], planVisible,
    items: planVisible ? [first, { ...first, id: SECOND_ITEM, serviceName: "تاج اصطناعي", priority: 2, sortOrder: 1 }] : [] };
}

function orthoPayload() {
  const active = { id: ACTIVE, patientId: h.seeded.patientAId, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: "SYNTHETIC-ACTIVE-CASE", status: "active", phase: "aligning", startDate: "2026-01-01", plannedMonths: 24,
    upperWire: "014 NiTi", lowerWire: "012 NiTi", planId: null, retainer: null, retainerOn: null, note: null,
    closedAt: null, closedBy: null, closedNote: null, baselineKind: null, baselineRecordedAt: null, elastics: "none",
    responsibleDoctorName: "طبيب اصطناعي", legacyFinancialMode: null, remainingObjectives: null, photosVisible: true,
    adjustments: [], progress: { monthsElapsed: 9, monthsPlanned: 24, monthsRemaining: 15,
      percent: 37.5, overdue: false, adjustments: 0, lastAdjustment: null, daysSinceLast: null } };
  // The newest active case deliberately comes first. The historical shortcut
  // must truthfully open this whole section, without promising exact selection.
  return { cases: [active, { ...active, id: HISTORICAL, bracketSystem: "SYNTHETIC-HISTORICAL-CASE",
    status: "completed", phase: "retention", startDate: "2023-01-01", closedAt: "2024-12-01T00:00:00.000Z",
    closedBy: "synthetic-cases-navigation", closedNote: "اكتمل العلاج الاصطناعي" }] };
}

type Write = { method: string; path: string; body: unknown; status: 409 | 500; release: () => void };
async function fixture(width: number, options: { role?: "doctorA" | "reception"; planVisible?: boolean; malformed?: boolean } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions[options.role ?? "doctorA"].cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [], downloads: string[] = [];
  const documents: string[] = [], writes: Write[] = [];
  let armed: { method: string; path: string; status: 409 | 500 } | null = null;
  let malformed = options.malformed ?? false;
  let caseReadFails = false, committedCase = false;
  const reads = { cases: 0, ortho: 0 };
  // Shared summary projections never own another /cases request.
  let destinationStarted = false;
  let pinnedCaseReads: number | null = null;
  const casePath = `/api/patients/${h.seeded.patientAId}/cases`;
  context.on("request", request => {
    if (request.isNavigationRequest() && request.resourceType() === "document") documents.push(request.url());
  });
  const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${url.pathname}`); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (armed?.method === method && armed.path === url.pathname && url.search === "") {
        const status = armed.status;
        armed = null;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        writes.push({ method, path: url.pathname, body: request.postDataJSON(), status, release });
        await gate;
        // An in-memory canonical row simulates a commit whose response failed;
        // no browser POST or fixture database mutation reaches the server.
        if (status === 500 && method === "POST" && url.pathname === casePath) committedCase = true;
        await json(route, { message: status === 500 ? "خطأ اصطناعي بعد كتابة محتملة" : REJECTED }, status); return;
      }
      unexpected.push(`${method} ${url.pathname}${url.search}`); await route.abort(); return;
    }
    if (method === "GET" && url.pathname === `/api/patients/${h.seeded.patientAId}/workflow` && url.search === "") {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const workflow = await response.json();
      await json(route, { ...workflow,
        assessmentCases: [{ id: 959205, patientId: h.seeded.patientAId, kind: "specialty", orthoCaseId: null,
          specialty: "orthodontics", title: WORKFLOW_ASSESSMENT, needsAssessment: true }],
        legacyCases: [{ id: 959206, patientId: h.seeded.patientAId, kind: "specialty", orthoCaseId: null,
          specialty: "orthodontics", title: WORKFLOW_LEGACY, site: null, status: "active", legacy: true }],
      }); return;
    }
    if (method === "GET" && url.pathname === casePath && url.search === "") {
      reads.cases++;
      if (caseReadFails) { await json(route, { message: READ_UNAVAILABLE }, 503); return; }
      const payload = casesPayload(options.planVisible !== false);
      if (committedCase) payload.cases.push({ ...payload.cases[3], id: 959204, title: DRAFT });
      if (malformed) payload.cases[0].patientId = h.seeded.patientBId;
      await json(route, payload); return;
    }
    if (method === "GET" && url.pathname === "/api/ortho" && url.searchParams.get("patientId") === String(h.seeded.patientAId)) {
      expect([...url.searchParams.entries()]).toEqual([["patientId", String(h.seeded.patientAId)]]);
      reads.ortho++; await json(route, orthoPayload()); return;
    }
    // The Ortho package child remains real but gets no unrelated financial data.
    if (method === "GET" && url.pathname === "/api/plans" && url.searchParams.get("patientId") === String(h.seeded.patientAId)) {
      await json(route, { plans: [] }); return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  context.on("page", () => unexpected.push("unexpected new page"));
  page.on("pageerror", error => errors.push(error.message));
  page.on("download", download => downloads.push(download.suggestedFilename()));
  const assertIsolated = () => {
    expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(downloads).toEqual([]); expect(armed).toBeNull();
    if (pinnedCaseReads !== null) {
      expect(reads.cases).toBe(pinnedCaseReads);
      expect(destinationStarted).toBe(true);
    }
  };
  return { page, context, writes, documents, reads, casePath,
    setMalformed: (next: boolean) => { malformed = next; },
    setCaseReadFailure: (next: boolean) => { caseReadFails = next; },
    beginOrthoBannerReads: () => { expect(destinationStarted).toBe(false); destinationStarted = true; },
    pinOrthoBannerReads: async (sourceReads: number) => {
      expect(destinationStarted).toBe(true);
      const assessment = page.getByTestId("assessment-banner-orthodontics");
      await assessment.waitFor({ timeout: 5_000 });
      expect(await assessment.innerText()).toContain(WORKFLOW_ASSESSMENT);
      const history = page.getByTestId("legacy-case-banner-orthodontics");
      expect(await history.count()).toBe(0);
      await settle(page);
      // Exact contract: destination banners use the workflow response, so zero
      // additional Cases GETs are allowed before or after retired controls run.
      expect(reads.cases).toBe(sourceReads);
      pinnedCaseReads = sourceReads;
      await settle(page); expect(reads.cases).toBe(sourceReads);
      return sourceReads;
    },
    arm: (method: string, path: string, status: 409 | 500 = 409) => { expect(armed).toBeNull(); armed = { method, path, status }; },
    release: async (index = 0) => {
      const write = writes[index]; expect(write).toBeDefined();
      const response = page.waitForResponse(one => one.request().method() === write.method && new URL(one.url()).pathname === write.path);
      write.release(); const delivered = await response;
      expect(delivered.status()).toBe(write.status); expect(await delivered.finished()).toBeNull();
      if (write.status === 500) await page.getByTestId("cases-write-uncertain").waitFor();
      else await view(page).getByRole("alert").filter({ hasText: REJECTED }).waitFor();
      await settle(page);
    },
    run: (body: () => Promise<void>) => routes.run(async () => {
      try {
        const response = await page.goto(entry(), { waitUntil: "domcontentloaded" });
        expect(response?.status()).toBe(200);
        await selected(page, "patient-subtab-cases");
        if (!malformed) await shortcut(page).waitFor();
        await body();
        expect(context.pages()).toHaveLength(1); assertIsolated();
      } finally {
        // Release every intercepted request before the shared guard drains and
        // closes the context, including when an earlier assertion has failed.
        for (const write of writes) write.release();
      }
    }, assertIsolated),
  };
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function selected(page: Page, testId: string) {
  await expect.poll(() => page.getByTestId(testId).getAttribute("aria-current")).toBe("page");
}
async function chooseTreatment(page: Page, sub: string) {
  const selector = page.getByTestId("patient-treatment-section");
  if (await selector.isVisible()) await selector.selectOption(sub);
  else await page.getByTestId(`patient-subtab-${sub}`).click();
}
async function withDiscard(page: Page, accept: boolean, action: () => Promise<unknown>, expected = DISCARD) {
  const messages: string[] = [];
  const handler = async (dialog: Dialog) => { messages.push(dialog.message()); await (accept ? dialog.accept() : dialog.dismiss()); };
  page.on("dialog", handler);
  try { await action(); await expect.poll(() => messages.length).toBe(1); await settle(page); }
  finally { page.off("dialog", handler); }
  expect(messages).toEqual([expected]);
}
async function retained(page: Page, url: string, length: number) {
  expect(page.url()).toBe(url); expect(await page.evaluate(() => history.length)).toBe(length);
  await selected(page, "patient-subtab-cases");
  if (await page.getByTestId("patient-treatment-section").isVisible()) {
    expect(await page.getByTestId("patient-treatment-section").inputValue()).toBe("cases");
  }
}
async function opened(page: Page, original: string, length: number) {
  await selected(page, "patient-subtab-ortho");
  const expected = new URL(original); expected.searchParams.set("tab", "treatment"); expected.searchParams.set("sub", "ortho");
  expect(page.url()).toBe(expected.href); expect(await page.evaluate(() => history.length)).toBe(length);
  const ortho = page.getByTestId("patient-ortho-workspace");
  await expect.poll(() => ortho.getAttribute("data-read-state")).toBe("ready");
  await expect.poll(() => ortho.innerText()).toContain("SYNTHETIC-ACTIVE-CASE");
  expect(await ortho.innerText()).toContain("SYNTHETIC-HISTORICAL-CASE");
  expect(await ortho.getByLabel("ما نُفّذ في الشدّة", { exact: true }).count()).toBe(0);
}

async function capture(page: Page, width: number) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const controls = [];
  for (const id of [HISTORICAL, ACTIVE]) {
    const control = shortcut(page, id);
    await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
    await control.focus(); await settle(page);
    controls.push(await control.evaluate(element => {
      const rect = element.getBoundingClientRect(), row = element.closest("li")!.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(element);
      const points = [[rect.left + rect.width / 2, rect.top + 3], [rect.left + rect.width / 2, rect.bottom - 3],
        [rect.left + 3, rect.top + rect.height / 2], [rect.right - 3, rect.top + rect.height / 2],
        [rect.left + rect.width / 2, rect.top + rect.height / 2]];
      return { testId: element.getAttribute("data-testid"), label: element.textContent?.trim(),
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
        row: { left: row.left, right: row.right, top: row.top, bottom: row.bottom },
        text: Array.from(range.getClientRects()).map(box => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom })),
        viewportWidth: innerWidth, viewportHeight: innerHeight, scrollY,
        noOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
        focused: document.activeElement === element,
        hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit !== null && (hit === element || element.contains(hit)); }) };
    }));
  }
  await shortcut(page).evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await shortcut(page).focus(); await settle(page);
  const path = `.settings-ui-artifacts/patient-cases-navigation-${width}`;
  // Preserve actual native viewport evidence before fatal geometry assertions.
  // Exactly two synthetic PNGs and two geometry JSON files; no traces or state.
  await writeFile(`${path}-bounds.json`, `${JSON.stringify({ viewport: { width, height: width === 390 ? 844 : 1000 }, controls }, null, 2)}\n`);
  await page.screenshot({ path: `${path}.png`, fullPage: false });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  for (const control of controls) {
    expect(control.label).toBe(OPEN); expect(control.width).toBeGreaterThanOrEqual(44); expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.left).toBeGreaterThanOrEqual(0); expect(control.top).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(control.viewportWidth); expect(control.bottom).toBeLessThanOrEqual(control.viewportHeight);
    expect(control.left).toBeGreaterThanOrEqual(control.row.left); expect(control.right).toBeLessThanOrEqual(control.row.right);
    expect(control.top).toBeGreaterThanOrEqual(control.row.top); expect(control.bottom).toBeLessThanOrEqual(control.row.bottom);
    expect(control.text.length).toBeGreaterThan(0);
    for (const box of control.text) {
      expect(box.left).toBeGreaterThanOrEqual(control.left - 1); expect(box.right).toBeLessThanOrEqual(control.right + 1);
      expect(box.top).toBeGreaterThanOrEqual(control.top - 1); expect(box.bottom).toBeLessThanOrEqual(control.bottom + 1);
    }
    expect(control.noOverflow).toBe(true); expect(control.focused).toBe(true); expect(control.hits).toEqual([true, true, true, true, true]);
  }
}

type DraftKind = "case" | "problem" | "closing" | "dependency";
async function draft(page: Page, kind: DraftKind): Promise<Locator> {
  if (kind === "case") {
    await view(page).getByRole("button", { name: "+ حالة جديدة", exact: true }).click();
    const field = view(page).getByLabel("العنوان", { exact: true }); await field.fill(DRAFT); return field;
  }
  if (kind === "problem") {
    await view(page).getByRole("button", { name: "+ مشكلة", exact: true }).click();
    const field = view(page).getByLabel("المشكلة", { exact: true }); await field.fill(DRAFT); return field;
  }
  if (kind === "closing") {
    const row = view(page).getByRole("region", { name: "الحالات التخصصية", exact: true }).locator("li").filter({ hasText: ENDO_TITLE });
    await row.getByRole("button", { name: "أُلغيت", exact: true }).click();
    const field = row.getByPlaceholder("سبب الإلغاء (مطلوب)", { exact: true }); await field.fill(DRAFT); return field;
  }
  const row = view(page).getByRole("region", { name: "ترتيب الخطة الشاملة", exact: true }).locator("li").filter({ hasText: SERVICE });
  await row.getByRole("button", { name: "+ يتطلب", exact: true }).click();
  const field = row.getByLabel("البند المطلوب قبله", { exact: true }); await field.selectOption(String(SECOND_ITEM)); return field;
}

describe("Cases to Ortho navigation on the real built RTL patient page", () => {
  it.each([1280, 390])("offers a truthful patient-section shortcut for both linked and unbridged cases at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      expect(await view(f.page).getByRole("button", { name: OPEN, exact: true }).count()).toBe(2);
      for (const title of [STANDALONE_TITLE, ENDO_TITLE]) {
        const row = view(f.page).getByRole("region", { name: "الحالات التخصصية", exact: true }).locator("li").filter({ hasText: title });
        expect(await row.count()).toBe(1); expect(await row.getByRole("button", { name: OPEN, exact: true }).count()).toBe(0);
      }
      expect(await shortcut(f.page).getAttribute("type")).toBe("button");
      expect(await shortcut(f.page).getAttribute("href")).toBeNull();
      await capture(f.page, width);
      const original = f.page.url(), length = await f.page.evaluate(() => history.length), documents = f.documents.length;
      // Keyboard activation of a historical row is section navigation, not a
      // new visit, bridge, plan, adjustment, or hidden exact-case selection.
      await shortcut(f.page).focus(); await f.page.keyboard.press("Enter");
      await opened(f.page, original, length); expect(f.documents).toHaveLength(documents);
      expect(f.writes).toEqual([]); expect(f.reads.ortho).toBeGreaterThan(0);
      await f.page.reload(); await opened(f.page, original, length);
      await chooseTreatment(f.page, "cases"); await shortcut(f.page, ACTIVE).waitFor();
      await shortcut(f.page, ACTIVE).click(); await opened(f.page, original, length);
      expect(f.writes).toEqual([]); expect(f.documents).toHaveLength(documents + 1);
    });
  });

  it.each([1280, 390])("preserves each Cases draft on cancelled shortcut, tab and specialty navigation at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      for (const kind of ["case", "problem", "closing", "dependency"] as const) {
        const field = await draft(f.page, kind), expected = await field.inputValue();
        const original = f.page.url(), length = await f.page.evaluate(() => history.length);
        for (const action of [() => shortcut(f.page).click(), () => f.page.getByTestId("patient-tab-account").click(),
          () => chooseTreatment(f.page, "ortho")]) {
          await withDiscard(f.page, false, action); await retained(f.page, original, length);
          expect(await field.inputValue()).toBe(expected); expect(f.writes).toEqual([]);
        }
        await withDiscard(f.page, true, () => shortcut(f.page).click()); await opened(f.page, original, length);
        await chooseTreatment(f.page, "cases"); await shortcut(f.page).waitFor();
        expect(await view(f.page).locator("textarea").count()).toBe(0);
      }
      expect(f.writes).toEqual([]); expect(f.documents).toHaveLength(1);
    });
  });

  it.each([1280, 390])("blocks navigation during a paused case save and retains the rejected draft at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      const field = await draft(f.page, "case");
      const original = f.page.url(), length = await f.page.evaluate(() => history.length);
      const prompts: string[] = [];
      const handler = async (dialog: Dialog) => { prompts.push(dialog.message()); await dialog.dismiss(); };
      f.page.on("dialog", handler);
      try {
        f.arm("POST", f.casePath); await view(f.page).getByRole("button", { name: "حفظ الحالة", exact: true }).click();
        await expect.poll(() => f.writes.length).toBe(1);
        expect(f.writes[0].body).toMatchObject({ title: DRAFT, specialty: "endodontics" });
        expect(await shortcut(f.page).isDisabled()).toBe(true);
        await f.page.getByTestId("patient-tab-summary").click(); await f.page.getByTestId("patient-tab-files").click();
        await chooseTreatment(f.page, "plans");
        await retained(f.page, original, length); expect(prompts).toEqual([]); expect(await field.inputValue()).toBe(DRAFT);
        await f.release(); await retained(f.page, original, length);
        expect(await field.inputValue()).toBe(DRAFT); expect(f.writes).toHaveLength(1); expect(prompts).toEqual([]);
      } finally { f.page.off("dialog", handler); }
      await withDiscard(f.page, false, () => shortcut(f.page).click()); await retained(f.page, original, length);
      await withDiscard(f.page, true, () => shortcut(f.page).click()); await opened(f.page, original, length);
      expect(f.documents).toHaveLength(1); expect(f.writes).toHaveLength(1);
    });
  });

  it.each([1280, 390])("latches the priority blur before a same-task navigation click and never queues that click at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      const priority = view(f.page).getByLabel(`أولوية ${SERVICE}`, { exact: true });
      const original = f.page.url(), length = await f.page.evaluate(() => history.length);
      const prompts: string[] = [];
      const handler = async (dialog: Dialog) => { prompts.push(dialog.message()); await dialog.dismiss(); };
      f.page.on("dialog", handler);
      try {
        await priority.fill("7"); f.arm("PUT", `/api/plan-items/${FIRST_ITEM}/case`);
        // Native blur followed by two native button activations in the same
        // task defeats a guard that only updates after React's busy render.
        await priority.evaluate((element, id) => {
          (element as HTMLInputElement).blur();
          (document.querySelector('[data-testid="patient-tab-summary"]') as HTMLButtonElement).click();
          (document.querySelector(`[data-testid="cases-open-ortho-${id}"]`) as HTMLButtonElement).click();
        }, HISTORICAL);
        await expect.poll(() => f.writes.length).toBe(1);
        expect(f.writes[0].body).toEqual({ caseId: ENDO, priority: "7" });
        await retained(f.page, original, length); expect(prompts).toEqual([]);
        await f.page.getByTestId("patient-tab-files").click(); await chooseTreatment(f.page, "ortho");
        await retained(f.page, original, length); expect(prompts).toEqual([]);
        await f.release(); await retained(f.page, original, length);
        expect(await priority.inputValue()).toBe("7"); expect(f.writes).toHaveLength(1); expect(prompts).toEqual([]);
      } finally { f.page.off("dialog", handler); }
      await withDiscard(f.page, false, () => shortcut(f.page).click()); await retained(f.page, original, length);
      expect(await priority.inputValue()).toBe("7");
      await withDiscard(f.page, true, () => shortcut(f.page).click()); await opened(f.page, original, length);
      expect(f.documents).toHaveLength(1); expect(f.writes).toHaveLength(1);
    });
  });

  for (const role of ["reception", "doctorA"] as const) {
    it.each([1280, 390])(`keeps the shortcut independent of ${role} write and plan visibility at %ipx`, async width => {
      const f = await fixture(width, { role, planVisible: false });
      await f.run(async () => {
        expect(await view(f.page).innerText()).toContain("عرض خطط العلاج غير مفعّل لحسابك.");
        expect(await view(f.page).getByRole("button", { name: OPEN, exact: true }).count()).toBe(2);
        expect(await view(f.page).getByLabel(`أولوية ${SERVICE}`, { exact: true }).count()).toBe(0);
        if (role === "reception") {
          expect(await view(f.page).locator("input,textarea,select").count()).toBe(0);
          expect((await view(f.page).getByRole("button").allTextContents()).map(text => text.trim())).toEqual([OPEN, OPEN]);
        } else expect(await view(f.page).getByRole("button", { name: "+ حالة جديدة", exact: true }).count()).toBe(1);
        const original = f.page.url(), length = await f.page.evaluate(() => history.length);
        await shortcut(f.page).click(); await opened(f.page, original, length);
        expect(f.writes).toEqual([]); expect(f.documents).toHaveLength(1);
      });
    });
  }

  it("withholds all row shortcuts after a cross-patient Cases response until a verified retry", async () => {
    const f = await fixture(390, { malformed: true });
    await f.run(async () => {
      const retry = f.page.getByRole("button", { name: "إعادة تحميل الحالات", exact: true }); await retry.waitFor();
      const retiredRetry = await retry.elementHandle(); expect(retiredRetry).not.toBeNull();
      expect(await f.page.getByRole("button", { name: OPEN, exact: true }).count()).toBe(0);
      expect(await view(f.page).count()).toBe(0);
      const original = f.page.url(), length = await f.page.evaluate(() => history.length);
      await retained(f.page, original, length); expect(f.reads.ortho).toBe(0); expect(f.writes).toEqual([]);
      f.setMalformed(false); await retry.click(); await shortcut(f.page).waitFor();
      // The malformed response and explicit verified retry are the only Cases
      // reads. Check this before entering a destination with its own readers.
      expect(f.reads.cases).toBe(2);
      f.beginOrthoBannerReads();
      await shortcut(f.page).click(); await opened(f.page, original, length);
      const settledReads = await f.pinOrthoBannerReads(2);
      await retiredRetry!.evaluate(element => (element as HTMLButtonElement).click()); await settle(f.page);
      expect(f.reads.cases).toBe(settledReads); expect(f.writes).toEqual([]); expect(f.documents).toHaveLength(1);
      await retiredRetry!.dispose();
    });
  });

  it.each([1280, 390])("fences a post-commit-like 500 until explicit review without retrying its frozen draft at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      expect(await f.page.locator("html").getAttribute("dir")).toBe("rtl");
      const field = await draft(f.page, "case");
      const save = view(f.page).getByRole("button", { name: "حفظ الحالة", exact: true });
      const cancel = view(f.page).getByRole("button", { name: "إلغاء", exact: true });
      const originalSave = await save.elementHandle(); expect(originalSave).not.toBeNull();
      const original = f.page.url(), length = await f.page.evaluate(() => history.length), initialReads = f.reads.cases;
      f.arm("POST", f.casePath, 500); await save.click();
      await expect.poll(() => f.writes.length).toBe(1);
      expect(f.writes[0].body).toMatchObject({ title: DRAFT, specialty: "endodontics" });
      await f.release();

      const notice = f.page.getByTestId("cases-write-uncertain");
      const review = notice.getByRole("button", { name: REVIEW, exact: true });
      const retiredReview = await review.elementHandle(); expect(retiredReview).not.toBeNull();
      expect(await notice.innerText()).toContain("قد يكون الطلب نُفّذ");
      expect(await notice.innerText()).toContain("لن يُعاد إرسال الطلب تلقائيًا");
      expect(await field.inputValue()).toBe(DRAFT); expect(await field.isDisabled()).toBe(true);
      expect(await save.isDisabled()).toBe(true); expect(await cancel.isDisabled()).toBe(true);
      expect(await view(f.page).getByRole("button", { name: "+ مشكلة", exact: true }).isDisabled()).toBe(true);
      expect(await view(f.page).getByRole("button", { name: "ربطها بالمشاكل وبنود الخطة", exact: true }).isDisabled()).toBe(true);
      expect(await view(f.page).getByLabel(`أولوية ${SERVICE}`, { exact: true }).isDisabled()).toBe(true);
      expect(await shortcut(f.page).count()).toBe(0);
      await retained(f.page, original, length);
      // Native activation of the retained save element must not resend. The
      // component suite separately covers captured React callback retirement.
      await originalSave!.evaluate(element => (element as HTMLButtonElement).click()); await settle(f.page);
      expect(f.writes).toHaveLength(1); expect(f.reads.cases).toBe(initialReads);

      f.setCaseReadFailure(true); await review.click();
      await view(f.page).getByRole("alert").filter({ hasText: READ_UNAVAILABLE }).waitFor();
      expect(f.reads.cases).toBe(initialReads + 1);
      expect(await field.inputValue()).toBe(DRAFT); expect(await save.isDisabled()).toBe(true);
      expect(await field.isDisabled()).toBe(true); expect(await cancel.isDisabled()).toBe(true);
      await withDiscard(f.page, false, () => f.page.getByTestId("patient-tab-summary").click(), UNCERTAIN_LEAVE);
      await retained(f.page, original, length); expect(f.writes).toHaveLength(1);

      f.setCaseReadFailure(false); await review.click();
      // A row in the refreshed synthetic record models a server commit before
      // the 500. It must not silently turn the old uncertain form into a retry.
      await view(f.page).getByRole("region", { name: "الحالات التخصصية", exact: true }).getByText(DRAFT, { exact: true }).waitFor();
      await shortcut(f.page).waitFor();
      expect(f.reads.cases).toBe(initialReads + 2);
      expect(await notice.innerText()).toContain("لا يعني ذلك تأكيد نتيجة الطلب السابق");
      expect(await field.inputValue()).toBe(DRAFT); expect(await field.isDisabled()).toBe(true);
      expect(await save.isDisabled()).toBe(true); expect(await cancel.isDisabled()).toBe(false);
      expect(await view(f.page).getByLabel(`أولوية ${SERVICE}`, { exact: true }).isDisabled()).toBe(false);
      await originalSave!.evaluate(element => (element as HTMLButtonElement).click()); await settle(f.page);
      expect(f.writes).toHaveLength(1); expect(f.reads.cases).toBe(initialReads + 2);
      await retained(f.page, original, length);

      await cancel.click(); await field.waitFor({ state: "hidden" });
      await view(f.page).getByRole("button", { name: "+ حالة جديدة", exact: true }).click();
      const fresh = view(f.page).getByLabel("العنوان", { exact: true });
      expect(await fresh.inputValue()).toBe(""); expect(await fresh.isEditable()).toBe(true);
      expect(await save.isDisabled()).toBe(true);
      await fresh.fill(`${DRAFT} — طلب جديد`); expect(await save.isDisabled()).toBe(false);
      expect(f.writes).toHaveLength(1);

      // A later failed read must not trap the user in the Cases workspace or
      // silently navigate. Deliberate departure retains the uncertainty warning.
      f.setCaseReadFailure(true); await review.click();
      await view(f.page).getByRole("alert").filter({ hasText: READ_UNAVAILABLE }).waitFor();
      expect(f.reads.cases).toBe(initialReads + 3); expect(await fresh.inputValue()).toBe(`${DRAFT} — طلب جديد`);
      await withDiscard(f.page, false, () => chooseTreatment(f.page, "ortho"), UNCERTAIN_LEAVE);
      await retained(f.page, original, length); expect(f.writes).toHaveLength(1);
      expect(f.reads.cases).toBe(initialReads + 3);
      f.beginOrthoBannerReads();
      await withDiscard(f.page, true, () => chooseTreatment(f.page, "ortho"), UNCERTAIN_LEAVE);
      await opened(f.page, original, length);
      const settledReads = await f.pinOrthoBannerReads(initialReads + 3);
      // Retained native controls cannot revive either an old write or a read.
      // Captured React callback retirement remains covered by the component suite.
      await originalSave!.evaluate(element => (element as HTMLButtonElement).click());
      await retiredReview!.evaluate(element => (element as HTMLButtonElement).click()); await settle(f.page);
      expect(f.writes).toHaveLength(1); expect(f.reads.cases).toBe(settledReads); expect(f.documents).toHaveLength(1);
      await originalSave!.dispose(); await retiredReview!.dispose();
    });
  });

  it.each([1280, 390])("requires a new priority edit after reviewing an unknown PUT instead of resending retained DOM text at %ipx", async width => {
    const f = await fixture(width);
    await f.run(async () => {
      expect(await f.page.locator("html").getAttribute("dir")).toBe("rtl");
      const priority = view(f.page).getByLabel(`أولوية ${SERVICE}`, { exact: true });
      const priorityPath = `/api/plan-items/${FIRST_ITEM}/case`;
      const original = f.page.url(), length = await f.page.evaluate(() => history.length), initialReads = f.reads.cases;
      expect(await priority.inputValue()).toBe("1");
      const prompts: string[] = [];
      const handler = async (dialog: Dialog) => { prompts.push(dialog.message()); await dialog.dismiss(); };
      f.page.on("dialog", handler);
      try {
        f.arm("PUT", priorityPath, 500); await priority.fill("7"); await f.page.keyboard.press("Tab");
        await expect.poll(() => f.writes.length).toBe(1);
        expect(f.writes[0].body).toEqual({ caseId: ENDO, priority: "7" });
        await f.page.getByTestId("patient-tab-summary").click();
        await retained(f.page, original, length); expect(prompts).toEqual([]);
        await f.release();
        expect(await priority.inputValue()).toBe("7"); expect(await priority.isDisabled()).toBe(true);
        await retained(f.page, original, length); expect(prompts).toEqual([]);
        expect(f.writes).toHaveLength(1); expect(f.reads.cases).toBe(initialReads);
      } finally { f.page.off("dialog", handler); }

      const review = f.page.getByTestId("cases-write-uncertain").getByRole("button", { name: REVIEW, exact: true });
      const [response] = await Promise.all([
        f.page.waitForResponse(one => one.request().method() === "GET" && new URL(one.url()).pathname === f.casePath),
        review.click(),
      ]);
      expect(response.status()).toBe(200);
      const canonical = await response.json() as { items: CasePlanItem[] };
      expect(canonical.items.find(item => item.id === FIRST_ITEM)?.priority).toBe(1);
      await shortcut(f.page).waitFor(); await settle(f.page);
      expect(await priority.isDisabled()).toBe(false);
      // Native uncontrolled-input dirtiness intentionally survives the GET.
      // Prove the actual discrepancy; resetting the test value would hide it.
      expect(await priority.evaluate(element => ({ value: (element as HTMLInputElement).value,
        defaultValue: (element as HTMLInputElement).defaultValue }))).toEqual({ value: "7", defaultValue: "1" });
      expect(f.reads.cases).toBe(initialReads + 1); expect(f.writes).toHaveLength(1);
      await retained(f.page, original, length);

      // A fresh native focus/blur is not an edit. The first request's old
      // intent must not be queued or replayed after the canonical read.
      await priority.focus(); await f.page.keyboard.press("Tab"); await settle(f.page);
      expect(await priority.inputValue()).toBe("7"); expect(await priority.isDisabled()).toBe(false);
      expect(f.writes).toHaveLength(1); expect(f.reads.cases).toBe(initialReads + 1);
      await retained(f.page, original, length);

      // A real subsequent change is new intent in the current read generation.
      // Exactly this PUT is armed, and its 409 never reaches the database.
      f.arm("PUT", priorityPath); await priority.fill("8"); await f.page.keyboard.press("Tab");
      await expect.poll(() => f.writes.length).toBe(2);
      expect(f.writes.map(write => ({ method: write.method, path: write.path, body: write.body }))).toEqual([
        { method: "PUT", path: priorityPath, body: { caseId: ENDO, priority: "7" } },
        { method: "PUT", path: priorityPath, body: { caseId: ENDO, priority: "8" } },
      ]);
      await f.release(1); await retained(f.page, original, length);
      expect(await priority.inputValue()).toBe("8"); expect(await priority.isDisabled()).toBe(false);
      expect(f.writes).toHaveLength(2); expect(f.reads.cases).toBe(initialReads + 1);
      expect(f.documents).toHaveLength(1);
    });
  });
});
