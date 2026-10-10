import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "vitest";
import type { Browser, Dialog, Locator, Page, Route } from "playwright";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { baseUrl, harness } from "./_server";
import { emptyStrategy, STRATEGY_IDS, type StrategyOwner } from "../fixtures/ortho-strategy";

// Source-only fixture. Real page, session and navigation; synthetic data only.
// Every mutation must be explicitly armed once and is fulfilled in memory.
export type Harness = Awaited<ReturnType<typeof harness>>;
export type StrategyFixtureWrite = { path: string; method: string; body: unknown; status: number; release: () => void };
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status,
  contentType: "application/json", body: JSON.stringify(body) });
export const STRATEGY_DISCARD = "هناك عمل غير محفوظ في التقويم. هل تريد تجاهله ومغادرة القسم؟";
export const STRATEGY_UNCERTAIN = "نتيجة الحفظ غير مؤكدة؛ قد يكون الطلب نُفّذ. المغادرة لا تلغي الطلب ولا تعيد إرساله، وستُترك أي مسودة غير محفوظة. هل تريد مغادرة القسم؟";
export const orthoWorkspace = (page: Page) => page.getByTestId("patient-ortho-workspace");
export const patientEntry = (patientId: number) => `${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho&orthoStrategyProbe=retained#record`;

export function orthoCases(patientId: number, owner: StrategyOwner = "a", closed = false) {
  const ids = STRATEGY_IDS[owner];
  return { cases: [{ id: ids.orthoCaseId, patientId, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: `SYNTHETIC-STRATEGY-OWNER-${owner.toUpperCase()}`, status: closed ? "completed" : "active", phase: "working",
    startDate: "2026-01-01", plannedMonths: 24, upperWire: "014 NiTi", lowerWire: "012 NiTi", planId: null,
    retainer: null, retainerOn: null, note: null, closedAt: closed ? "2026-10-02T06:00:00.000Z" : null,
    closedBy: closed ? "طبيب اصطناعي" : null, closedNote: closed ? "إغلاق اصطناعي محفوظ" : null,
    baselineKind: null, baselineRecordedAt: null, elastics: null, responsibleDoctorName: "طبيب اصطناعي",
    legacyFinancialMode: null, remainingObjectives: null, photosVisible: false, adjustments: [],
    progress: { monthsElapsed: 9, monthsPlanned: 24, monthsRemaining: 15, percent: 37.5,
      overdue: false, adjustments: 0, lastAdjustment: null, daysSinceLast: null } }] };
}

