import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import type { EndoTreatmentView } from "../../lib/endodontics-db";
import type { AssessmentCase } from "../../lib/patient-workflow-cases";
import type { WorkflowSummary } from "../../components/patient/SummaryTab";
import { crownState, endoNextAction, summarizeEndo } from "../../lib/endodontics";
import { toothName } from "../../lib/dental";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { baseUrl, harness } from "./_server";

// Source-prepared acceptance for the REAL built patient/Endo composition.
// No React/hook mocks, fixture component, application test seam, DB client or
// browser mutation is used. Existing isolated harness identities authenticate
// canonical GETs. The harness seeds no Endo episode, so this one typed Endo GET
// fixture uses the same pure projections as endodontics-db.loadViews. The
// workflow GET keeps its actual patient envelope, with a controlled open visit
// and assessment projections/failures. Shared seeded visits can be signed by
// other tests, so this read-only UI fixture does not depend on their state.
// No fixture record is persisted, and this is not an authorization-bypass test.
// This proves mounted DOM/draft/authority behavior, not clinical persistence.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
const TREATMENT = 959811, CASE = 959812, ASSESSMENT = 959813, VISIT = 959814;
const ACCEPTED_TITLE = "ENDO-WORKFLOW-ACCEPTED-CURRENT-PATIENT";
const FOREIGN_TITLE = "ENDO-WORKFLOW-FOREIGN-PATIENT-DO-NOT-RENDER";
const MALFORMED_TITLE = "ENDO-WORKFLOW-MALFORMED-DO-NOT-RENDER";
const REJECTED_PREFIX = "ENDO-WORKFLOW-PARTIAL-PROJECTION-DO-NOT-RENDER";
const forbiddenTitles = [FOREIGN_TITLE, MALFORMED_TITLE, REJECTED_PREFIX];
const modes = ["500", "malformed", "foreign-case"] as const;
type Mode = "accepted" | typeof modes[number];
type PendingRead = { mode: Mode; release: () => void };
const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status, contentType: "application/json", body: JSON.stringify(body),
});

function assessment(title = ACCEPTED_TITLE): AssessmentCase {
  return { id: ASSESSMENT, patientId: h.seeded.patientAId, kind: "specialty", orthoCaseId: null,
    specialty: "endodontics", title, needsAssessment: true };
}

