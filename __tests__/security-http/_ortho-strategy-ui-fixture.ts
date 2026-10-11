import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "vitest";
import type { Browser, Dialog, Locator, Page, Route } from "playwright";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { baseUrl, harness } from "./_server";
import { emptyStrategy, STRATEGY_IDS, type StrategyOwner } from "../fixtures/ortho-strategy";
import { strategyClinicalContext } from "../fixtures/strategy-clinical-context";

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
  const contextReads: Array<{ patientId: number; search: string; status: number }> = [];
  let contextFault: "wrong_patient" | "wrong_case" | null = null;
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
    const contextOwner = (["a", "b"] as const).find(one => path === `/api/patients/${patientIds[one]}/clinical-context`);
    if (method === "GET" && contextOwner) {
      const id = patientIds[contextOwner], ids = STRATEGY_IDS[contextOwner];
      const current = strategy.get(`/api/ortho/${ids.orthoCaseId}/strategy`)?.body as { clinicalCaseId?: unknown } | undefined;
      expect(current?.clinicalCaseId === null || current?.clinicalCaseId === ids.clinicalCaseId).toBe(true);
      const result = strategyClinicalContext(id, contextOwner, url.searchParams, current!.clinicalCaseId as number | null);
      const status = result.ok ? 200 : 409;
      contextReads.push({ patientId: id, search: url.search, status });
      if (!result.ok) { await json(route, result, status); return; }
      const fault = contextFault; contextFault = null;
      const other = contextOwner === "a" ? "b" : "a";
      await json(route, fault ? { ...result, context: { ...result.context,
        ...(fault === "wrong_patient" ? { patientId: patientIds[other] }
          : { orthoCaseId: STRATEGY_IDS[other].orthoCaseId, clinicalCaseId: STRATEGY_IDS[other].clinicalCaseId }),
      } } : result);
      return;
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
    expect(contextFault).toBeNull();
  };
  return { page, context, writes, reads, dialogs, documents, patientIds, contextReads,
    armContextFault: (fault: "wrong_patient" | "wrong_case") => { expect(contextFault).toBeNull(); contextFault = fault; },
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
// Browser-side measurement: fixed/sticky shell bars reduce the usable viewport.
// Nine inset samples cover the center, edges and rounded corners; they are hit
// witnesses, not a claim that every pixel or every native-select option fits.
export function orthoViewportProof(node: Element) {
  const rect = node.getBoundingClientRect();
  const obstructions = Array.from(document.querySelectorAll("body *")).flatMap(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    if (!["fixed", "sticky"].includes(style.position) || style.visibility !== "visible"
      || style.display === "none" || Number(style.opacity) === 0 || box.width <= 0 || box.height <= 0
      || box.right <= rect.left || box.left >= rect.right || element.contains(node)) return [];
    const edge = style.top !== "auto" && box.top <= 1 && box.bottom > 0 && box.bottom < innerHeight ? "top"
      : style.bottom !== "auto" && box.bottom >= innerHeight - 1 && box.top > 0 && box.top < innerHeight ? "bottom" : null;
    return edge ? [{ edge, tag: element.tagName, position: style.position,
      left: box.left, right: box.right, top: box.top, bottom: box.bottom }] : [];
  });
  const top = Math.max(0, ...obstructions.filter(one => one.edge === "top").map(one => one.bottom));
  const bottom = Math.min(innerHeight, ...obstructions.filter(one => one.edge === "bottom").map(one => one.top));
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const cornerX = Math.min(8, rect.width / 4), cornerY = Math.min(8, rect.height / 4);
  const edgeX = Math.min(2, rect.width / 4), edgeY = Math.min(2, rect.height / 4);
  const points = [
    { name: "center", x: cx, y: cy },
    { name: "top-edge", x: cx, y: rect.top + edgeY },
    { name: "right-edge", x: rect.right - edgeX, y: cy },
    { name: "bottom-edge", x: cx, y: rect.bottom - edgeY },
    { name: "left-edge", x: rect.left + edgeX, y: cy },
    { name: "top-left", x: rect.left + cornerX, y: rect.top + cornerY },
    { name: "top-right", x: rect.right - cornerX, y: rect.top + cornerY },
    { name: "bottom-right", x: rect.right - cornerX, y: rect.bottom - cornerY },
    { name: "bottom-left", x: rect.left + cornerX, y: rect.bottom - cornerY },
  ];
  const hitPoints = points.map(point => ({ ...point, unobscured: node.contains(document.elementFromPoint(point.x, point.y)) }));
  return { tag: node.tagName, label: node.getAttribute("aria-label") ?? node.textContent?.trim(),
    x: rect.x, y: rect.y, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
    width: rect.width, height: rect.height, hitPoints, unobscured: hitPoints.every(point => point.unobscured),
    availableViewport: { top, bottom, height: bottom - top, obstructions },
    viewportWidth: innerWidth, viewportHeight: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollY,
    dir: document.documentElement.dir };
}
export function assertOrthoViewportBounds(proof: ReturnType<typeof orthoViewportProof>, width: number) {
  expect(proof.dir).toBe("rtl"); expect(proof.viewportWidth).toBe(width);
  expect(proof.width).toBeGreaterThan(0); expect(proof.height).toBeGreaterThan(0);
  expect(proof.availableViewport.height).toBeGreaterThan(0);
  expect(proof.left).toBeGreaterThanOrEqual(0); expect(proof.right).toBeLessThanOrEqual(proof.viewportWidth);
  expect(proof.top).toBeGreaterThanOrEqual(proof.availableViewport.top);
  expect(proof.bottom).toBeLessThanOrEqual(proof.availableViewport.bottom);
  expect(proof.hitPoints).toHaveLength(9);
  for (const point of proof.hitPoints) expect(point.unobscured, `${proof.tag}: ${point.name}`).toBe(true);
  expect(proof.unobscured).toBe(true); expect(proof.scrollWidth).toBeLessThanOrEqual(proof.viewportWidth + 1);
}
export async function revealOrthoControlByWheel(page: Page, control: Locator) {
  expect(await control.count()).toBe(1);
  const before = await control.evaluate(orthoViewportProof);
  expect(before.height).toBeGreaterThan(0);
  expect(before.height).toBeLessThanOrEqual(before.availableViewport.height);
  const y = (before.availableViewport.top + before.availableViewport.bottom) / 2;
  // Use the page-content gutter, checking the actual pointer target so a native
  // select/textarea cannot consume the wheel or silently change its own value.
  const pointer = await control.evaluate((node, y) => {
    const main = node.closest("main");
    const x = Math.max(2, Math.min(innerWidth - 2, (main?.getBoundingClientRect().left ?? 0) + 4));
    const target = document.elementFromPoint(x, y);
    return { x, y, targetTag: target?.tagName ?? null,
      nativeField: target?.closest("input,textarea,select")?.tagName ?? null };
  }, y);
  expect(pointer.targetTag).not.toBeNull(); expect(pointer.nativeField).toBeNull();
  const distance = before.top + before.height / 2 - y;
  const deltaY = Math.abs(distance) < 1 ? 2 : distance;
  await page.mouse.move(pointer.x, pointer.y); await page.mouse.wheel(0, deltaY);
  await settleStrategy(page);
  await expect.poll(async () => {
    const proof = await control.evaluate(orthoViewportProof);
    return proof.top >= proof.availableViewport.top && proof.bottom <= proof.availableViewport.bottom && proof.unobscured;
  }).toBe(true);
  await settleStrategy(page);
  const proof = await control.evaluate(orthoViewportProof);
  assertOrthoViewportBounds(proof, before.viewportWidth);
  return { ...proof, reachability: { method: "native-mouse-wheel", pointer, deltaY,
    beforeTop: before.top, beforeBottom: before.bottom, beforeScrollY: before.scrollY, afterScrollY: proof.scrollY } };
}
export async function assertStrategyControlBounds(page: Page, width: number, scene: string, controls: readonly Locator[]) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const geometry = [];
  const values = await strategyFieldSnapshot(page.locator("body"));
  for (const [index, control] of controls.entries()) {
    const proof = await revealOrthoControlByWheel(page, control);
    assertOrthoViewportBounds(proof, width);
    if (proof.tag === "BUTTON") expect(proof.height).toBeGreaterThanOrEqual(44);
    geometry.push({ index, ...proof });
  }
  expect(await strategyFieldSnapshot(page.locator("body"))).toEqual(values);
  await mkdir(".settings-ui-artifacts", { recursive: true });
  const prefix = `.settings-ui-artifacts/ortho-strategy-${scene}-${width}`;
  await page.evaluate(async () => { await document.fonts.ready; });
  await writeFile(`${prefix}.json`, `${JSON.stringify({ url: page.url(), geometry }, null, 2)}\n`);
  await page.screenshot({ path: `${prefix}.png`, fullPage: false });
}
