import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrthoFixtureSnapshot } from "../fixtures/patient-ortho-real-react";
import { baseUrl, harness } from "./_server";

// Source-authored acceptance gate: run only in the isolated security HTTP job.
// No production route or dependency is introduced. Real React development
// StrictMode, SessionProvider, PatientOrtho and every PatientOrtho-local form
// run together. Only the six explicitly unrelated modules below are stubbed.
let browser: Browser; let script = "";
const fixturePath = "/__test_only_patient_ortho__/";
const scriptPath = `${fixturePath}fixture.js`;
const patientId = 939101; const caseId = 938101; const visitId = 937101;
const mutationPath = `/api/ortho/${caseId}`;
const photoPath = `/api/patients/${patientId}/documents`;
const stubs: Record<string, string> = {
  LegacyOnboardingChecklist: "export function LegacyOnboardingChecklist() { return <span data-stub='legacy-checklist' />; }",
  OrthoPackageLink: `import { useLayoutEffect } from 'react';
    export function OrthoPackageLink({onChanged}) {
      useLayoutEffect(() => { window.__patientOrthoFixture.registerChildRefresh(onChanged); }, [onChanged]);
      return <span data-stub='package-link' />;
    }`,
  PatientCeph: "export function PatientCeph() { return <span data-stub='ceph' />; }",
  PatientDiagnosis: "export function PatientDiagnosis() { return <span data-stub='diagnosis' />; }",
  WebCephRecordsGrid: "export function WebCephRecordsGrid() { return <span data-stub='records' />; }",
  SettingsProvider: "export const useClinicName = () => 'Synthetic clinic'; export const useSetting = () => '';",
};
const unrelatedChildren: Plugin = { name: "only-unrelated-ortho-children", setup(builder) {
  builder.onResolve({ filter: /^\.\/(LegacyOnboardingChecklist|OrthoPackageLink|PatientCeph|PatientDiagnosis|WebCephRecordsGrid|SettingsProvider)$/ }, (args) => {
    if (!/(?:^|\/)components\/PatientOrtho\.tsx$/.test(args.importer)) return undefined;
    return { path: args.path.slice(2), namespace: "ortho-unrelated-child" };
  });
  builder.onLoad({ filter: /.*/, namespace: "ortho-unrelated-child" }, (args) => ({
    contents: stubs[args.path], loader: "tsx", resolveDir: process.cwd(),
  }));
} };
beforeAll(async () => {
  const h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  const bundle = await build({ absWorkingDir: process.cwd(),
    entryPoints: ["__tests__/fixtures/patient-ortho-real-react.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json", metafile: true,
    define: { "process.env.NODE_ENV": JSON.stringify("development") }, plugins: [unrelatedChildren],
  });
  expect(bundle.outputFiles).toHaveLength(1);
  const inputs = Object.keys(bundle.metafile!.inputs);
  for (const real of ["components/PatientOrtho.tsx", "components/SessionProvider.tsx", "node_modules/react-dom/client.js"]) {
    expect(inputs.some((path) => path.endsWith(real))).toBe(true);
  }
  expect(inputs.some((path) => /(?:^|\/)lib\/db(?:\.|\/)|node_modules\/(?:next|pg|@electric-sql)\//.test(path))).toBe(false);
  expect(inputs.filter((path) => path.startsWith("ortho-unrelated-child:")).map((path) => path.split(":")[1]).sort())
    .toEqual(Object.keys(stubs).sort());
  script = bundle.outputFiles![0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

const snapshot = (page: Page): Promise<OrthoFixtureSnapshot> => page.evaluate(() => window.__patientOrthoFixture.snapshot());
const workspace = (page: Page) => page.locator('[data-testid="patient-ortho-workspace"]');
const panel = (page: Page) => page.locator("#fixture-ortho");
const refresh = (page: Page) => workspace(page).getByRole("button", { name: "تحديث كابينة التقويم", exact: true }).click();
const retry = (page: Page) => workspace(page).getByRole("button", { name: "إعادة تحميل كابينة التقويم", exact: true }).click();
async function state(page: Page, expected: string) {
  await expect.poll(() => workspace(page).getAttribute("data-read-state")).toBe(expected);
}
async function hidden(page: Page) {
  expect(await panel(page).locator("form,input,textarea,select,img,a[href]").count()).toBe(0);
  const html = await panel(page).innerHTML();
  for (const secret of ["accepted-case-a", "synthetic patient A", "700000001", "private-draft", "synthetic prior regimen"]) {
    expect(html).not.toContain(secret);
  }
  expect(await panel(page).locator('[data-stub]').count()).toBe(0);
}
async function pair(page: Page) {
  const rows = (await snapshot(page)).requests.filter((one) => one.method === "GET");
  const ortho = rows.filter((one) => one.path.startsWith("/api/ortho?")).at(-1);
  const patient = rows.filter((one) => /^\/api\/patients\/\d+$/.test(one.path)).at(-1);
  expect(ortho).toBeDefined(); expect(patient).toBeDefined();
  return { ortho: ortho!.id, patient: patient!.id };
}
async function grant(page: Page, options: { empty?: boolean; marker?: string; unsigned?: boolean } = {}, ids?: Awaited<ReturnType<typeof pair>>) {
  const selected = ids ?? await pair(page);
  await page.evaluate(({ selected, options }) => {
    const api = window.__patientOrthoFixture;
    api.respond(selected.ortho, options.empty ? { cases: [] } : api.caseBody(options.marker, options.unsigned));
    api.respond(selected.patient, api.patientBody());
  }, { selected, options });
  await state(page, "ready");
}
async function allow(page: Page, method: string, path: string, count = 1) {
  await page.evaluate(({ method, path, count }) => window.__patientOrthoFixture.allow(method, path, count), { method, path, count });
}
async function writes(page: Page) { return (await snapshot(page)).requests.filter((one) => one.method !== "GET"); }
async function latestWrite(page: Page, path: string) {
  await expect.poll(async () => (await writes(page)).filter((one) => one.path === path).length).toBeGreaterThan(0);
  return (await writes(page)).filter((one) => one.path === path).at(-1)!;
}
async function fields(page: Page) {
  return panel(page).locator("input:not([type=file]),textarea,select").evaluateAll((elements) => elements.map((element) => ({
    label: element.getAttribute("aria-label"), value: (element as HTMLInputElement).value,
  })));
}
async function submitTwice(form: Locator) {
  // Two genuine bubbling events in the same browser task exercise the ref
  // latch rather than allowing React's later disabled render to hide a race.
  await form.evaluate((element) => {
    element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function adjustment(page: Page) {
  await panel(page).getByRole("button", { name: /سجّل شدّة وجلسة جديدة الآن/ }).click();
  await panel(page).getByLabel("ما نُفّذ في الشدّة", { exact: true }).fill("private-draft adjustment");
  return panel(page).locator("form").filter({ has: page.getByLabel("ما نُفّذ في الشدّة", { exact: true }) });
}
async function addPhotos(page: Page, count = 1) {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZs8AAAAASUVORK5CYII=", "base64");
  await panel(page).getByLabel("اختيار صور", { exact: true }).setInputFiles(Array.from({ length: count }, (_, index) => ({
    name: `synthetic-private-draft-${index}.png`, mimeType: "image/png", buffer: png,
  })));
  await expect.poll(() => panel(page).locator('img[src^="blob:"]').count()).toBe(count);
}
async function captureCallback(target: Locator, key: string, prop: "onClick" | "onSubmit") {
  await target.evaluate((element, { key, prop }) => window.__patientOrthoFixture.captureHostCallback(key, element as HTMLElement, prop), { key, prop });
}
async function replayCallback(page: Page, key: string) {
  await page.evaluate((key) => window.__patientOrthoFixture.replayHostCallback(key), key);
}
async function prepareBooking(page: Page) {
  await grant(page); const form = await adjustment(page); await allow(page, "POST", mutationPath); await submitTwice(form);
  const saved = await latestWrite(page, mutationPath);
  await page.evaluate((id) => window.__patientOrthoFixture.respond(id, { id: 934101, visitId: null }), saved.id);
  await state(page, "loading"); await grant(page);
  await panel(page).getByRole("button", { name: /حجز الموعد المقترح الآن/ }).click();
  await panel(page).getByLabel("تاريخ الجلسة القادمة", { exact: true }).fill("2026-11-23");
  await panel(page).getByLabel("وقت الجلسة القادمة", { exact: true }).fill("17:45");
  return panel(page).locator("form").filter({ has: page.getByLabel("تاريخ الجلسة القادمة", { exact: true }) });
}
async function noSavedAppointment(page: Page) {
  const contents = await panel(page).innerHTML();
  for (const value of ["الجلسة القادمة المقترحة", "تم حجز الجلسة القادمة بنجاح", "2026-11-23", "17:45", "700000001"]) {
    expect(contents).not.toContain(value);
  }
  expect(await panel(page).getByLabel("تاريخ الجلسة القادمة", { exact: true }).count()).toBe(0);
  expect(await panel(page).getByLabel("وقت الجلسة القادمة", { exact: true }).count()).toBe(0);
  expect(await panel(page).locator('a[href*="wa.me"]').count()).toBe(0);
  expect(await panel(page).getByRole("button", { name: "انسخ الرسالة", exact: true }).count()).toBe(0);
}
async function ordinaryFailure(page: Page, key: "ortho" | "patient" = "ortho", kind: "http" | "network" | "json" = "http") {
  await refresh(page); await state(page, "loading"); await hidden(page);
  const ids = await pair(page);
  await page.evaluate(({ ids, key, kind }) => {
    const api = window.__patientOrthoFixture;
    const peer = key === "ortho" ? "patient" : "ortho";
    api.respond(ids[peer], peer === "ortho" ? api.caseBody() : api.patientBody());
    if (kind === "http") api.respond(ids[key], { message: "Synthetic ordinary failure" }, 503);
    else if (kind === "network") api.fail(ids[key]);
    else { api.headers(ids[key], 200); }
  }, { ids, key, kind });
  if (kind === "json") {
    await expect.poll(async () => (await snapshot(page)).requests.find((one) => one.id === ids[key])!.jsonCalls).toBe(1);
    await page.evaluate((id) => window.__patientOrthoFixture.badJSON(id), ids[key]);
  }
  await state(page, "error"); await hidden(page);
}
async function open() {
  const context = await browser.newContext({ locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const external: string[] = []; const errors: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== baseUrl || request.method() !== "GET") {
      external.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return;
    }
    if (url.pathname === fixturePath) await route.fulfill({ status: 200, contentType: "text/html", headers: {
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'none'; img-src blob:; style-src 'unsafe-inline'; base-uri 'none'",
    }, body: `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Synthetic PatientOrtho acceptance</title></head><body><div id="root"></div><script src="${scriptPath}"></script></body></html>` });
    else if (url.pathname === scriptPath) await route.fulfill({ status: 200, contentType: "text/javascript", body: script });
    else if (url.pathname === "/favicon.ico") await route.fulfill({ status: 204, body: "" });
    else { external.push(`${request.method()} ${url.pathname}`); await route.abort(); }
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-10-04T06:00:00Z") });
  try {
    await page.goto(`${baseUrl}${fixturePath}`, { waitUntil: "domcontentloaded" });
    await page.locator("#toggle-probe").waitFor();
    await expect.poll(async () => (await snapshot(page)).requests.length).toBeGreaterThanOrEqual(4);
    await state(page, "loading"); await hidden(page);
    return { page, context, assertIsolated: async () => {
      expect((await snapshot(page)).unexpected).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
    } };
  } catch (error) { await context.close(); throw error; }
}

describe("PatientOrtho paired grants and opaque local drafts in real React", () => {
  it("replays StrictMode cleanup and fences an unmounted read and captured child refresh", async () => {
    const f = await open();
    try {
      const initial = await snapshot(f.page);
      expect(initial.setups).toBeGreaterThanOrEqual(2); expect(initial.cleanups).toBe(initial.setups - 1);
      expect(initial.requests.slice(0, 2).every((one) => one.aborted)).toBe(true);
      await grant(f.page); await f.page.evaluate(() => window.__patientOrthoFixture.captureChildRefresh());
      await refresh(f.page); const old = await pair(f.page);
      await f.page.evaluate((ids) => { for (const id of Object.values(ids)) window.__patientOrthoFixture.headers(id, 200); }, old);
      await expect.poll(async () => (await snapshot(f.page)).requests.filter((one) => Object.values(old).includes(one.id)).every((one) => one.jsonCalls === 1)).toBe(true);
      await f.page.locator("#toggle-probe").click();
      const retired = await snapshot(f.page);
      expect(retired.cleanups).toBe(retired.setups);
      expect(retired.requests.filter((one) => Object.values(old).includes(one.id)).every((one) => one.aborted)).toBe(true);
      await f.page.evaluate((ids) => {
        const api = window.__patientOrthoFixture; api.body(ids.ortho, api.caseBody()); api.body(ids.patient, api.patientBody()); api.capturedChildRefresh();
      }, old);
      expect(await panel(f.page).count()).toBe(0);
      expect((await snapshot(f.page)).requests).toHaveLength(retired.requests.length);
      await f.page.locator("#toggle-probe").click(); await state(f.page, "loading"); await hidden(f.page);
      await grant(f.page); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it.each([
    { key: "ortho" as const, status: 401 }, { key: "ortho" as const, status: 403 },
    { key: "patient" as const, status: 401 }, { key: "patient" as const, status: 403 },
  ])("$key $status headers retire both grants without waiting for JSON or peer headers", async ({ key, status }) => {
    const f = await open();
    try {
      await grant(f.page); await adjustment(f.page); await addPhotos(f.page);
      const previews = (await snapshot(f.page)).created;
      await refresh(f.page); const ids = await pair(f.page); const peer = key === "ortho" ? "patient" : "ortho";
      await f.page.evaluate(({ id, status }) => window.__patientOrthoFixture.headers(id, status), { id: ids[key], status });
      await state(f.page, "denied"); await hidden(f.page);
      const denied = await snapshot(f.page);
      expect(denied.requests.find((one) => one.id === ids[key])!.jsonCalls).toBe(0);
      expect(denied.requests.find((one) => one.id === ids[peer])!.jsonCalls).toBe(0);
      await f.page.evaluate(({ peerId, isOrtho }) => {
        const api = window.__patientOrthoFixture; api.respond(peerId, isOrtho ? api.caseBody() : api.patientBody());
      }, { peerId: ids[peer], isOrtho: peer === "ortho" });
      await state(f.page, "denied"); await hidden(f.page);
      expect((await snapshot(f.page)).requests.find((one) => one.id === ids[peer])!.jsonCalls).toBe(0);
      expect(await writes(f.page)).toHaveLength(0);
      // Denied same-owner contents are held only outside mounted DOM; a genuine
      // owner retirement is the point at which their owned blobs are discarded.
      await f.page.locator("#patient-b").click();
      await expect.poll(async () => (await snapshot(f.page)).revoked).toEqual(previews.map((one) => one.url));
      await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it.each(["ortho", "patient"] as const)("%s denial wins while successful peer JSON is stalled", async (key) => {
    const f = await open();
    try {
      await grant(f.page); await refresh(f.page); const ids = await pair(f.page); const peer = key === "ortho" ? "patient" : "ortho";
      await f.page.evaluate((id) => window.__patientOrthoFixture.headers(id, 200), ids[peer]);
      await expect.poll(async () => (await snapshot(f.page)).requests.find((one) => one.id === ids[peer])!.jsonCalls).toBe(1);
      await f.page.evaluate((id) => window.__patientOrthoFixture.headers(id, 403), ids[key]);
      await state(f.page, "denied"); await hidden(f.page);
      await f.page.evaluate(({ id, peer }) => {
        const api = window.__patientOrthoFixture; api.body(id, peer === "ortho" ? api.caseBody() : api.patientBody());
      }, { id: ids[peer], peer });
      await state(f.page, "denied"); await hidden(f.page); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it.each(["patient-aba", "principal-aba", "permission-aba", "role-aba"])("committed %s destroys old grants/drafts and makes old callbacks/results inert", async (control) => {
    const f = await open();
    try {
      await grant(f.page); await adjustment(f.page); await addPhotos(f.page);
      await f.page.evaluate(() => window.__patientOrthoFixture.captureChildRefresh());
      await refresh(f.page); const old = await pair(f.page);
      await f.page.evaluate((ids) => { for (const id of Object.values(ids)) window.__patientOrthoFixture.headers(id, 200); }, old);
      const before = await snapshot(f.page);
      await f.page.locator(`#${control}`).click(); await state(f.page, "loading"); await hidden(f.page);
      const changed = await snapshot(f.page); const transitions = changed.commits.slice(before.commits.length);
      expect(new Set(transitions.map((one) => one.owner)).size).toBeGreaterThanOrEqual(2);
      expect(transitions.every((one) => !one.html.includes("accepted-case-a") && !one.values.some((value) => value.includes("private-draft")))).toBe(true);
      expect(changed.revoked).toEqual(before.created.map((one) => one.url));
      const current = await pair(f.page); expect(current).not.toEqual(old);
      await f.page.evaluate(({ current, old }) => {
        const api = window.__patientOrthoFixture; api.headers(current.patient, 403);
        api.body(old.ortho, api.caseBody()); api.body(old.patient, api.patientBody()); api.capturedChildRefresh();
      }, { current, old });
      await state(f.page, "denied"); await hidden(f.page);
      expect((await snapshot(f.page)).requests).toHaveLength(changed.requests.length);
      await retry(f.page); await grant(f.page); await adjustment(f.page);
      // adjustment() intentionally sets a fresh value; no retired photo can return.
      expect(await panel(f.page).locator('img[src^="blob:"]').count()).toBe(0);
      expect(await writes(f.page)).toHaveLength(0); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("a retired denial cannot hide a newer clinical grant while its contact read is still pending", async () => {
    const f = await open();
    try {
      const old = await pair(f.page);
      await f.page.locator("#principal-aba").click(); const current = await pair(f.page);
      await f.page.evaluate((id) => { const api = window.__patientOrthoFixture; api.respond(id, api.caseBody()); }, current.ortho);
      await state(f.page, "ready"); expect(await panel(f.page).textContent()).toContain("accepted-case-a");
      await f.page.evaluate((id) => { const api = window.__patientOrthoFixture; api.respond(id, api.patientBody()); }, current.patient);
      await state(f.page, "ready");
      await f.page.evaluate((ids) => { for (const id of Object.values(ids)) window.__patientOrthoFixture.headers(id, 403); }, old);
      await state(f.page, "ready"); expect(await panel(f.page).textContent()).toContain("accepted-case-a");
      expect((await snapshot(f.page)).requests.filter((one) => Object.values(old).includes(one.id)).every((one) => one.jsonCalls === 0)).toBe(true);
      await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it.each([
    { key: "ortho" as const, kind: "http" as const },
    { key: "ortho" as const, kind: "network" as const },
    { key: "ortho" as const, kind: "json" as const },
  ])("restores the exact same-owner new-case draft after $key $kind failure", async ({ key, kind }) => {
    const f = await open();
    try {
      await grant(f.page, { empty: true }); await panel(f.page).getByRole("button", { name: "+ فتح حالة تقويم جديدة", exact: true }).click();
      await panel(f.page).getByLabel("نوع الجهاز", { exact: true }).selectOption("fixed_ceramic");
      await panel(f.page).getByLabel("الفكّان المعالَجان", { exact: true }).selectOption("upper");
      await panel(f.page).getByLabel("مقاس الشقّ", { exact: true }).selectOption("018");
      await panel(f.page).getByLabel("نظام البراكيت", { exact: true }).fill("private-draft bracket");
      await panel(f.page).getByLabel("تاريخ بدء التقويم", { exact: true }).fill("2026-09-12");
      await panel(f.page).getByLabel("المدة المتوقعة", { exact: true }).fill("27");
      const draft = await fields(f.page); const reads = (await snapshot(f.page)).requests.length;
      await f.page.locator("#display-name").click();
      expect(await fields(f.page)).toEqual(draft); expect((await snapshot(f.page)).requests).toHaveLength(reads);
      await ordinaryFailure(f.page, key, kind); await retry(f.page); await grant(f.page, { empty: true });
      expect(await fields(f.page)).toEqual(draft); expect(await writes(f.page)).toHaveLength(0); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("restores the complete baseline financial/regimen draft without creating historical records", async () => {
    const f = await open();
    try {
      await grant(f.page, { empty: true }); await panel(f.page).getByRole("button", { name: "تسجيل حالة سابقة (قبل النظام)", exact: true }).click();
      await panel(f.page).getByLabel("المرحلة الحالية", { exact: true }).selectOption("finishing");
      for (const [label, value] of [["السلك العلوي الحالي", "016 NiTi"], ["السلك السفلي الحالي", "012 NiTi"],
        ["الأشهر المنقضية", "9"], ["الأشهر المتبقية", "7"], ["المطاطات الحالية", "private-draft baseline regimen"],
        ["الأهداف المتبقية", "private-draft objectives"]]) await panel(f.page).getByLabel(label, { exact: true }).fill(value);
      await panel(f.page).getByLabel("النظام المالي السابق", { exact: true }).selectOption("prepaid_included");
      await panel(f.page).getByLabel("الطبيب المسؤول", { exact: true }).selectOption("935101");
      const draft = await fields(f.page);
      await ordinaryFailure(f.page); await retry(f.page); await grant(f.page, { empty: true });
      await expect.poll(() => fields(f.page)).toEqual(draft);
      expect(await writes(f.page)).toHaveLength(0);
      await allow(f.page, "POST", "/api/ortho/baseline"); await submitTwice(panel(f.page).locator("form"));
      const write = await latestWrite(f.page, "/api/ortho/baseline");
      expect(await writes(f.page)).toHaveLength(1);
      expect(write.submitted).toMatchObject({ patientId, phase: "finishing", upperWire: "016 NiTi", lowerWire: "012 NiTi",
        monthsElapsed: 9, monthsRemaining: 7, financialMode: "prepaid_included", responsibleDoctorId: 935101,
        elastics: "private-draft baseline regimen", remainingObjectives: "private-draft objectives" });
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, { message: "Synthetic rejection" }, 409), write.id);
      expect(await fields(f.page)).toEqual(draft); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("keeps adjustment wire/regimen defaults and exact File/blob identity through read failure and display rename", async () => {
    const f = await open();
    try {
      await grant(f.page); await adjustment(f.page);
      expect(await panel(f.page).getByLabel("السلك العلوي", { exact: true }).inputValue()).toBe("016 NiTi");
      expect(await panel(f.page).getByLabel("السلك السفلي", { exact: true }).inputValue()).toBe("012 NiTi");
      expect(await panel(f.page).getByLabel("صنف المطاطات", { exact: true }).inputValue()).toBe("class_ii");
      expect(await panel(f.page).getByLabel("وصف المطاطات", { exact: true }).inputValue()).toBe("synthetic prior regimen");
      expect(await panel(f.page).getByLabel("أسابيع حتى الشدّة القادمة", { exact: true }).inputValue()).toBe("6");
      await panel(f.page).getByLabel("وصف المطاطات", { exact: true }).fill("private-draft elastic note");
      await panel(f.page).getByLabel("أسابيع حتى الشدّة القادمة", { exact: true }).fill("5");
      await panel(f.page).getByLabel("تاريخ الشدّة", { exact: true }).fill("2026-10-03");
      await panel(f.page).getByLabel("دور صور الجلسة", { exact: true }).selectOption("progress");
      await addPhotos(f.page); await panel(f.page).getByLabel("وجه الصورة", { exact: true }).selectOption("intraoral_frontal");
      const draft = await fields(f.page); const prior = await snapshot(f.page);
      await f.page.locator("#display-name").click();
      expect(await fields(f.page)).toEqual(draft); expect((await snapshot(f.page)).requests).toHaveLength(prior.requests.length);
      await ordinaryFailure(f.page); expect((await snapshot(f.page)).revoked).toEqual([]);
      await retry(f.page); await grant(f.page); expect(await fields(f.page)).toEqual(draft);
      expect((await snapshot(f.page)).created).toEqual(prior.created);
      expect(await panel(f.page).locator('img[src^="blob:"]').getAttribute("src")).toBe(prior.created[0].url);
      await allow(f.page, "POST", mutationPath); await allow(f.page, "POST", photoPath);
      await submitTwice(panel(f.page).locator("form")); const write = await latestWrite(f.page, mutationPath);
      expect((await writes(f.page)).filter((one) => one.path === mutationPath)).toHaveLength(1);
      expect(write.submitted).toMatchObject({ upperWire: "016 NiTi", lowerWire: "012 NiTi", elastics: "class_ii",
        elasticNote: "private-draft elastic note", done: "private-draft adjustment", doneOn: "2026-10-03", nextWeeks: 5 });
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, { id: 934101, visitId: null }), write.id);
      const upload = await latestWrite(f.page, photoPath);
      const data = Object.fromEntries(upload.submitted as Array<[string, unknown]>);
      expect(data.file).toMatchObject({ fileId: prior.created[0].fileId, name: prior.created[0].name, size: prior.created[0].size });
      expect(data).toMatchObject({ orthoCaseId: String(caseId), adjustmentId: "934101", photoStage: "progress", photoView: "intraoral_frontal", takenOn: "2026-10-03" });
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, {}), upload.id);
      await expect.poll(async () => (await snapshot(f.page)).revoked).toEqual([prior.created[0].url]);
      await state(f.page, "loading"); await grant(f.page);
      await f.page.locator("#toggle-probe").click();
      expect((await snapshot(f.page)).revoked).toEqual([prior.created[0].url]); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("really remounts the next adjustment after save with authoritative prior regimen and blank current work", async () => {
    const f = await open();
    try {
      await grant(f.page); const form = await adjustment(f.page);
      const completedWork = "synthetic completed session work";
      const regimen = { upperWire: "014 NiTi", lowerWire: "016 NiTi", elastics: "class_iii",
        elasticNote: "synthetic updated prior regimen", nextWeeks: 8 };
      const savedAdjustmentId = 934102; const savedVisitId = 937102;
      await panel(f.page).getByLabel("السلك العلوي", { exact: true }).selectOption(regimen.upperWire);
      await panel(f.page).getByLabel("السلك السفلي", { exact: true }).selectOption(regimen.lowerWire);
      await panel(f.page).getByLabel("صنف المطاطات", { exact: true }).selectOption(regimen.elastics);
      await panel(f.page).getByLabel("وصف المطاطات", { exact: true }).fill(regimen.elasticNote);
      await panel(f.page).getByLabel("أسابيع حتى الشدّة القادمة", { exact: true }).fill(String(regimen.nextWeeks));
      await panel(f.page).getByLabel("ما نُفّذ في الشدّة", { exact: true }).fill(completedWork);
      const originalForm = await form.elementHandle(); expect(originalForm).not.toBeNull();
      await allow(f.page, "POST", mutationPath); await submitTwice(form);
      const command = await latestWrite(f.page, mutationPath);
      expect(command.submitted).toMatchObject({ ...regimen, done: completedWork, doneOn: "2026-10-04" });
      await f.page.evaluate(({ id, savedAdjustmentId, savedVisitId }) => {
        window.__patientOrthoFixture.respond(id, { id: savedAdjustmentId, visitId: savedVisitId });
      }, { id: command.id, savedAdjustmentId, savedVisitId });
      // Exercise the parent's actual confirmed-save disposal and React unmount,
      // rather than clearing a simulated subset of hooks or resetting the fixture.
      await state(f.page, "loading"); await hidden(f.page);
      expect(await originalForm!.evaluate((element) => element.isConnected)).toBe(false);
      const current = await pair(f.page);
      await f.page.evaluate(({ current, regimen, completedWork, savedAdjustmentId, savedVisitId }) => {
        const api = window.__patientOrthoFixture; const payload = api.caseBody(); const row = payload.cases[0];
        row.upperWire = regimen.upperWire; row.lowerWire = regimen.lowerWire;
        row.adjustments = [{ ...row.adjustments[0], id: savedAdjustmentId, visitId: savedVisitId,
          visitSigned: false, doneOn: "2026-10-04", upperWire: regimen.upperWire, lowerWire: regimen.lowerWire,
          elastics: regimen.elastics, elasticNote: regimen.elasticNote, nextWeeks: regimen.nextWeeks,
          done: completedWork }, ...row.adjustments];
        row.progress.adjustments = row.adjustments.length; row.progress.lastAdjustment = "2026-10-04";
        row.progress.daysSinceLast = 0;
        api.respond(current.ortho, payload); api.respond(current.patient, api.patientBody());
      }, { current, regimen, completedWork, savedAdjustmentId, savedVisitId });
      await state(f.page, "ready");
      expect(await panel(f.page).locator("form").count()).toBe(0);
      expect(await panel(f.page).textContent()).toContain(completedWork);
      await panel(f.page).getByRole("button", { name: /سجّل شدّة وجلسة جديدة الآن/ }).click();
      expect(await panel(f.page).getByLabel("السلك العلوي", { exact: true }).inputValue()).toBe(regimen.upperWire);
      expect(await panel(f.page).getByLabel("السلك السفلي", { exact: true }).inputValue()).toBe(regimen.lowerWire);
      expect(await panel(f.page).getByLabel("صنف المطاطات", { exact: true }).inputValue()).toBe(regimen.elastics);
      expect(await panel(f.page).getByLabel("وصف المطاطات", { exact: true }).inputValue()).toBe(regimen.elasticNote);
      expect(await panel(f.page).getByLabel("أسابيع حتى الشدّة القادمة", { exact: true }).inputValue()).toBe(String(regimen.nextWeeks));
      expect(await panel(f.page).getByLabel("ما نُفّذ في الشدّة", { exact: true }).inputValue()).toBe("");
      expect(await panel(f.page).getByLabel("تاريخ الشدّة", { exact: true }).inputValue()).toBe("2026-10-04");
      expect(await panel(f.page).locator('img[src^="blob:"]').count()).toBe(0);
      expect(await panel(f.page).getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).isEnabled()).toBe(true);
      expect(await originalForm!.evaluate((element) => element.isConnected)).toBe(false);
      expect((await writes(f.page)).filter((one) => one.path === mutationPath)).toHaveLength(1);
      expect(await writes(f.page)).toHaveLength(1); await f.assertIsolated();
      await originalForm!.dispose();
    } finally { await f.context.close(); }
  });

  it.each(["denial", "owner"] as const)("an already-sent adjustment does not upload/replay or publish old results after %s", async (retirement) => {
    const f = await open();
    try {
      await grant(f.page); const form = await adjustment(f.page); await addPhotos(f.page, 2);
      await allow(f.page, "POST", mutationPath); await submitTwice(form); const write = await latestWrite(f.page, mutationPath);
      await f.page.evaluate((id) => window.__patientOrthoFixture.headers(id, 200), write.id);
      await expect.poll(async () => (await snapshot(f.page)).requests.find((one) => one.id === write.id)!.jsonCalls).toBe(1);
      if (retirement === "denial") {
        await refresh(f.page); const ids = await pair(f.page);
        await f.page.evaluate((id) => window.__patientOrthoFixture.headers(id, 403), ids.patient);
        await state(f.page, "denied");
      } else { await f.page.locator("#patient-aba").click(); await state(f.page, "loading"); }
      await hidden(f.page);
      await f.page.evaluate((id) => window.__patientOrthoFixture.body(id, { id: 934101, visitId: 937101 }), write.id);
      expect(await writes(f.page)).toHaveLength(1);
      if (retirement === "denial") await retry(f.page);
      await grant(f.page);
      expect(await panel(f.page).textContent()).not.toContain("الجلسة القادمة المقترحة");
      expect(await writes(f.page)).toHaveLength(1);
      await f.page.locator("#toggle-probe").click();
      const after = await snapshot(f.page);
      expect(after.revoked.sort()).toEqual(after.created.map((one) => one.url).sort());
      expect(new Set(after.revoked).size).toBe(after.revoked.length); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("stops the remaining photo chain when authority is denied during the first upload", async () => {
    const f = await open();
    try {
      await grant(f.page); const form = await adjustment(f.page); await addPhotos(f.page, 2);
      await allow(f.page, "POST", mutationPath); await allow(f.page, "POST", photoPath);
      await submitTwice(form); const write = await latestWrite(f.page, mutationPath);
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, { id: 934101 }), write.id);
      const upload = await latestWrite(f.page, photoPath);
      await refresh(f.page); const ids = await pair(f.page);
      await f.page.evaluate((id) => window.__patientOrthoFixture.headers(id, 401), ids.ortho);
      await state(f.page, "denied");
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, {}), upload.id);
      expect((await writes(f.page)).filter((one) => one.path === photoPath)).toHaveLength(1);
      await hidden(f.page); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("retains an uncertain new-case submission latch across same-owner retry without replay", async () => {
    const f = await open();
    try {
      await grant(f.page, { empty: true }); await panel(f.page).getByRole("button", { name: "+ فتح حالة تقويم جديدة", exact: true }).click();
      await panel(f.page).getByLabel("نظام البراكيت", { exact: true }).fill("private-draft uncertain");
      await allow(f.page, "POST", "/api/ortho"); await submitTwice(panel(f.page).locator("form"));
      const write = await latestWrite(f.page, "/api/ortho");
      await f.page.evaluate((id) => window.__patientOrthoFixture.fail(id), write.id);
      await expect.poll(() => panel(f.page).locator('[data-testid="ortho-write-uncertain"]').count()).toBe(1);
      await ordinaryFailure(f.page); await retry(f.page); await grant(f.page, { empty: true });
      expect(await panel(f.page).getByLabel("نظام البراكيت", { exact: true }).inputValue()).toBe("private-draft uncertain");
      expect(await panel(f.page).locator('[data-testid="ortho-write-uncertain"]').count()).toBe(1);
      expect(await panel(f.page).getByRole("button", { name: "افتح الحالة", exact: true }).isDisabled()).toBe(true);
      await submitTwice(panel(f.page).locator("form")); expect(await writes(f.page)).toHaveLength(1); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("keeps a sent sign operation distinct from read generations and restores its confirmed result", async () => {
    const f = await open();
    try {
      await grant(f.page, { unsigned: true });
      await allow(f.page, "POST", `/api/visits/${visitId}/clinical`);
      await panel(f.page).getByRole("button", { name: "وقّع الزيارة وأرسله للاستقبال", exact: true }).click();
      const write = await latestWrite(f.page, `/api/visits/${visitId}/clinical`);
      await ordinaryFailure(f.page);
      // This command was already sent under a valid grant. Ordinary read
      // failure retires rendered views, not its independent mutation ticket.
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, {}), write.id);
      await state(f.page, "error"); await hidden(f.page);
      await retry(f.page); await grant(f.page, { unsigned: true });
      expect(await panel(f.page).textContent()).toContain("وُقّعت زيارة اليوم");
      expect(await panel(f.page).getByRole("button", { name: "وقّع الزيارة وأرسله للاستقبال", exact: true }).count()).toBe(0);
      expect(await writes(f.page)).toHaveLength(1); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("releases only the discarded photo and releases each remaining owned blob once at lifetime end", async () => {
    const f = await open();
    try {
      await grant(f.page); await adjustment(f.page); await addPhotos(f.page, 2);
      const before = await snapshot(f.page);
      await panel(f.page).getByRole("button", { name: "حذف", exact: true }).first().click();
      expect((await snapshot(f.page)).revoked).toEqual([before.created[0].url]);
      expect(await panel(f.page).locator('img[src^="blob:"]').getAttribute("src")).toBe(before.created[1].url);
      await ordinaryFailure(f.page); await retry(f.page); await grant(f.page);
      expect((await snapshot(f.page)).revoked).toEqual([before.created[0].url]);
      expect(await panel(f.page).locator('img[src^="blob:"]').getAttribute("src")).toBe(before.created[1].url);
      await f.page.locator("#toggle-probe").click();
      expect((await snapshot(f.page)).revoked).toEqual(before.created.map((one) => one.url));
      expect(await writes(f.page)).toHaveLength(0); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it.each(["http", "network", "json"] as const)("contact %s failure preserves clinical work but blocks booking and removes accepted reminder data", async (kind) => {
    const f = await open();
    try {
      await grant(f.page); const form = await adjustment(f.page);
      await allow(f.page, "POST", mutationPath); await submitTwice(form);
      const write = await latestWrite(f.page, mutationPath);
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, { id: 934101 }), write.id);
      await state(f.page, "loading"); let ids = await pair(f.page);
      await f.page.evaluate((id) => { const api = window.__patientOrthoFixture; api.respond(id, api.caseBody()); }, ids.ortho);
      await state(f.page, "ready");
      const booking = panel(f.page).getByRole("button", { name: /حجز الموعد المقترح الآن/ });
      expect(await booking.isDisabled()).toBe(true);
      await f.page.evaluate(({ id, kind }) => {
        const api = window.__patientOrthoFixture;
        if (kind === "http") api.respond(id, { message: "Synthetic contact error" }, 503);
        else if (kind === "network") api.fail(id);
        else api.headers(id, 200);
      }, { id: ids.patient, kind });
      if (kind === "json") {
        await expect.poll(async () => (await snapshot(f.page)).requests.find((one) => one.id === ids.patient)!.jsonCalls).toBe(1);
        await f.page.evaluate((id) => window.__patientOrthoFixture.badJSON(id), ids.patient);
      }
      await expect.poll(() => panel(f.page).textContent()).toContain("الحجز والتذكير متوقفان");
      await state(f.page, "ready"); expect(await booking.isDisabled()).toBe(true);
      expect(await panel(f.page).textContent()).toContain("accepted-case-a");
      expect(await panel(f.page).locator('a[href*="wa.me"]').count()).toBe(0);
      // Programmatic dispatch must not reopen the unavailable booking flow.
      await booking.evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect((await writes(f.page)).filter((one) => one.path === "/api/appointments")).toHaveLength(0);
      await refresh(f.page); await grant(f.page); await booking.click();
      await allow(f.page, "POST", "/api/appointments"); await submitTwice(panel(f.page).locator("form"));
      const appointment = await latestWrite(f.page, "/api/appointments");
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, { id: 933101 }), appointment.id);
      await expect.poll(() => panel(f.page).locator('a[href*="wa.me"]').count()).toBe(1);
      expect(await panel(f.page).locator('a[href*="wa.me"]').getAttribute("href")).toContain("700000001");
      await refresh(f.page); ids = await pair(f.page);
      await f.page.evaluate((ids) => {
        const api = window.__patientOrthoFixture; api.respond(ids.ortho, api.caseBody());
        api.respond(ids.patient, { message: "Synthetic contact error" }, 503);
      }, ids);
      await state(f.page, "ready");
      expect(await panel(f.page).locator('a[href*="wa.me"]').count()).toBe(0);
      expect(await panel(f.page).getByRole("button", { name: "انسخ الرسالة", exact: true }).count()).toBe(0);
      const html = await panel(f.page).innerHTML(); expect(html).not.toContain("700000001"); expect(html).not.toContain("synthetic patient A");
      expect(await writes(f.page)).toHaveLength(2); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("logout clears owned drafts, stops old results, and cannot refetch until a principal returns", async () => {
    const f = await open();
    try {
      await grant(f.page); await adjustment(f.page); await addPhotos(f.page);
      await refresh(f.page); const old = await pair(f.page);
      await f.page.locator("#session-null").click(); await state(f.page, "denied"); await hidden(f.page);
      const after = await snapshot(f.page);
      expect(after.revoked).toEqual(after.created.map((one) => one.url));
      await retry(f.page); await state(f.page, "denied");
      await f.page.evaluate((ids) => {
        const api = window.__patientOrthoFixture; api.respond(ids.ortho, api.caseBody()); api.respond(ids.patient, api.patientBody());
      }, old);
      await state(f.page, "denied"); await hidden(f.page); expect((await snapshot(f.page)).requests).toHaveLength(after.requests.length);
      await f.page.locator("#session-a").click(); await state(f.page, "loading"); await grant(f.page);
      expect(await panel(f.page).locator("form").count()).toBe(0); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("bounds a stalled clinical read and makes its late body inert after successful retry", async () => {
    const f = await open();
    try {
      await grant(f.page); await adjustment(f.page); const draft = await fields(f.page);
      await refresh(f.page); const old = await pair(f.page);
      await f.page.evaluate((ids) => {
        const api = window.__patientOrthoFixture; api.headers(ids.ortho, 200); api.respond(ids.patient, api.patientBody());
      }, old);
      await expect.poll(async () => (await snapshot(f.page)).requests.find((one) => one.id === old.ortho)!.jsonCalls).toBe(1);
      await f.page.clock.fastForward(15_001); await state(f.page, "error"); await hidden(f.page);
      expect((await snapshot(f.page)).requests.find((one) => one.id === old.ortho)!.aborted).toBe(true);
      await retry(f.page); await grant(f.page, { marker: "fresh-after-timeout" });
      expect(await fields(f.page)).toEqual(draft);
      await f.page.evaluate((id) => { const api = window.__patientOrthoFixture; api.body(id, api.caseBody("retired-body")); }, old.ortho);
      await state(f.page, "ready"); expect(await panel(f.page).textContent()).toContain("fresh-after-timeout");
      expect(await panel(f.page).textContent()).not.toContain("retired-body"); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("retains opaque photos without uploading or reposting when a deferred adjustment succeeds after its case disappears", async () => {
    const f = await open();
    try {
      await grant(f.page); const form = await adjustment(f.page); await addPhotos(f.page, 2);
      await captureCallback(form, "adjustment-before-case-withdrawal", "onSubmit");
      const before = await snapshot(f.page); const draft = await fields(f.page);
      await allow(f.page, "POST", mutationPath); await submitTwice(form);
      const command = await latestWrite(f.page, mutationPath); expect(command.status).toBeNull();
      expect((await writes(f.page)).filter((one) => one.path === mutationPath)).toHaveLength(1);
      // A successful current read explicitly withdraws this case while the
      // original POST remains on the wire. Its later positive ID is not a grant
      // to upload files to a case absent from current authorized results.
      await refresh(f.page); await grant(f.page, { empty: true });
      expect(await panel(f.page).locator('img[src^="blob:"]').count()).toBe(0);
      expect(await panel(f.page).getByLabel("ما نُفّذ في الشدّة", { exact: true }).count()).toBe(0);
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, { id: 934101, visitId: 937101 }), command.id);
      await expect.poll(() => panel(f.page).locator('[data-testid="ortho-write-uncertain"]').count()).toBe(1);
      await noSavedAppointment(f.page);
      expect((await writes(f.page)).filter((one) => one.path === photoPath)).toHaveLength(0);
      expect((await snapshot(f.page)).created).toEqual(before.created); expect((await snapshot(f.page)).revoked).toEqual([]);
      await replayCallback(f.page, "adjustment-before-case-withdrawal"); expect(await writes(f.page)).toHaveLength(1);
      await refresh(f.page); await grant(f.page);
      expect(await fields(f.page)).toEqual(draft);
      expect(await panel(f.page).locator('img[src^="blob:"]').evaluateAll((images) => images.map((image) => image.getAttribute("src"))))
        .toEqual(before.created.map((one) => one.url));
      expect(await panel(f.page).locator('[data-testid="ortho-write-uncertain"]').count()).toBe(1);
      expect(await panel(f.page).getByRole("button", { name: "احفظ الشدّة والصور", exact: true }).isDisabled()).toBe(true);
      await replayCallback(f.page, "adjustment-before-case-withdrawal"); await submitTwice(form);
      expect(await writes(f.page)).toHaveLength(1); expect((await snapshot(f.page)).revoked).toEqual([]);
      await f.page.locator("#toggle-probe").click();
      expect((await snapshot(f.page)).revoked).toEqual(before.created.map((one) => one.url));
      await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("cannot replay a captured successful signing handler into a second POST", async () => {
    const f = await open();
    try {
      await grant(f.page, { unsigned: true });
      const sign = panel(f.page).getByRole("button", { name: "وقّع الزيارة وأرسله للاستقبال", exact: true });
      await captureCallback(sign, "sign-before-success", "onClick");
      await allow(f.page, "POST", `/api/visits/${visitId}/clinical`); await sign.click();
      const command = await latestWrite(f.page, `/api/visits/${visitId}/clinical`);
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, {}), command.id);
      await expect.poll(() => panel(f.page).textContent()).toContain("وُقّعت زيارة اليوم");
      expect(await sign.count()).toBe(0);
      // Replays the committed pre-success closure itself, beyond native DOM
      // disabled/removal behavior. The stored signed state must reject it.
      await replayCallback(f.page, "sign-before-success"); expect(await writes(f.page)).toHaveLength(1);
      await refresh(f.page); await grant(f.page, { unsigned: true });
      await replayCallback(f.page, "sign-before-success");
      expect(await panel(f.page).textContent()).toContain("وُقّعت زيارة اليوم"); expect(await writes(f.page)).toHaveLength(1);
      expect((await snapshot(f.page)).callbacks.find((one) => one.key === "sign-before-success"))
        .toMatchObject({ prop: "onClick", tag: "BUTTON", connected: false, replays: 2 });
      await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("cannot replay a captured successful booking submit into a second appointment POST", async () => {
    const f = await open();
    try {
      const form = await prepareBooking(f.page); await captureCallback(form, "booking-before-success", "onSubmit");
      await allow(f.page, "POST", "/api/appointments"); await submitTwice(form);
      const booking = await latestWrite(f.page, "/api/appointments");
      expect(booking.submitted).toMatchObject({ patientId, date: "2026-11-23", time: "17:45" });
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, { id: 933101 }), booking.id);
      await expect.poll(() => panel(f.page).textContent()).toContain("تم حجز الجلسة القادمة بنجاح");
      const reminder = await panel(f.page).locator('a[href*="wa.me"]').getAttribute("href");
      await replayCallback(f.page, "booking-before-success");
      expect((await writes(f.page)).filter((one) => one.path === "/api/appointments")).toHaveLength(1);
      await refresh(f.page); await grant(f.page); await replayCallback(f.page, "booking-before-success");
      expect(await panel(f.page).locator('a[href*="wa.me"]').getAttribute("href")).toBe(reminder);
      expect((await writes(f.page)).filter((one) => one.path === "/api/appointments")).toHaveLength(1);
      expect((await snapshot(f.page)).callbacks.find((one) => one.key === "booking-before-success"))
        .toMatchObject({ prop: "onSubmit", tag: "FORM", connected: false, replays: 2 });
      await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("Back retires the captured booking-form submit and reopening creates a distinct usable view", async () => {
    const f = await open();
    try {
      const form = await prepareBooking(f.page); const draft = await fields(f.page);
      await captureCallback(form, "booking-before-back", "onSubmit");
      await form.getByRole("button", { name: "رجوع", exact: true }).click();
      expect(await panel(f.page).getByLabel("تاريخ الجلسة القادمة", { exact: true }).count()).toBe(0);
      await replayCallback(f.page, "booking-before-back");
      expect((await writes(f.page)).filter((one) => one.path === "/api/appointments")).toHaveLength(0);
      await panel(f.page).getByRole("button", { name: /حجز الموعد المقترح الآن/ }).click();
      expect(await fields(f.page)).toEqual(draft);
      await replayCallback(f.page, "booking-before-back");
      expect((await writes(f.page)).filter((one) => one.path === "/api/appointments")).toHaveLength(0);
      expect((await snapshot(f.page)).callbacks.find((one) => one.key === "booking-before-back"))
        .toMatchObject({ prop: "onSubmit", tag: "FORM", connected: false, replays: 2 });
      // The fresh view still works. Rejecting the stale closure must not lock
      // out this retained draft or its newly mounted submit handler.
      await allow(f.page, "POST", "/api/appointments"); await submitTwice(form);
      const booking = await latestWrite(f.page, "/api/appointments");
      expect(booking.submitted).toMatchObject({ patientId, date: "2026-11-23", time: "17:45" });
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, { id: 933101 }), booking.id);
      await expect.poll(() => panel(f.page).textContent()).toContain("تم حجز الجلسة القادمة بنجاح");
      expect((await writes(f.page)).filter((one) => one.path === "/api/appointments")).toHaveLength(1); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("withdraws a saved appointment draft and booked reminder when its authorized case disappears, then restores each exactly", async () => {
    const f = await open();
    try {
      const form = await prepareBooking(f.page); const draft = await fields(f.page);
      await refresh(f.page); await grant(f.page, { empty: true }); await noSavedAppointment(f.page);
      expect(await panel(f.page).locator("form").count()).toBe(0); expect(await writes(f.page)).toHaveLength(1);
      await refresh(f.page); await grant(f.page); expect(await fields(f.page)).toEqual(draft);
      expect(await panel(f.page).getByLabel("تاريخ الجلسة القادمة", { exact: true }).inputValue()).toBe("2026-11-23");
      expect(await panel(f.page).getByLabel("وقت الجلسة القادمة", { exact: true }).inputValue()).toBe("17:45");
      await allow(f.page, "POST", "/api/appointments"); await submitTwice(form);
      const booking = await latestWrite(f.page, "/api/appointments");
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, { id: 933101 }), booking.id);
      await expect.poll(() => panel(f.page).textContent()).toContain("تم حجز الجلسة القادمة بنجاح");
      const reminder = await panel(f.page).locator('a[href*="wa.me"]').getAttribute("href");
      expect(reminder).toContain("700000001");
      const card = panel(f.page).locator("div").filter({ has: f.page.getByText("تم حجز الجلسة القادمة بنجاح", { exact: true }) }).last();
      const savedText = await card.innerText();
      await refresh(f.page); await grant(f.page, { empty: true }); await noSavedAppointment(f.page);
      expect(await panel(f.page).getByRole("button", { name: "وقّع الزيارة وأرسله للاستقبال", exact: true }).count()).toBe(0);
      expect(await writes(f.page)).toHaveLength(2);
      await refresh(f.page); await grant(f.page);
      expect(await panel(f.page).textContent()).toContain("تم حجز الجلسة القادمة بنجاح");
      expect(await panel(f.page).locator('a[href*="wa.me"]').getAttribute("href")).toBe(reminder);
      expect(await card.innerText()).toBe(savedText);
      expect((await writes(f.page)).filter((one) => one.path === "/api/appointments")).toHaveLength(1);
      expect(await writes(f.page)).toHaveLength(2); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("preserves completed signing and appointment drafts across ordinary reads without resubmission", async () => {
    const f = await open();
    try {
      await grant(f.page, { unsigned: true });
      const sign = panel(f.page).getByRole("button", { name: "وقّع الزيارة وأرسله للاستقبال", exact: true });
      await allow(f.page, "POST", `/api/visits/${visitId}/clinical`);
      await sign.evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      const signed = await latestWrite(f.page, `/api/visits/${visitId}/clinical`);
      expect(await writes(f.page)).toHaveLength(1);
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, {}), signed.id);
      await expect.poll(() => panel(f.page).textContent()).toContain("وُقّعت زيارة اليوم");
      await ordinaryFailure(f.page); await retry(f.page); await grant(f.page, { unsigned: true });
      expect(await panel(f.page).textContent()).toContain("وُقّعت زيارة اليوم"); expect(await sign.count()).toBe(0);
      const form = await adjustment(f.page); await allow(f.page, "POST", mutationPath); await submitTwice(form);
      const write = await latestWrite(f.page, mutationPath);
      await f.page.evaluate(({ id, visitId }) => window.__patientOrthoFixture.respond(id, { id: 934101, visitId }), { id: write.id, visitId });
      await state(f.page, "loading"); await grant(f.page, { unsigned: true });
      await panel(f.page).getByRole("button", { name: /حجز الموعد المقترح الآن/ }).click();
      await panel(f.page).getByLabel("تاريخ الجلسة القادمة", { exact: true }).fill("2026-11-23");
      await panel(f.page).getByLabel("وقت الجلسة القادمة", { exact: true }).fill("17:45");
      const draft = await fields(f.page); await ordinaryFailure(f.page); await retry(f.page); await grant(f.page, { unsigned: true });
      expect(await fields(f.page)).toEqual(draft);
      await allow(f.page, "POST", "/api/appointments"); await submitTwice(panel(f.page).locator("form"));
      const booking = await latestWrite(f.page, "/api/appointments");
      expect(booking.submitted).toMatchObject({ patientId, date: "2026-11-23", time: "17:45", durationMinutes: 15, appointmentType: "follow_up" });
      await f.page.evaluate((id) => window.__patientOrthoFixture.respond(id, { id: 933101 }), booking.id);
      await expect.poll(() => panel(f.page).textContent()).toContain("تم حجز الجلسة القادمة بنجاح");
      await ordinaryFailure(f.page); await retry(f.page); await grant(f.page, { unsigned: true });
      expect(await panel(f.page).textContent()).toContain("تم حجز الجلسة القادمة بنجاح");
      expect((await writes(f.page)).filter((one) => one.path === "/api/appointments")).toHaveLength(1);
      expect((await writes(f.page)).filter((one) => one.path === `/api/visits/${visitId}/clinical`)).toHaveLength(1);
      await f.assertIsolated();
    } finally { await f.context.close(); }
  });
});
