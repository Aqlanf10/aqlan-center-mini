import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import type { StrategyCommand, StrategyProjection } from "../../lib/ortho-treatment-strategy";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { baseUrl, harness } from "./_server";
import { assertStrategyCiBoundary, createStrategyFixture } from "./_ortho-strategy-live-fixture";

// UNRUN source. The browser's exact POST is forwarded to the actual built
// route/writer, its successful COMMIT is verified in PostgreSQL, and only then
// its response delivery is aborted. No synthetic save response or DB/session
// mocking. This proves lost HTTP acknowledgement, not PostgreSQL wire loss.
let browser: Browser, h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  assertStrategyCiBoundary(); h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });

describe("committed live strategy save with lost browser acknowledgement", () => {
  it.each([390, 1280])("retains and freezes the exact draft, never silently resends, and reconciles the same command (%i px)", async width => {
    const f = await createStrategyFixture(h, `lost-response-${width}`);
    let openedContext: BrowserContext | undefined, routesOwnContext = false;
    try {
      const context = await browser.newContext({ viewport: { width, height: 844 },
        locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
      openedContext = context;
      const [name, ...value] = f.session.cookie.split("=");
      await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
      const unexpected: string[] = [], errors: string[] = [];
      let armed = false, forwarded = 0, reads = 0;
      let sent: StrategyCommand | undefined, committed: StrategyProjection | undefined;
      const routes = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${url.pathname}`); await route.abort(); return; }
        if (["GET", "HEAD", "OPTIONS"].includes(method)) {
          if (url.pathname === f.path) reads += 1;
          await route.continue(); return;
        }
        if (!armed || method !== "POST" || url.pathname !== f.path || url.search !== "") {
          unexpected.push(`${method} ${url.pathname}${url.search}`); await route.abort(); return;
        }
        armed = false; forwarded += 1;
        sent = request.postDataJSON() as StrategyCommand;
        // route.fetch transmits this exact real browser request, including its
        // authentic cookie and same-origin headers. It does not mock the writer.
        const upstream = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
        expect(upstream.status()).toBe(201);
        const body = await upstream.json(); expect(body).toMatchObject({ ok: true, replayed: false });
        committed = body.revision as StrategyProjection;
        expect(await f.counts()).toEqual({ revisions: 1, audits: 1 });
        expect((await f.history())[0]).toMatchObject({ id: committed.revisionId, command_id: sent.commandId,
          actor_user_id: f.userId, reason: sent.reason });
        // Deliberate loss after verified success; never fulfill a synthetic save.
        await route.abort("connectionreset");
      });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      page.on("download", () => unexpected.push("unexpected download"));
      page.on("dialog", dialog => { unexpected.push(`unexpected ${dialog.type()} dialog`); void dialog.dismiss(); });
      const before = await f.snapshot();
      routesOwnContext = true;
      await routes.run(async () => {
        const opened = await page.goto(`${baseUrl}/patients/${f.patientId}?tab=treatment&sub=ortho#record`, { waitUntil: "domcontentloaded" });
        expect(opened?.status()).toBe(200);
        const workspace = page.getByTestId("patient-ortho-workspace");
        await expect.poll(() => workspace.getAttribute("data-read-state")).toBe("ready");
        await workspace.getByRole("button").filter({ hasText: "خطة العلاج والميكانيكا" }).click();
        const editor = page.getByTestId("ortho-strategy-editor");
        await editor.waitFor();
        const begin = editor.getByRole("button", { name: "بدء خطة الحالة من نموذج فارغ", exact: true });
        await begin.waitFor(); await begin.click();
        const draft = editor.getByTestId("ortho-strategy-draft"), row = draft.getByTestId("ortho-strategy-row");
        await row.locator("select").selectOption(String(f.problemId));
        await editor.getByLabel("الهدف (نص الطبيب)", { exact: true }).fill("هدف اختبار حقيقي محفوظ");
        await editor.getByLabel("الاستراتيجية (نص الطبيب)", { exact: true }).fill("استراتيجية صريحة لا تتكرر عند ضياع الرد");
        await row.getByRole("checkbox").check();
        await editor.getByLabel("سبب توثيق هذه النسخة (مطلوب)", { exact: true }).fill("سبب اصطناعي لحفظ حقيقي فقد استجابته");
        const fieldValues = () => draft.locator("input,textarea,select").evaluateAll(nodes => nodes.map(node => ({
          value: (node as HTMLInputElement).value,
          checked: node instanceof HTMLInputElement ? node.checked : undefined,
        })));
        const values = await fieldValues();
        const save = editor.getByRole("button", { name: "حفظ نسخة خطة الحالة", exact: true });
        armed = true; await save.click();
        await expect.poll(() => editor.innerText()).toContain("نتيجة الطلب السابق غير مؤكدة");
        expect(forwarded).toBe(1); expect(armed).toBe(false); expect(sent).toBeDefined(); expect(committed).toBeDefined();
        expect(await save.isDisabled()).toBe(true);
        expect(await editor.getByRole("button", { name: "إلغاء مسودة الخطة", exact: true }).isDisabled()).toBe(true);
        expect(await editor.getByLabel("الهدف (نص الطبيب)", { exact: true }).isDisabled()).toBe(true);
        expect(await fieldValues()).toEqual(values);
        const exact = { history: await f.history(), audit: await f.audit() };
        const serialized = JSON.stringify(sent);
        const beforeRead = reads;
        await editor.getByRole("button", { name: "تحديث سجل الخطة", exact: true }).click();
        await expect.poll(() => reads).toBe(beforeRead + 1);
        await expect.poll(() => editor.getByTestId("ortho-strategy-saved").innerText()).toContain(sent!.reason);
        expect(await fieldValues()).toEqual(values); expect(await save.isDisabled()).toBe(true);
        expect(forwarded).toBe(1); expect(JSON.stringify(sent)).toBe(serialized);
        // Explicit same-command reconciliation uses the exact intercepted body,
        // never a regenerated command ID or reconstructed synthetic SQL row.
        const replayResponse = await f.post(sent!); expect(replayResponse.status).toBe(200);
        const replay = await replayResponse.json();
        expect(replay).toMatchObject({ ok: true, replayed: true }); expect(replay.revision).toEqual(committed);
        expect({ history: await f.history(), audit: await f.audit() }).toEqual(exact);
        expect(await f.counts()).toEqual({ revisions: 1, audits: 1 }); expect(await f.snapshot()).toEqual(before);
        expect(forwarded).toBe(1); expect(await save.isDisabled()).toBe(true);
      }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(armed).toBe(false); });
    } finally {
      try { if (!routesOwnContext) await openedContext?.close(); }
      finally { await f.close(); }
    }
  }, 90_000);
});