function treatment(): EndoTreatmentView {
  const summary = summarizeEndo([], new Map());
  const crown = crownState({ status: "in_progress", crownRequired: null, restorative: "none" });
  return {
    id: TREATMENT, patientId: h.seeded.patientAId, caseId: CASE,
    caseTitle: "نوبة جذور اصطناعية لاختبار احتفاظ المسودة", toothCode: 36, toothName: toothName(36),
    kind: "initial", status: "in_progress", completedAt: null, outcome: null,
    restorativeStatus: "none", crownRequired: null, crownPlanItem: null, version: 1,
    createdBy: "synthetic-workflow-endo", createdAt: "2026-01-02T09:00:00.000Z",
    visits: [], summary, crown,
    nextAction: endoNextAction({ status: "in_progress", summary, restorative: "none", crown }),
  };
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function observeForbiddenTitles(page: Page) {
  await page.evaluate(titles => {
    const hits: string[] = [];
    const inspect = (text: string | null) => {
      for (const title of titles) if (text?.includes(title) && !hits.includes(title)) hits.push(title);
    };
    const observer = new MutationObserver(records => {
      inspect(document.body.textContent);
      for (const record of records) {
        inspect(record.oldValue);
        inspect(record.target.textContent);
        for (const node of [...record.addedNodes, ...record.removedNodes]) inspect(node.textContent);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
    inspect(document.body.textContent);
    Object.assign(window, { __workflowEndoTitleAudit: { hits, observer } });
  }, forbiddenTitles);
}

async function assertNoTitleLeak(page: Page) {
  await settle(page);
  const hits = await page.evaluate(() => {
    const audit = (window as Window & {
      __workflowEndoTitleAudit?: { hits: string[]; observer: MutationObserver };
    }).__workflowEndoTitleAudit;
    if (!audit) throw new Error("The workflow title audit was not installed.");
    return audit.hits;
  });
  expect(hits).toEqual([]);
  for (const title of forbiddenTitles) expect(await page.getByText(title, { exact: false }).count()).toBe(0);
}

async function fixture(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 1100 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.doctorA.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], mutations: string[] = [], errors: string[] = [], documents: string[] = [];
  const downloads: string[] = [];
  const reads = { patient: 0, workflow: 0, endo: 0, cases: 0 };
  const pending: PendingRead[] = [];
  const patientPath = `/api/patients/${h.seeded.patientAId}`;
  const workflowPath = `${patientPath}/workflow`;
  let armed: Mode | null = null;
  let workflow: Record<string, unknown> | null = null;
  let openVisitId: number | null = null;
  context.on("request", request => {
    if (request.isNavigationRequest() && request.resourceType() === "document") documents.push(request.url());
  });
  const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl) {
      unexpected.push(`${method} ${url.origin}${url.pathname}`); await route.abort(); return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      // Covers API and non-API writes, including save handlers accidentally
      // invoked from a control captured before authority was withdrawn.
      mutations.push(`${method} ${url.pathname}`); await route.abort(); return;
    }
    if (method === "GET" && url.pathname === workflowPath && url.search === "") {
      reads.workflow++;
      if (workflow === null) {
        const response = await route.fetch({ maxRedirects: 0 });
        expect(response.status()).toBe(200);
        const canonical = await response.json();
        expect(canonical.patient?.id).toBe(h.seeded.patientAId);
        expect(Array.isArray(canonical.assessmentCases)).toBe(true);
        // Type-bound synthetic visit reference. It is deliberately controlled
        // instead of assuming the globally seeded visit remains unsigned after
        // another HTTP suite. All mutations targeting this ID are blocked.
        const visit: NonNullable<WorkflowSummary["openVisit"]> = {
          id: VISIT, status: "in_chair", chair: 1,
          arrivedAt: "2026-01-02T10:00:00.000Z", plannedTitle: null,
        };
        openVisitId = visit.id;
        workflow = { ...canonical, openVisit: visit, assessmentCases: [assessment()] };
        await json(route, workflow); return;
      }
      if (armed === null) {
        unexpected.push("unarmed GET workflow refresh");
        await json(route, { message: "Unarmed workflow read blocked" }, 409); return;
      }
      const mode = armed; armed = null;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      pending.push({ mode, release });
      await gate;
      if (mode === "500") { await json(route, { message: "Synthetic workflow read failure" }, 500); return; }
      if (mode === "malformed") {
        await json(route, { ...workflow, assessmentCases: [assessment(REJECTED_PREFIX),
          { ...assessment(MALFORMED_TITLE), id: ASSESSMENT + 1, needsAssessment: false }] }); return;
      }
      if (mode === "foreign-case") {
        await json(route, { ...workflow, assessmentCases: [assessment(REJECTED_PREFIX),
          { ...assessment(FOREIGN_TITLE), id: ASSESSMENT + 1, patientId: h.seeded.patientBId }] }); return;
      }
      await json(route, workflow); return;
    }
    if (method === "GET" && url.pathname === `${patientPath}/endo` && url.search === "") {
      reads.endo++; await json(route, { treatments: [treatment()] }); return;
    }
    if (method === "GET" && url.pathname === patientPath && url.search === "") reads.patient++;
    if (method === "GET" && url.pathname === `${patientPath}/cases` && url.search === "") reads.cases++;
    await route.continue(); // Same-origin canonical GETs and built assets only.
  });
  const page = await context.newPage();
  context.on("page", () => unexpected.push("unexpected new page"));
  page.on("pageerror", error => errors.push(error.message));
  page.on("download", download => downloads.push(download.suggestedFilename()));
  page.on("dialog", async dialog => {
    unexpected.push(`unexpected ${dialog.type()} dialog`); await dialog.dismiss();
  });
  const entry = `${baseUrl}/patients/${h.seeded.patientAId}?tab=treatment&sub=endo&workflowDraftProbe=1`;
  let baselineReads: typeof reads;
  let baselineHistory: number;
  const assertContained = () => {
    expect(unexpected).toEqual([]); expect(mutations).toEqual([]); expect(errors).toEqual([]);
    expect(downloads).toEqual([]); expect(armed).toBeNull(); expect(pending).toEqual([]);
    expect(documents).toEqual([entry]);
  };
  const retainedShell = async () => {
    expect(page.url()).toBe(entry);
    expect(await page.evaluate(() => history.length)).toBe(baselineHistory);
    expect(documents).toEqual([entry]);
    expect(await page.getByTestId("patient-subtab-endo").getAttribute("aria-current")).toBe("page");
    expect(reads.patient).toBe(baselineReads.patient);
    expect(reads.endo).toBe(baselineReads.endo);
    expect(reads.cases).toBe(baselineReads.cases);
    expect(await page.getByTestId("endo-no-visit").count()).toBe(0);
    await assertNoTitleLeak(page);
  };
  return {
    page, reads, mutations, retainedShell,
    currentVisit: () => openVisitId,
    begin: async (mode: Mode, staleControl: "endo-save" | "endo-record" | null = null) => {
      expect(armed).toBeNull(); expect(pending).toEqual([]);
      const before = reads.workflow; armed = mode;
      if (mode === "accepted") {
        await page.getByTestId("patient-workflow-read-state")
          .getByRole("button", { name: "إعادة التحقق من الملخص", exact: true }).click();
      } else {
        // Focus is the production workflow-only refresh event. Triggering the
        // captured real DOM control in this SAME task also checks the current
        // authority predicate before React commits its disabled/hidden state.
        await page.evaluate(testId => {
          const control = testId ? document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`) : null;
          if (testId && !control) throw new Error(`Missing real Endo control: ${testId}`);
          window.dispatchEvent(new Event("focus"));
          control?.click();
        }, staleControl);
      }
      await expect.poll(() => reads.workflow).toBe(before + 1);
      await expect.poll(() => pending.length).toBe(1);
      await expect.poll(() => page.getByTestId("patient-workflow-read-state").innerText()).toContain("جارٍ التحقق");
      await settle(page);
    },
    finish: async () => {
      expect(pending).toHaveLength(1);
      const held = pending[0];
      const response = page.waitForResponse(one => one.request().method() === "GET"
        && new URL(one.url()).pathname === workflowPath);
      held.release();
      const delivered = await response;
      expect(delivered.status()).toBe(held.mode === "500" ? 500 : 200);
      expect(await delivered.finished()).toBeNull();
      pending.shift();
      if (held.mode === "accepted") {
        await expect.poll(() => page.getByTestId("patient-workflow-read-state").count()).toBe(0);
        await expect.poll(() => page.getByTestId("assessment-banner-endodontics").innerText()).toContain(ACCEPTED_TITLE);
      } else {
        await expect.poll(() => page.getByTestId("patient-workflow-read-state").innerText()).toContain("البيانات غير معروفة الآن");
        expect(await page.getByTestId("assessment-banner-endodontics").count()).toBe(0);
      }
      await settle(page);
    },
    run: (body: () => Promise<void>) => routes.run(async () => {
      try {
        const response = await page.goto(entry, { waitUntil: "domcontentloaded" });
        expect(response?.status()).toBe(200);
        await page.getByTestId("endo-record").waitFor();
        await expect.poll(() => page.getByTestId("assessment-banner-endodontics").innerText()).toContain(ACCEPTED_TITLE);
        await expect.poll(() => reads.cases).toBe(1);
        await expect.poll(() => page.getByTestId("endo-case-unavailable").count()).toBe(0);
        await settle(page);
        baselineReads = { ...reads };
        expect(baselineReads).toEqual({ patient: 1, workflow: 1, endo: 1, cases: 1 });
        baselineHistory = await page.evaluate(() => history.length);
        await observeForbiddenTitles(page);
        await body();
        expect(context.pages()).toHaveLength(1);
        assertContained();
      } finally {
        // Every held callback must be released before the shared guard drains;
        // containment stays installed until context.close, including failures.
        for (const held of pending) held.release();
      }
    }, assertContained),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expand(page: Page, testId: string) {
  const detail = page.getByTestId(testId);
  if (await detail.getAttribute("open") === null) await detail.locator(":scope > summary").click();
}

async function fillDraft(page: Page) {
  await page.getByTestId("endo-record").click();
  await page.getByTestId("endo-stage").selectOption("assessment");
  await page.getByTestId("endo-complaint").fill("مسودة شكوى جذور اصطناعية تبقى دون حفظ");
  await page.getByTestId("endo-pulpal").selectOption("pulp_necrosis");
  await page.getByTestId("endo-apical").selectOption("chronic_apical_abscess");
  await page.getByTestId("endo-note").fill("مسودة الجلسة: السطر الأول\nالسطر الثاني محفوظ في نفس المحرر");
  await page.getByTestId("endo-next-step").fill("مسودة متابعة اصطناعية");
  await expand(page, "endo-canal-editor");
  await page.getByTestId("endo-canal-wl-0").fill("20.5");
  await page.getByTestId("endo-canal-ref-0").selectOption("cusp_tip");
  await page.getByTestId("endo-canal-method-0").selectOption("both");
  await page.getByTestId("endo-canal-obt-0").check();
  await expand(page, "endo-canal-more-0");
  await page.getByTestId("endo-canal-note-0").fill("مسودة ملاحظة قناة اصطناعية");
}

async function draftValues(page: Page) {
  return page.getByTestId("endo-form").locator("input, textarea, select").evaluateAll(nodes => nodes.map(node => {
    const control = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    return { testId: control.getAttribute("data-testid"), tag: control.tagName,
      value: control.value, checked: control instanceof HTMLInputElement ? control.checked : null };
  }));
}

async function pinDraft(page: Page) {
  const ids = ["patient-endo", "endo-form", "endo-stage", "endo-complaint", "endo-note", "endo-canal-wl-0"];
  const handles = await Promise.all(ids.map(async id => {
    const handle = await page.getByTestId(id).elementHandle();
    if (!handle) throw new Error(`Missing mounted Endo node: ${id}`);
    return { id, handle };
  }));
  const values = await draftValues(page);
  return async () => {
    for (const { id, handle } of handles) {
      expect(await handle.evaluate(node => node.isConnected), `${id} must remain connected`).toBe(true);
      expect(await page.getByTestId(id).evaluate((node, original) => node === original, handle), `${id} must be the original DOM node`).toBe(true);
    }
    expect(await draftValues(page)).toEqual(values);
  };
}

async function unavailable(f: Fixture, hasDraft: boolean) {
  await f.retainedShell();
  expect(await f.page.getByTestId("assessment-banner-endodontics").count()).toBe(0);
  expect(await f.page.getByTestId("patient-primary-action").count()).toBe(0);
  expect(await f.page.getByTestId("endo-record").count()).toBe(0);
  if (hasDraft) {
    expect(await f.page.getByTestId("endo-save").isDisabled()).toBe(true);
    expect(await f.page.getByTestId("endo-form").innerText()).toContain("بقيت المسودة دون اعتماد سياق الزيارة");
  } else {
    expect(await f.page.getByTestId("endo-form").count()).toBe(0);
    expect(await f.page.getByRole("region", { name: "تسجيل الجلسة", exact: true }).innerText())
      .toContain("تعذّر التحقق من الزيارة المفتوحة");
  }
  expect(f.mutations).toEqual([]);
}

describe.runIf(process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true")(
  "workflow-only refresh retains the real mounted Endo draft without granting stale visit authority", () => {
    beforeAll(async () => {
      expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
      h = await harness();
      expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
      browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    }, 240_000);
    afterAll(async () => { await browser?.close(); });

    for (const width of [1280, 390]) for (const mode of modes) {
      it(`${width}px: ${mode} preserves dirty inputs and DOM through pending, rejected and recovered workflow reads`, async () => {
        const f = await fixture(width);
        await f.run(async () => {
          await fillDraft(f.page);
          const assertDraft = await pinDraft(f.page);
          const owner = f.currentVisit();
          expect(owner).toBe(VISIT);
          expect(await f.page.getByTestId("endo-strip").innerText()).toContain(`زيارة #${owner}`);
          expect(await f.page.getByTestId("endo-save").isEnabled()).toBe(true);

          await f.begin(mode, "endo-save");
          await unavailable(f, true); await assertDraft();
          await f.finish();
          await unavailable(f, true); await assertDraft();

          await f.begin("accepted");
          await unavailable(f, true); await assertDraft();
          await f.finish();
          await f.retainedShell(); await assertDraft();
          expect(f.currentVisit()).toBe(owner);
          expect(await f.page.getByTestId("endo-strip").innerText()).toContain(`زيارة #${owner}`);
          expect(await f.page.getByTestId("endo-save").isEnabled()).toBe(true);
          expect(await f.page.getByTestId("endo-form").innerText()).not.toContain("تغيّرت الزيارة المفتوحة");
          expect(f.reads.workflow).toBe(3); expect(f.mutations).toEqual([]);
        });
      });

      it(`${width}px: ${mode} withholds session start as unknown and restores it only after an accepted current read`, async () => {
        const f = await fixture(width);
        await f.run(async () => {
          const workspace = await f.page.getByTestId("patient-endo").elementHandle();
          if (!workspace) throw new Error("Missing real Endo workspace");
          expect(await f.page.getByTestId("endo-record").isEnabled()).toBe(true);
          await f.begin(mode, "endo-record");
          await unavailable(f, false);
          expect(await workspace.evaluate(node => node.isConnected)).toBe(true);
          await f.finish(); await unavailable(f, false);

          await f.begin("accepted"); await unavailable(f, false);
          await f.finish(); await f.retainedShell();
          expect(await f.page.getByTestId("patient-endo").evaluate((node, original) => node === original, workspace)).toBe(true);
          expect(await f.page.getByTestId("endo-record").isEnabled()).toBe(true);
          expect(await f.page.getByTestId("endo-form").count()).toBe(0);
          // Recovery requires new user intent; no old click is queued/replayed.
          await f.page.getByTestId("endo-record").click();
          expect(await f.page.getByTestId("endo-form").isVisible()).toBe(true);
          expect(await f.page.getByTestId("endo-note").inputValue()).toBe("");
          expect(await f.page.getByTestId("endo-save").isEnabled()).toBe(true);
          expect(f.reads.workflow).toBe(3); expect(f.mutations).toEqual([]);
        });
      });
    }
  },
);
