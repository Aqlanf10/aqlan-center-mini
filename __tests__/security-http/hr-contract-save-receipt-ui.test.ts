import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page, type CDPSession } from "playwright";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { CONTRACT_SAVE_RECEIPT_TIMEOUT_MS } from "@/lib/hr-contract-save-receipt";
import { harness } from "./_server";
import { openHrJourneyServer } from "./_hr-isolated-server";

let h: Awaited<ReturnType<typeof harness>>;
let owned: Awaited<ReturnType<typeof openHrJourneyServer>>;
let browser: Browser;
beforeAll(async () => {
  h = await harness(); owned = await openHrJourneyServer(h);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { try { await browser?.close(); } finally { await owned?.close(); } });

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${owned.baseUrl}${path}`, { method,
    headers: { cookie: h.sessions.admin.cookie, origin: owned.baseUrl, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function staff(name: string): Promise<number> {
  const created = await api("POST", "/api/hr/staff", { fullName: name, jobTitle: "Synthetic receipt witness", department: "secretariat",
    hireDate: "2026-01-01", endDate: null, phone: null, note: null, workStatus: "active", contractKind: "salary",
    salaryAmountMinor: 10000, salaryCurrency: "YER", salaryPeriod: "monthly", salaryEffectiveOn: "2026-01-01" });
  expect(created.status).toBe(201); const id = Number(created.body.staff?.id ?? created.body.id);
  expect(Number.isSafeInteger(id) && id > 0).toBe(true); return id;
}
const owns = (url: string, path: string) => { const parsed = new URL(url); return parsed.origin === owned.baseUrl && parsed.pathname === path; };
const retainedClause = "بند اصطناعي: أجر 98.76 USD\nتبقى الشروط محفوظة حتى مراجعة نتيجة الحفظ.";
async function contractsTab(page: Page) {
  const tab = page.getByRole("tablist", { name: "أقسام الموارد البشرية", exact: true }).getByRole("tab", { name: "📄 العقود", exact: true });
  const [read] = await Promise.all([
    page.waitForResponse(response => owns(response.url(), "/api/hr/contracts") && response.request().method() === "GET"), tab.click(),
  ]);
  expect(read.status()).toBe(200); expect(Array.isArray(await read.json())).toBe(true);
  await expect.poll(() => tab.getAttribute("aria-selected")).toBe("true");
  const panel = page.getByRole("region", { name: "إدارة العقود", exact: true });
  expect(await panel.count()).toBe(1);
  await expect.poll(() => panel.getByText("جاري تحميل العقود...", { exact: true }).count()).toBe(0);
  return panel;
}
async function locked(form: Locator, title: string) {
  expect(await form.getByLabel("مسمى العقد", { exact: true }).inputValue()).toBe(title);
  expect(await form.getByLabel("الراتب الأساسي", { exact: true }).inputValue()).toBe("98.76");
  expect(await form.getByLabel("عملة الأجر", { exact: true }).inputValue()).toBe("USD");
  expect(await form.getByRole("textbox", { name: "شروط وبنود العقد", exact: true }).inputValue()).toBe(retainedClause);
  const controls = form.locator("input,select,textarea,fieldset button");
  expect(await controls.count()).toBeGreaterThan(10);
  expect(await controls.evaluateAll(nodes => nodes.every(node => node.matches(":disabled")))).toBe(true);
  expect(await form.locator("button[type='submit']").count()).toBe(1);
  expect(await form.locator("button[type='submit']").isDisabled()).toBe(true);
}
async function nativeReachable(page: Page, button: Locator, allowWheel = true) {
  expect(await button.count()).toBe(1);
  const observe = () => button.evaluate(element => {
    const r = element.getBoundingClientRect();
    const visual = window.visualViewport;
    let left = visual?.offsetLeft ?? 0, top = visual?.offsetTop ?? 0;
    let right = left + (visual?.width ?? innerWidth), bottom = top + (visual?.height ?? innerHeight);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, box.left + parent.clientLeft); right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, box.top + parent.clientTop); bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight); }
    }
    // Interior cross-points remain inside rounded button surfaces. Full-box
    // clipping is still checked independently; corners need not be hit targets.
    const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + r.width / 4, r.top + r.height / 2],
      [r.left + r.width * 3 / 4, r.top + r.height / 2], [r.left + r.width / 2, r.top + r.height / 4], [r.left + r.width / 2, r.top + r.height * 3 / 4]];
    const hits = points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && (hit === element || element.contains(hit))); });
    return { box: { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom },
      viewport: { width: innerWidth, height: innerHeight }, usable: { left, top, right, bottom }, hits,
      inside: r.width > 4 && r.height > 4 && r.left >= left && r.top >= top && r.right <= right && r.bottom <= bottom };
  });
  for (let attempt = 0; allowWheel && attempt < 12; attempt++) {
    const measured = await observe();
    if (measured.inside && measured.hits.every(Boolean)) return measured;
    const center = measured.box.y + measured.box.height / 2;
    const delta = center < measured.usable.top || (measured.inside && center < measured.viewport.height / 2) ? -500 : 500;
    await page.mouse.move(Math.max(20, Math.min(measured.viewport.width - 20, measured.box.x + measured.box.width / 2)), measured.viewport.height / 2);
    await page.mouse.wheel(0, delta);
    // Observe several identical animation frames after ordinary wheel input;
    // no DOM scrolling, forced click, or fixed delay can manufacture reachability.
    expect(await button.evaluate(element => new Promise<boolean>(resolve => {
      let previous = "", stable = 0, frames = 0;
      const frame = () => {
        const r = element.getBoundingClientRect(); const scrolls: number[] = [];
        for (let p = element.parentElement; p; p = p.parentElement) scrolls.push(p.scrollTop, p.scrollLeft);
        const current = JSON.stringify([r.x, r.y, r.width, r.height, ...scrolls]);
        stable = current === previous ? stable + 1 : 0; previous = current;
        if (stable >= 5) resolve(true); else if (++frames >= 40) resolve(false); else requestAnimationFrame(frame);
      }; requestAnimationFrame(frame);
    }))).toBe(true);
  }
  const final = await observe(); expect(final.inside).toBe(true); expect(final.hits).toEqual([true, true, true, true, true]);
  return final;
}
async function wholeFormFits(form: Locator) {
  const result = await form.evaluate(element => {
    const dialog = element.closest("dialog"); if (!dialog) throw new Error("Owned dialog is missing");
    const visual = window.visualViewport, left = visual?.offsetLeft ?? 0, right = left + (visual?.width ?? innerWidth);
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    const controls = [...element.querySelectorAll("input,select,textarea,button,fieldset,label,h3,p,div")].map(node => {
      const r = node.getBoundingClientRect();
      return { tag: node.tagName, left: r.left, right: r.right, width: r.width,
        fits: r.width > 0 && r.left >= rect.left && r.right <= rect.right && r.left >= left && r.right <= right };
    });
    return { box: { left: rect.left, right: rect.right, width: rect.width }, viewport: { left, right },
      background: style.backgroundColor, opacity: style.opacity, formClientWidth: element.clientWidth, formScrollWidth: element.scrollWidth,
      dialogClientWidth: dialog.clientWidth, dialogScrollWidth: dialog.scrollWidth, controls };
  });
  expect(result.background).toBe("rgb(255, 255, 255)"); expect(result.opacity).toBe("1");
  expect(result.box.width).toBeLessThanOrEqual(768);
  expect(result.box.left).toBeGreaterThanOrEqual(result.viewport.left);
  expect(result.box.right).toBeLessThanOrEqual(result.viewport.right);
  expect(result.formScrollWidth).toBeLessThanOrEqual(result.formClientWidth);
  expect(result.dialogScrollWidth).toBeLessThanOrEqual(result.dialogClientWidth);
  expect(result.controls.length).toBeGreaterThan(20);
  expect(result.controls.every(control => control.fits)).toBe(true);
  return result;
}

async function boundedCaptureObservation<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Bounded native capture observation timed out")), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Observational only: never changes viewport, scroll, styles or application state. */
async function captureFrame(page: Page, form: Locator, cdp: CDPSession, noClip = false) {
  await boundedCaptureObservation(page.evaluate(() => document.fonts.ready.then(() => undefined)));
  const observe = async () => ({
    dom: await boundedCaptureObservation(form.evaluate(element => {
      if (!(element instanceof HTMLFormElement)) throw new Error("Expected owned native form");
      const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const dialog = element.closest("dialog"); if (!dialog) throw new Error("Missing native dialog");
      const visual = window.visualViewport;
      const measured = (node: HTMLElement) => ({ rect: rect(node), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
        clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollLeft: node.scrollLeft, scrollTop: node.scrollTop,
        transform: getComputedStyle(node).transform, animationName: getComputedStyle(node).animationName });
      return { scrollX, scrollY, innerWidth, innerHeight, devicePixelRatio,
        visualViewport: visual ? { offsetLeft: visual.offsetLeft, offsetTop: visual.offsetTop, pageLeft: visual.pageLeft,
          pageTop: visual.pageTop, width: visual.width, height: visual.height, scale: visual.scale } : null,
        documentElement: measured(document.documentElement), body: measured(document.body), dialog: measured(dialog), panel: measured(element),
        horizontalOutliers: [...document.querySelectorAll("body *")].map(node => ({ tag: node.tagName, className: node.getAttribute("class")?.slice(0, 240) ?? "", box: rect(node) }))
          .filter(node => node.box.width > 0 && (node.box.x < 0 || node.box.right > innerWidth)).sort((a, b) => b.box.width - a.box.width).slice(0, 20) };
    })),
    cdp: await boundedCaptureObservation(cdp.send("Page.getLayoutMetrics")),
  });
  const before = await observe();
  // Preserve the original acceptance image with precisely its original options.
  const png = await page.screenshot({ fullPage: false });
  const after = await observe();
  const dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  let diagnostic: Buffer | undefined;
  let afterNoClip: Awaited<ReturnType<typeof observe>> | undefined;
  if (noClip) {
    const raw = await boundedCaptureObservation(cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }));
    diagnostic = Buffer.from(raw.data, "base64"); afterNoClip = await observe();
  }
  return { png, diagnostic, observation: { before, after, dimensions, ...(afterNoClip ? { afterNoClip } : {}) } };
}

function retain(id: string, frames: Record<"top" | "identity" | "bottom", Buffer>, width: number, facts: Record<string, unknown>, diagnostic?: Buffer) {
  const output = process.env.HR_UI_DIAGNOSTIC_DIR; if (!output) return;
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  mkdirSync(output, { recursive: true });
  const retainedFrames = Object.fromEntries(Object.entries(frames).map(([phase, png]) => {
    const filename = phase === "bottom" ? `${id}.png` : `${id}-${phase}.png`;
    writeFileSync(join(output, filename), png);
    return [phase, { png: filename, pngBytes: png.length, pngSha256: hash(png) }];
  }));
  const png = frames.bottom;
  const noClip = diagnostic ? { png: "diagnostic-contract-ack-lost-390-top-no-clip.png", pngBytes: diagnostic.length, pngSha256: hash(diagnostic),
    dimensions: { width: diagnostic.readUInt32BE(16), height: diagnostic.readUInt32BE(20) }, acceptance: false } : undefined;
  if (diagnostic && noClip) writeFileSync(join(output, noClip.png), diagnostic);
  writeFileSync(join(output, `${id}.json`), JSON.stringify({ format: "hr-contract-ack-native-v2", syntheticOnly: true, acceptance: false,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, checkout: process.env.GITHUB_SHA,
    sourceSha256: hash(readFileSync(join(process.cwd(), "__tests__/security-http/hr-contract-save-receipt-ui.test.ts"))),
    viewport: { width, height: 900 }, png: `${id}.png`, pngBytes: png.length, pngSha256: hash(png), frames: retainedFrames, ...facts,
    ...(noClip ? { diagnosticNoClip: noClip } : {}) }, null, 2));
}

/** A real HTTP body, deliberately left unfinished after successful headers.
 * The actual application mutation already committed through route.fetch(). This
 * loopback endpoint only delivers that acknowledgement and never writes to DB. */
async function unfinishedAcknowledgement() {
  let expectedBody: string | undefined, completeBody: Buffer | undefined;
  let response: ServerResponse | undefined;
  const facts = { requests: 0, requestBodyMatches: false, status: 0, bodyBytes: 0, completeBytes: 0,
    responseEnded: false, clientClosedWithoutEnd: false };
  let failure: unknown;
  const server = createServer((request, reply) => {
    // A rewritten browser request may preflight the loopback transport. It is
    // limited to the one original app origin and exact synthetic POST endpoint.
    reply.setHeader("access-control-allow-origin", owned.baseUrl);
    reply.setHeader("access-control-allow-credentials", "true");
    reply.setHeader("access-control-allow-methods", "POST");
    reply.setHeader("access-control-allow-headers", "content-type");
    if (request.url !== "/ack") { reply.writeHead(404); reply.end(); return; }
    if (request.method === "OPTIONS") { reply.writeHead(204); reply.end(); return; }
    if (request.method !== "POST" || expectedBody === undefined || !completeBody || facts.requests !== 0) {
      failure = new Error("Unexpected synthetic acknowledgement request"); reply.writeHead(409); reply.end(); return;
    }
    facts.requests++;
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body) > 16_384) { failure = new Error("Synthetic request exceeded bound"); request.destroy(); }
    });
    request.on("error", error => { failure ??= error; });
    request.on("end", () => {
      try {
        expect(body).toBe(expectedBody); facts.requestBodyMatches = true;
        response = reply; facts.status = 201; facts.completeBytes = completeBody!.length;
        const partial = completeBody!.subarray(0, Math.min(512, completeBody!.length - 1));
        expect(partial.length).toBeGreaterThan(0); expect(partial.length).toBeLessThan(facts.completeBytes);
        reply.writeHead(201, { "content-type": "application/json", "content-length": String(facts.completeBytes), "cache-control": "no-store" });
        reply.on("finish", () => { facts.responseEnded = true; });
        reply.on("close", () => { facts.clientClosedWithoutEnd = !reply.writableEnded; });
        reply.flushHeaders(); reply.write(partial); facts.bodyBytes = partial.length;
        // No end(), timer, or server-side socket closure. Only the application's
        // AbortController can retire this unfinished body before test cleanup.
      } catch (error) { failure = error; reply.destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing synthetic acknowledgement port");
  return {
    url: `http://127.0.0.1:${address.port}/ack`, facts,
    prepare(body: string, receipt: unknown) { expectedBody = body; completeBody = Buffer.from(JSON.stringify(receipt)); },
    failure: () => failure,
    async close() {
      response?.destroy();
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections(); await closed;
    },
  };
}