export async function strategyFixture(browser: Browser, h: Harness, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 844 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [], downloads: string[] = [], documents: string[] = [], dialogs: string[] = [];
  const writes: StrategyFixtureWrite[] = [], reads: string[] = [];
  const strategy = new Map<string, { body: unknown; status: number }>();
  const closed = new Set<number>();
  let armed: { path: string; method: string; body: unknown; status: number } | null = null;
  let expectedDialog: { message: string; accept: boolean; seen: boolean } | null = null;
  const dialogWork = new Set<Promise<void>>(), releases = new Set<() => void>();
  const patientIds = { a: h.seeded.patientAId, b: h.seeded.patientBId };
  for (const owner of ["a", "b"] as const) strategy.set(`/api/ortho/${STRATEGY_IDS[owner].orthoCaseId}/strategy`, {
    body: emptyStrategy(patientIds[owner], owner), status: 200,
  });
  const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${path}`); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const permit = armed;
      if (!permit || method !== permit.method || path !== permit.path || url.search !== "") {
        unexpected.push(`${method} ${path}${url.search}`); await route.abort(); return;
      }
      armed = null;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; }); releases.add(release);
      writes.push({ path, method, body: request.postDataJSON(), status: permit.status, release });
      try { await held; await json(route, permit.body, permit.status); }
      finally { releases.delete(release); }
      return;
    }
    if (method === "GET" && /^\/api\/ortho\/\d+\/strategy$/.test(path)) {
      reads.push(`${path}${url.search}`);
      const reply = strategy.get(`${path}${url.search}`);
      if (!reply) { unexpected.push(`unconfigured strategy GET ${path}${url.search}`); await route.abort(); return; }
      await json(route, reply.body, reply.status); return;
    }
    const patientId = Number(url.searchParams.get("patientId"));
    const owner = patientId === patientIds.a ? "a" : patientId === patientIds.b ? "b" : null;
    if (method === "GET" && path === "/api/ortho" && owner) {
      expect([...url.searchParams.entries()]).toEqual([["patientId", String(patientId)]]);
      await json(route, orthoCases(patientId, owner, closed.has(patientId))); return;
    }
    if (method === "GET" && path === "/api/plans" && owner) { await json(route, { plans: [] }); return; }
    // All remaining read-only navigation/session/identity use real harness auth.
    await route.continue();
  });
  context.on("request", request => {
    if (request.isNavigationRequest() && request.resourceType() === "document") documents.push(request.url());
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
        unexpected.push(`unexpected ${dialog.type()} dialog: ${dialog.message()}`); await dialog.dismiss(); return;
      }
      allowed.seen = true; await (allowed.accept ? dialog.accept() : dialog.dismiss());
    })().catch(error => { errors.push(String(error)); });
    dialogWork.add(work); void work.finally(() => dialogWork.delete(work));
  });
  const assertIsolated = () => {
    expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(downloads).toEqual([]);
    expect(armed).toBeNull(); expect(expectedDialog).toBeNull();
  };
  return { page, context, writes, reads, dialogs, documents, patientIds,
    closeCase: (owner: StrategyOwner) => closed.add(patientIds[owner]),
    response: (body: unknown, owner: StrategyOwner = "a", revisionId?: number, status = 200) => {
      const path = `/api/ortho/${STRATEGY_IDS[owner].orthoCaseId}/strategy${revisionId === undefined ? "" : `?revisionId=${revisionId}`}`;
      strategy.set(path, { body, status });
    },
    arm: (path: string, body: unknown, status: number, method = "POST") => {
      expect(armed).toBeNull(); armed = { path, method, body, status };
    },
    release: async (index = 0) => {
      const write = writes[index]; expect(write).toBeDefined();
      const response = page.waitForResponse(one => one.request().method() === write.method && new URL(one.url()).pathname === write.path);
      write.release(); const result = await response;
      expect(result.status()).toBe(write.status); expect(await result.finished()).toBeNull(); await settleStrategy(page);
    },
    prompt: async (accept: boolean, action: () => Promise<unknown>, message = STRATEGY_DISCARD) => {
      expect(expectedDialog).toBeNull();
      const expected = { message, accept, seen: false }; expectedDialog = expected;
      const before = dialogs.length;
      try {
        await action(); await expect.poll(() => expected.seen).toBe(true);
        await Promise.all([...dialogWork]); await settleStrategy(page); expect(dialogs.slice(before)).toEqual([message]);
      } finally { expectedDialog = null; }
    },
    run: (body: () => Promise<void>) => routes.run(async () => {
      try {
        const result = await page.goto(patientEntry(patientIds.a), { waitUntil: "domcontentloaded" });
        expect(result?.status()).toBe(200); await readyOrtho(page, "a");
        await body(); await Promise.all([...dialogWork]);
        expect(context.pages()).toHaveLength(1); assertIsolated();
      } finally { for (const release of releases) release(); }
    }, assertIsolated),
  };
}
export async function settleStrategy(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
export async function selectedPatientSection(page: Page, testId: string) {
  await expect.poll(() => page.getByTestId(testId).getAttribute("aria-current")).toBe("page");
}
export async function readyOrtho(page: Page, owner: StrategyOwner) {
  await selectedPatientSection(page, "patient-subtab-ortho");
  await expect.poll(() => orthoWorkspace(page).getAttribute("data-read-state")).toBe("ready");
  await expect.poll(() => orthoWorkspace(page).innerText()).toContain(`SYNTHETIC-STRATEGY-OWNER-${owner.toUpperCase()}`);
}
export async function chooseStrategyTreatment(page: Page, sub: string) {
  const select = page.getByTestId("patient-treatment-section");
  if (await select.isVisible()) await select.selectOption(sub);
  else await page.getByTestId(`patient-subtab-${sub}`).click();
}
export async function strategyFieldSnapshot(view: Locator) {
  return view.locator("input:not([type=file]),textarea,select").evaluateAll(nodes => nodes.map(node => ({
    label: node.getAttribute("aria-label"), value: (node as HTMLInputElement).value,
    checked: node instanceof HTMLInputElement ? node.checked : undefined,
  })));
}
export async function assertStrategyControlBounds(page: Page, width: number, scene: string, controls: readonly Locator[]) {
  const geometry = [];
  for (const [index, control] of controls.entries()) {
    expect(await control.count()).toBe(1);
    await control.evaluate(node => node.scrollIntoView({ block: "center", inline: "nearest" }));
    await settleStrategy(page);
    const proof = await control.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { tag: node.tagName, label: node.getAttribute("aria-label") ?? node.textContent?.trim(),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        unobscured: node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
        viewportWidth: innerWidth, viewportHeight: innerHeight, scrollWidth: document.documentElement.scrollWidth,
        dir: document.documentElement.dir };
    });
    expect(proof.dir).toBe("rtl"); expect(proof.viewportWidth).toBe(width);
    expect(proof.width).toBeGreaterThan(0); expect(proof.height).toBeGreaterThan(0);
    expect(proof.x).toBeGreaterThanOrEqual(-1); expect(proof.x + proof.width).toBeLessThanOrEqual(proof.viewportWidth + 1);
    expect(proof.y).toBeGreaterThanOrEqual(0); expect(proof.y + proof.height).toBeLessThanOrEqual(proof.viewportHeight);
    expect(proof.unobscured).toBe(true); expect(proof.scrollWidth).toBeLessThanOrEqual(proof.viewportWidth + 1);
    geometry.push({ index, ...proof });
  }
  await mkdir(".settings-ui-artifacts", { recursive: true });
  const prefix = `.settings-ui-artifacts/ortho-strategy-${scene}-${width}`;
  await page.evaluate(async () => { await document.fonts.ready; });
  await writeFile(`${prefix}.json`, `${JSON.stringify({ url: page.url(), geometry }, null, 2)}\n`);
  await page.screenshot({ path: `${prefix}.png`, fullPage: false });
}