for (const width of [390, 1280]) for (const variant of ["lost", "truncated", "foreign-staff", "foreign-number", "foreign-patch-id", "foreign-patch-number", "hung-body"] as const) {
  it(`contract acknowledgement ${variant} preserves one committed intent through double click, close and tab reopen at ${width}px`, async () => {
    const title = `HR-ACK-${variant}-${width}`;
    const staffId = await staff(title), otherStaffId = await staff(`${title}-OTHER`);
    const updating = variant === "foreign-patch-id" || variant === "foreign-patch-number";
    const original = updating ? await api("POST", "/api/hr/contracts", { staffId, title: `${title}-ORIGINAL`, templateKind: "doctor_salary",
      compensationKind: "salary", startDate: "2026-01-01", endDate: null, probationEndDate: null, baseSalaryMinor: 5555,
      salaryCurrency: "USD", salaryPeriod: "monthly", commissionRatePercent: null, doctorPartyId: null,
      termsPayload: { clauses: [], hourlyRateMinor: null, workingHoursPerWeek: null } }) : null;
    if (original) expect(original.status).toBe(201);
    const mutationPath = updating ? `/api/hr/contracts/${original!.body.id}` : "/api/hr/contracts";
    const mutationMethod = updating ? "PATCH" : "POST";
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE" });
    const raw = h.sessions.admin.cookie.split(";")[0], split = raw.indexOf("=");
    await context.addCookies([{ name: raw.slice(0, split), value: raw.slice(split + 1), url: owned.baseUrl }]);
    const page = await context.newPage(); const sent: Record<string, unknown>[] = [];
    let stream: Awaited<ReturnType<typeof unfinishedAcknowledgement>> | undefined;
    const bodyWitness = { status: 0, bytes: 0, finished: false, aborted: false };
    let native: { frames: Record<"top" | "identity" | "bottom", Buffer>; facts: Record<string, unknown>; diagnostic?: Buffer } | undefined;
    let captureSession: CDPSession | undefined;
    let release!: () => void; const deliver = new Promise<void>(resolve => { release = resolve; });
    let delivered!: () => void; const deliveryComplete = new Promise<void>(resolve => { delivered = resolve; });
    let routeFailure: unknown;
    let resolveCommit!: (receipt: Record<string, unknown>) => void, rejectCommit!: (error: unknown) => void;
    const committed = new Promise<Record<string, unknown>>((resolve, reject) => { resolveCommit = resolve; rejectCommit = reject; });
    void committed.catch(() => undefined);
    try {
      if (process.env.HR_UI_DIAGNOSTIC_DIR) captureSession = await context.newCDPSession(page);
      if (variant === "hung-body") {
        stream = await unfinishedAcknowledgement();
        const cdp = await context.newCDPSession(page); await cdp.send("Network.enable");
        let mutationRequest = "";
        cdp.on("Network.responseReceived", event => {
          if ([`${owned.baseUrl}${mutationPath}`, stream!.url].includes(event.response.url) && event.response.status === 201) {
            mutationRequest = event.requestId; bodyWitness.status = event.response.status;
          }
        });
        cdp.on("Network.dataReceived", event => { if (event.requestId === mutationRequest) bodyWitness.bytes += event.dataLength; });
        cdp.on("Network.loadingFinished", event => { if (event.requestId === mutationRequest) bodyWitness.finished = true; });
        cdp.on("Network.loadingFailed", event => { if (event.requestId === mutationRequest) bodyWitness.aborted = Boolean(event.canceled); });
      }
      expect((await page.goto(`${owned.baseUrl}/hr`, { waitUntil: "domcontentloaded" }))?.status()).toBe(200);
      let panel = await contractsTab(page);
      if (updating) {
        await panel.locator("tbody tr").filter({ hasText: `${title}-ORIGINAL` }).getByRole("button", { name: "عرض وتعديل", exact: true }).click();
        await page.getByRole("button", { name: "استكمال / تعديل المسودة", exact: true }).click();
      } else await panel.getByRole("button", { name: /إنشاء عقد جديد/ }).click();
      const modal = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: updating ? "استكمال / تعديل المسودة" : "إنشاء عقد وظيفي جديد", exact: true }) });
      const form = modal.locator("form");
      if (!updating) {
        await form.getByRole("button", { name: "عقد طبيب (راتب)", exact: true }).click();
        await form.getByLabel("الموظف", { exact: true }).selectOption(String(staffId));
      }
      await form.getByLabel("مسمى العقد", { exact: true }).fill(title);
      await form.getByLabel("عملة الأجر", { exact: true }).selectOption("USD");
      await form.getByLabel("دورية الراتب", { exact: true }).selectOption("monthly");
      await form.getByLabel("الراتب الأساسي", { exact: true }).fill("98.76");
      await form.getByRole("textbox", { name: "شروط وبنود العقد", exact: true }).fill(retainedClause);
      page.on("request", request => { if (owns(request.url(), mutationPath) && request.method() === mutationMethod) sent.push(request.postDataJSON()); });
      await page.route(`${owned.baseUrl}${mutationPath}`, async route => {
        try {
          expect(route.request().method()).toBe(mutationMethod);
          const response = await route.fetch(); expect(response.status()).toBe(updating ? 200 : 201);
          const receipt = await response.json();
          expect(receipt).toMatchObject({ staffId, title, templateKind: "doctor_salary", compensationKind: "salary", baseSalaryMinor: 9876,
            salaryCurrency: "USD", salaryPeriod: "monthly", status: "draft" });
          expect(Number.isSafeInteger(receipt.id) && receipt.id > 0).toBe(true);
          expect(receipt.termsPayload.clauses).toEqual(retainedClause.split("\n"));
          if (updating) expect(receipt.id).toBe(original!.body.id);
          resolveCommit(receipt); await deliver;
          if (variant === "lost") await route.abort("connectionfailed");
          else if (variant === "truncated") await route.fulfill({ response, body: '{"id":', contentType: "application/json" });
          else if (variant === "foreign-patch-id") await route.fulfill({ response, json: { ...receipt, id: receipt.id + 1000000 } });
          else if (variant === "foreign-number" || variant === "foreign-patch-number") {
            const foreignNumber = String(receipt.contractNumber).replace(/-\d+$/, `-${String(receipt.id + 1000000).padStart(4, "0")}`);
            expect(foreignNumber).not.toBe(receipt.contractNumber);
            await route.fulfill({ response, json: { ...receipt, contractNumber: foreignNumber } });
          }
          else if (variant === "hung-body") {
            stream!.prepare(route.request().postData()!, receipt);
            await route.continue({ url: stream!.url });
          }
          else await route.fulfill({ response, json: { ...receipt, staffId: otherStaffId } });
        } catch (error) { routeFailure = error; rejectCommit(error); await route.abort().catch(() => undefined); } finally { delivered(); }
      }, { times: 1 });
      const initialFormGeometry = await wholeFormFits(form);
      const saveGeometry = await nativeReachable(page, form.getByRole("button", { name: "حفظ العقد", exact: true }));
      await form.getByRole("button", { name: "حفظ العقد", exact: true }).dblclick();
      const receipt = await committed;
      expect(sent).toHaveLength(1); await locked(form, title);
      expect(await modal.getByRole("button", { name: "إلغاء", exact: true }).isDisabled()).toBe(true);
      release(); await deliveryComplete; expect(routeFailure).toBeUndefined();
      if (stream) {
        // Prove headers AND native bytes arrived before the deadline. A missing
        // response or CORS failure cannot satisfy this body-hang regression.
        await expect.poll(() => bodyWitness.status, { timeout: 5_000 }).toBe(201);
        await expect.poll(() => bodyWitness.bytes, { timeout: 5_000 }).toBeGreaterThan(0);
        expect(bodyWitness.finished).toBe(false); expect(bodyWitness.aborted).toBe(false);
        expect(stream.facts.responseEnded).toBe(false); expect(stream.facts.clientClosedWithoutEnd).toBe(false);
        expect(await modal.getByRole("button", { name: "إلغاء", exact: true }).isDisabled()).toBe(true);
      }
      await expect.poll(() => panel.getByText(/^نتيجة حفظ العقد غير مؤكدة/).isVisible(), {
        timeout: stream ? CONTRACT_SAVE_RECEIPT_TIMEOUT_MS + 3_000 : 1_000,
      }).toBe(true);
      if (stream) {
        await expect.poll(() => bodyWitness.aborted).toBe(true);
        await expect.poll(() => stream!.facts.clientClosedWithoutEnd).toBe(true);
        expect(bodyWitness.finished).toBe(false); expect(stream.facts.responseEnded).toBe(false);
        expect(stream.facts.requests).toBe(1); expect(stream.facts.requestBodyMatches).toBe(true);
        expect(stream.facts.bodyBytes).toBeGreaterThan(0); expect(stream.facts.bodyBytes).toBeLessThan(stream.facts.completeBytes);
        expect(stream.failure()).toBeUndefined();
      }
      await locked(form, title);
      await modal.getByRole("button", { name: "إلغاء", exact: true }).click();
      await expect.poll(() => modal.count()).toBe(0);
      // A tab detach must not discard the parent-owned uncertain request.
      const tasks = page.getByRole("tablist", { name: "أقسام الموارد البشرية", exact: true }).getByRole("tab", { name: "✓ المهام", exact: true });
      await tasks.click(); await expect.poll(() => tasks.getAttribute("aria-selected")).toBe("true");
      expect(await page.getByRole("region", { name: "إدارة العقود", exact: true }).count()).toBe(0);
      panel = await contractsTab(page);
      await expect.poll(() => panel.getByText(/^نتيجة حفظ العقد غير مؤكدة/).isVisible()).toBe(true);
      await panel.getByRole("button", { name: /إنشاء عقد جديد/ }).click(); await locked(form, title);
      const wholeFormGeometry = await wholeFormFits(form);
      await nativeReachable(page, modal.getByRole("heading"));
      const uncertaintyGeometry = await nativeReachable(page, form.getByRole("alert"));
      expect(await form.getByRole("alert").innerText()).toContain("نتيجة حفظ العقد غير مؤكدة");
      const topGeometry = await nativeReachable(page, modal.getByRole("heading"), false);
      const topCapture = captureSession ? await captureFrame(page, form, captureSession, variant === "lost" && width === 390) : null;
      const identityGeometry = await nativeReachable(page, form.getByLabel("مسمى العقد", { exact: true }));
      expect(await form.getByLabel("مسمى العقد", { exact: true }).inputValue()).toBe(title);
      const staffGeometry = await nativeReachable(page, form.getByLabel("الموظف", { exact: true }), false);
      expect(await form.getByLabel("الموظف", { exact: true }).inputValue()).toBe(String(staffId));
      const identityCapture = captureSession ? await captureFrame(page, form, captureSession) : null;
      await nativeReachable(page, form.getByRole("textbox", { name: "شروط وبنود العقد", exact: true }));
      const retainedGeometry = await nativeReachable(page, form.locator("button[type='submit']"));
      const termsGeometry = await nativeReachable(page, form.getByRole("textbox", { name: "شروط وبنود العقد", exact: true }), false);
      const termsTextFits = await form.getByRole("textbox", { name: "شروط وبنود العقد", exact: true }).evaluate(node => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight);
      expect(termsTextFits).toBe(true);
      const bottomCapture = captureSession ? await captureFrame(page, form, captureSession) : null;
      await modal.getByRole("button", { name: "إلغاء", exact: true }).click();
      expect(await panel.getByRole("button", { name: "بدء طلب جديد بعد المراجعة", exact: true }).count()).toBe(0);
      const reviewGeometry = await nativeReachable(page, panel.getByRole("button", { name: "مراجعة قائمة العقود", exact: true }));
      const [review] = await Promise.all([
        page.waitForResponse(response => owns(response.url(), "/api/hr/contracts") && response.request().method() === "GET"),
        panel.getByRole("button", { name: "مراجعة قائمة العقود", exact: true }).click(),
      ]);
      expect(review.status()).toBe(200);
      expect(await review.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: receipt.id, title, staffId, baseSalaryMinor: 9876, salaryCurrency: "USD" })]));
      // Reviewing a GET is manual inspection only. It must not clear uncertainty.
      expect(await panel.getByText(/^نتيجة حفظ العقد غير مؤكدة/).isVisible()).toBe(true);
      let confirmation: { type: string; message: string } | undefined;
      page.once("dialog", async dialog => { confirmation = { type: dialog.type(), message: dialog.message() }; await dialog.accept(); });
      const newIntentGeometry = await nativeReachable(page, panel.getByRole("button", { name: "بدء طلب جديد بعد المراجعة", exact: true }));
      await panel.getByRole("button", { name: "بدء طلب جديد بعد المراجعة", exact: true }).click();
      expect(confirmation?.type).toBe("confirm");
      expect(confirmation?.message).toContain("قد يكون طلب الحفظ السابق قد نُفّذ");
      expect(confirmation?.message).toContain("قد ينشئ عقدًا مكررًا");
      await panel.getByRole("button", { name: /إنشاء عقد جديد/ }).click();
      const fresh = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "إنشاء عقد وظيفي جديد", exact: true }) });
      expect(await fresh.getByLabel("مسمى العقد", { exact: true }).inputValue()).toBe("");
      expect(await fresh.getByLabel("مسمى العقد", { exact: true }).isEnabled()).toBe(true);
      expect(sent).toHaveLength(1);
      const persisted = (await owned.db.query("SELECT id,staff_id,base_salary_minor::text AS amount,salary_currency,status FROM hr_contracts WHERE title=$1", [title])).rows;
      expect(persisted).toEqual([{ id: receipt.id, staff_id: staffId, amount: "9876", salary_currency: "USD", status: "draft" }]);
      expect((await owned.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='hr.contract.create' AND entity='hr_contract' AND entity_id=$1", [String(receipt.id)])).rows[0].n).toBe(1);
      if (updating) expect((await owned.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='hr.contract.update' AND entity='hr_contract' AND entity_id=$1", [String(receipt.id)])).rows[0].n).toBe(1);
      if (topCapture && identityCapture && bottomCapture) native = { frames: { top: topCapture.png, identity: identityCapture.png, bottom: bottomCapture.png }, diagnostic: topCapture.diagnostic,
        facts: { captureObservations: { top: topCapture.observation, identity: identityCapture.observation, bottom: bottomCapture.observation }, requests: sent.length, persistedRows: persisted.length,
        actualBackendReceiptVerified: true, acknowledgementCorruptedAfterCommit: variant, retainedAfterCloseAndTabDetach: true,
        manualReviewDidNotClaimSuccess: true, explicitNewIntentConfirmed: true,
        saveGeometry, retainedGeometry, reviewGeometry, newIntentGeometry, initialFormGeometry, wholeFormGeometry,
        topGeometry, uncertaintyGeometry, identityGeometry, staffGeometry, termsGeometry, termsTextFits, retainedClauseVerified: true,
        ...(stream ? { runtimeDeadlineMs: CONTRACT_SAVE_RECEIPT_TIMEOUT_MS, nativeBody: bodyWitness, streamingTransport: { ...stream.facts } } : {}) } };
      await fresh.getByRole("button", { name: "إلغاء", exact: true }).click();
    } finally { release(); try { await context.close(); } finally { await stream?.close(); } }
    if (native) retain(`contract-ack-${variant}-${width}`, native.frames, width, { ...native.facts, caseCompleted: true, contextClosed: true }, native.diagnostic);
  }, 60_000);
}
