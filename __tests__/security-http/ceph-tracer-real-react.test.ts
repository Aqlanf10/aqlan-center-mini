import { createHash } from "node:crypto";
import { canonicalJourneyJSON } from "../../lib/ortho-case-journey-json";
import sourceFixture from "../fixtures/ceph-source-fixture.json";
import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { PNG } = createRequire(import.meta.url)("pngjs");

// Browser-only integration of the real React component, real Tailwind utilities,
// synthetic geometry and intercepted writes. No application server or patient DB.
const ORIGIN = "http://127.0.0.1:19973";
let browser: Browser, script = "", css = "", temporary = "";
const syntheticImage = sourceFixture.image;
const fixturePlugin: Plugin = { name: "ceph-browser-adapters", setup(builder) {
  builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "ceph-test" }));
  builder.onLoad({ filter: /.*/, namespace: "ceph-test" }, () => ({ contents: "export default function Link({children,...props}) { return <a {...props}>{children}</a> }", loader: "tsx", resolveDir: process.cwd() }));
  if (process.env.CEPH_BASELINE === "1") builder.onLoad({ filter: /components\/CephTracer\.tsx$/ }, () => ({ contents: execFileSync("git", ["show", "c6c886121bcc50aa548f64b0b0fbd7b5beb1f324:components/CephTracer.tsx"], { encoding: "utf8" }), loader: "tsx", resolveDir: process.cwd() + "/components" }));
} };
beforeAll(async () => {
  expect(createHash("sha256").update(syntheticImage).digest("hex")).toBe(sourceFixture.imageSha256);
  expect(createHash("sha256").update(canonicalJourneyJSON(sourceFixture.referenceSet)).digest("hex")).toBe(sourceFixture.referenceSetSha256);
  temporary = mkdtempSync(join(tmpdir(), "ceph-browser-"));
  const bundle = await build({ absWorkingDir: process.cwd(), entryPoints: ["__tests__/fixtures/ceph-tracer-real-react.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' }, plugins: [fixturePlugin] });
  script = bundle.outputFiles[0].text;
  execFileSync(process.execPath, ["node_modules/tailwindcss/lib/cli.js", "-i", "app/globals.css", "-o", join(temporary, "fixture.css")]);
  css = readFileSync(join(temporary, "fixture.css"), "utf8");
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
}, 120000);
afterAll(async () => { await browser?.close(); if (temporary) rmSync(temporary, { recursive: true, force: true }); });
async function open(query = "", touch = false, options: {holdImage?:boolean;failImage?:boolean} = {}) {
  let releaseImage: () => void = () => {};
  const imageReady = options.holdImage ? new Promise<void>(resolve => { releaseImage = resolve; }) : Promise.resolve();
  const context = await browser.newContext({ viewport: { width: 1140, height: 1400 }, hasTouch: touch, serviceWorkers: "block" });
  const forbidden: string[] = [], errors: string[] = [];
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN || route.request().method() !== "GET") { forbidden.push(route.request().url()); await route.abort(); return; }
    if (url.pathname === "/") await route.fulfill({ contentType: "text/html", body: `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>${css}</style></head><body><main style="width:1100px;max-width:calc(100vw - 40px);margin:20px;transform:translate(3px, 5px)"><div id="root"></div></main><script src="/fixture.js"></script></body></html>` });
    else if (url.pathname === "/fixture.js") await route.fulfill({ contentType: "text/javascript", body: script });
    else if (url.pathname === "/favicon.ico") await route.fulfill({ status: 204, body: "" });
    else if (url.pathname === "/api/documents/990003") {
      if (url.searchParams.get("cephSource") !== sourceFixture.imageSha256 && process.env.CEPH_BASELINE !== "1") {
        forbidden.push("image-source-mismatch"); await route.abort(); return;
      }
      await imageReady;
      if (options.failImage) await route.fulfill({status:409,contentType:"application/json",body:'{"message":"Synthetic image conflict"}'});
      else await route.fulfill({ contentType: "image/svg+xml", body: syntheticImage });
    }
    else { forbidden.push(url.pathname); await route.abort(); }
  });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(ORIGIN + "/" + query, {waitUntil: options.holdImage ? "domcontentloaded" : "load"});
  await image(page).waitFor();
  if (!options.holdImage && !options.failImage) await expect.poll(() => image(page).evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1200);
  return { page, context, releaseImage, verify: () => { expect(forbidden).toEqual([]); expect(errors).toEqual([]); } };
}
const image = (p: Page) => p.getByAltText("الشععة السيفالومترية", { exact: true });
const surface = (p: Page) => image(p).locator("..");
const loupeImage = (p: Page) => p.locator('[data-testid="ceph-loupe-scene"] image, img[alt="Magnified Ceph Loupe"]');
const writes = (p: Page) => p.evaluate(() => (window as any).__ceph.writes as { landmarks?: {code:string;x:number;y:number}[] }[]);
async function position(p: Page, x: number, y: number) {
  await surface(p).locator("..").evaluate(el => el.scrollIntoView({ block: "center", inline: "nearest" }));
  const b = await image(p).boundingBox(); if (!b) throw new Error("Image missing");
  return { x: b.x + x / 1200 * b.width, y: b.y + y / 800 * b.height };
}
async function hover(p: Page, x: number, y: number) { const point = await position(p,x,y); await p.mouse.move(point.x,point.y); }
async function place(p: Page, code: string, x: number, y: number) {
  await p.getByRole("button", { name: new RegExp("^" + code + "(?: ✓)?$") }).click();
  const point = await position(p,x,y); await p.mouse.click(point.x,point.y);
  await expect.poll(async () => (await writes(p)).at(-1)?.landmarks?.[0]?.code).toBe(code);
  const actual = (await writes(p)).at(-1)!.landmarks![0];
  expect(actual.x).toBeCloseTo(x, 0); expect(actual.y).toBeCloseTo(y, 0);
}
// Opt-in diagnostic: exactly two fixed-size synthetic screenshots, never traces,
// cookies, storage, HTML dumps, external pages or arbitrary output filenames.
async function diagnosticScreenshot(page: Page, name: "loupe-initial" | "loupe-filtered") {
  if (process.env.CEPH_DIAGNOSTIC_DIR !== "ceph-diagnostic-output") return;
  try {
    if (new URL(page.url()).origin !== ORIGIN || await page.getByText("Synthetic geometry only", { exact: false }).count() === 0) return;
    mkdirSync("ceph-diagnostic-output", { recursive: true });
    await page.screenshot({ path: join("ceph-diagnostic-output", name + ".png"), fullPage: false, timeout: 5000 });
  } catch { /* Screenshot failure must not change the underlying test outcome. */ }
}
function rgb(buffer: Buffer, x:number,y:number) { const png = PNG.sync.read(buffer); const i = (Math.floor(y)*png.width+Math.floor(x))*4; return [...png.data.subarray(i,i+3)]; }

describe("CephTracer real React native-pixel viewport", () => {
  it("shows the loupe anywhere before calibration or any landmark", async () => {
    const f=await open(); try {
      await hover(f.page,300,300);
      await diagnosticScreenshot(f.page, "loupe-initial");
      await expect.poll(() => loupeImage(f.page).isVisible()).toBe(true);
      expect(await writes(f.page)).toEqual([]); f.verify();
    } finally { await f.context.close(); }
  });
  it("uses the available digitization width rather than a 570px split panel", async () => {
    const f=await open(); try {
      const view = await surface(f.page).locator("..").boundingBox();
      expect(view!.width).toBeGreaterThan(570); f.verify();
    } finally { await f.context.close(); }
  });
  it("recovers natural dimensions when the cached image loaded before hydration", async () => {
    const f=await open("?hydrate"); try {
      expect(await f.page.evaluate(() => (window as any).__ceph.hydratedAfterLoad)).toBe(true);
      await expect.poll(() => surface(f.page).locator('svg[viewBox="0 0 1200 800"]').count()).toBeGreaterThan(0);
      await hover(f.page,300,300); await expect.poll(() => loupeImage(f.page).isVisible()).toBe(true); f.verify();
    } finally { await f.context.close(); }
  });
  it("renders the actual pixel under the pointer in RTL and a transformed ancestor", async () => {
    const f=await open(); try {
      for (const [x,y,color] of [[300,300,[208,32,48]], [900,300,[32,192,64]], [300,600,[32,64,208]]] as const) {
        await hover(f.page,x,y); await expect.poll(() => loupeImage(f.page).isVisible()).toBe(true);
        const lens=f.page.getByTestId("ceph-loupe"), b=await lens.boundingBox();
        const screen=await f.page.screenshot();
        // Avoid the crosshair; each selected point lies far inside a solid quadrant.
        expect(rgb(screen,b!.x+b!.width/2+15,b!.y+b!.height/2+15)).toEqual([...color]);
      }
      f.verify();
    } finally { await f.context.close(); }
  });
  it("persists native coordinates at fit, zoom, pan and resize", async () => {
    const f=await open(); try {
      await place(f.page,"S",300,250);
      await f.page.getByRole("button",{name:"2×",exact:true}).click();
      await place(f.page,"N",450,300);
      const viewport=f.page.getByTestId("ceph-viewport");
      await viewport.evaluate(el => { el.scrollLeft=200; el.scrollTop=160; });
      await place(f.page,"Or",550,350);
      await f.page.setViewportSize({width:800,height:1400});
      await place(f.page,"Po",400,300); f.verify();
    } finally { await f.context.close(); }
  });
  it("drags one existing landmark without placing a second on pointer release", async () => {
    const f=await open(); try {
      await place(f.page,"S",300,250); const initial=(await writes(f.page)).length;
      const a=await position(f.page,300,250), b=await position(f.page,400,300);
      await f.page.mouse.move(a.x,a.y); await f.page.mouse.down(); await f.page.mouse.move(b.x,b.y,{steps:8}); await f.page.mouse.up();
      await expect.poll(async () => (await writes(f.page)).length).toBe(initial+1);
      const all=await writes(f.page); expect(all.flatMap(x=>x.landmarks??[]).every(p=>p.code==="S")).toBe(true);
      expect(all.at(-1)!.landmarks![0].x).toBeCloseTo(400,0); f.verify();
    } finally { await f.context.close(); }
  });
  it("duplicates image filters, guides and calibration inside the lens", async () => {
    const f=await open("?guides"); try {
      await f.page.getByRole("button",{name:/سلبي/}).click();
      await f.page.getByRole("button", { name: "معايرة الشععة", exact: true }).click();
      for (const [x,y] of [[250,400],[450,400]]) { const a = await position(f.page,x,y); await f.page.mouse.click(a.x,a.y); }
      await hover(f.page,350,200); await expect.poll(() => loupeImage(f.page).isVisible()).toBe(true);
      expect(await image(f.page).evaluate(el=>getComputedStyle(el).filter)).toBe(await loupeImage(f.page).evaluate(el=>getComputedStyle(el).filter));
      await diagnosticScreenshot(f.page, "loupe-filtered");
      const lensBounds = await f.page.getByTestId("ceph-loupe").boundingBox();
      expect(rgb(await f.page.screenshot(), lensBounds!.x + lensBounds!.width / 2 + 15, lensBounds!.y + lensBounds!.height / 2 + 15)).toEqual([47, 223, 207]);
      const overlay=f.page.getByTestId("ceph-overlay");
      const lens=f.page.getByTestId("ceph-loupe-scene");
      expect(await lens.locator('line[stroke="#b45309"]').count()).toBe(1);
      expect(await lens.locator("line").count()).toBeGreaterThan(2);
      const geometry = (el: Element) => Array.from(el.querySelectorAll("line,path,circle,rect")).map(n => ({ tag: n.tagName, attributes: Array.from(n.attributes).filter(a => /^(x|y|x1|y1|x2|y2|cx|cy|d|fill|stroke)$/.test(a.name)).map(a=>[a.name,a.value]), text: n.textContent }));
      expect(await lens.evaluate(geometry)).toEqual(await overlay.evaluate(geometry)); f.verify();
    } finally { await f.context.close(); }
  });
  it("supports touch placement, touch drag and pan without unintended writes", async () => {
    const f=await open("",true); try {
      const page=f.page;
      let a=await position(page,300,250); await page.touchscreen.tap(a.x,a.y);
      await expect.poll(async ()=>(await writes(page)).length).toBe(1);
      const session=await f.context.newCDPSession(page);
      const touch=async(type:"touchStart" | "touchMove" | "touchEnd",x:number,y:number)=>session.send("Input.dispatchTouchEvent",{type,touchPoints:type==="touchEnd"?[]:[{x,y}]});
      let b=await position(page,400,300);
      await touch("touchStart",a.x,a.y); await touch("touchMove",b.x,b.y); await touch("touchEnd",b.x,b.y);
      await expect.poll(async ()=>(await writes(page)).length).toBe(2);
      expect((await writes(page)).flatMap(x=>x.landmarks??[]).every(p=>p.code==="S")).toBe(true);
      await page.getByRole("button",{name:"2×",exact:true}).click();
      await page.getByRole("button",{name:"تحريك الصورة",exact:true}).click();
      const viewport=page.getByTestId("ceph-viewport");
      await viewport.scrollIntoViewIfNeeded();
      const visible = await viewport.boundingBox();
      if (!visible) throw new Error("Viewport missing");
      // After zoom, the native upper-left point may be clipped. Start the pan
      // inside the visible surface rather than outside its scrolled bounds.
      a={x:visible.x+visible.width/2,y:visible.y+visible.height/2}; b={x:a.x-60,y:a.y-50};
      const before=await viewport.evaluate(el=>({x:el.scrollLeft,y:el.scrollTop}));
      await touch("touchStart",a.x,a.y); await touch("touchMove",b.x,b.y); await touch("touchEnd",b.x,b.y);
      await expect.poll(()=>viewport.evaluate(el=>el.scrollLeft!==0||el.scrollTop!==0)).toBe(true);
      const after=await viewport.evaluate(el=>({x:el.scrollLeft,y:el.scrollTop}));
      expect(after).not.toEqual(before); expect(await writes(page)).toHaveLength(2); f.verify();
    } finally { await f.context.close(); }
  });
  it("pinches without placing points and accepts the first tap after the gesture", async () => {
    const f = await open("", true); try {
      const page = f.page;
      const a = await position(page, 450, 300), b = await position(page, 750, 500);
      const before = (await surface(page).boundingBox())!.width;
      const session = await f.context.newCDPSession(page);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...a, id: 1 }, { ...b, id: 2 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: a.x - 60, y: a.y - 40, id: 1 }, { x: b.x + 60, y: b.y + 40, id: 2 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(async () => (await surface(page).boundingBox())!.width).toBeGreaterThan(before);
      expect(await writes(page)).toEqual([]);
      const point = await position(page, 600, 400);
      await page.touchscreen.tap(point.x, point.y);
      await expect.poll(async () => (await writes(page)).length).toBe(1);
      expect((await writes(page))[0].landmarks![0]).toMatchObject({ code: "S", x: 600, y: 400 });
      f.verify();
    } finally { await f.context.close(); }
  });
  it("persists undo removals and redo coordinates across a real reload", async () => {
    const f = await open(); try {
      await place(f.page, "S", 300, 250);
      await f.page.getByRole("button", { name: "تراجع", exact: true }).click();
      await expect.poll(async () => (await writes(f.page)).at(-1)).toMatchObject({ removeLandmarks: ["S"], expectedLandmarks: [{ code: "S", x: 300, y: 250, source: "manual" }] });
      await expect.poll(() => f.page.evaluate(() => (window as any).__ceph.saved.landmarks)).toEqual([]);
      await f.page.getByRole("button", { name: "إعادة", exact: true }).click();
      await expect.poll(() => f.page.evaluate(() => (window as any).__ceph.saved.landmarks)).toEqual([{ code: "S", x: 300, y: 250, source: "manual" }]);
      await f.page.reload();
      await expect.poll(() => f.page.getByRole("button", { name: "S ✓", exact: true }).count()).toBe(1);
      await expect.poll(() => f.page.getByTestId("ceph-overlay").locator('circle[cx="300"][cy="250"]').count()).toBe(1);
      f.verify();
    } finally { await f.context.close(); }
  });
  it("keeps offline edits pending and persists them only after explicit retry", async () => {
    const f = await open(); try {
      await f.page.evaluate(() => { (window as any).__ceph.offline = true; });
      await place(f.page, "S", 300, 250);
      await expect.poll(() => f.page.getByRole("alert").textContent()).toContain("غير المحفوظة");
      expect(await f.page.evaluate(() => (window as any).__ceph.saved.landmarks)).toEqual([]);
      await f.page.evaluate(() => { (window as any).__ceph.offline = false; });
      await f.page.getByRole("alert").getByRole("button", { name: "إعادة محاولة الحفظ", exact: true }).click();
      await expect.poll(() => f.page.evaluate(() => (window as any).__ceph.saved.landmarks)).toEqual([{ code: "S", x: 300, y: 250, source: "manual" }]);
      await expect.poll(() => f.page.getByRole("alert").count()).toBe(0);
      await f.page.reload();
      await expect.poll(() => f.page.getByRole("button", { name: "S ✓", exact: true }).count()).toBe(1);
      f.verify();
    } finally { await f.context.close(); }
  });
});

describe("CephTracer descriptive narrative safety", () => {
  it("preserves clinician text through both repeated descriptive fill actions without a request", async () => {
    const f = await open(); try {
      await f.page.getByRole("button", { name: /2\. التحليل والمدارس السبع/ }).click();
      const textareas = f.page.locator("textarea");
      const authored = ["My skeletal", "My dental", "My profile", "My diagnosis", "My clinical plan\nKeep unchanged"];
      expect(await textareas.count()).toBe(5);
      for (let i = 0; i < authored.length; i++) await textareas.nth(i).fill(authored[i]);
      for (let repeat = 0; repeat < 2; repeat++) {
        await f.page.getByRole("button", { name: "تعبئة قراءة وصفية" }).click();
        await f.page.getByRole("button", { name: "تعبئة أساسية", exact: true }).click();
      }
      for (let i = 0; i < authored.length; i++) expect(await textareas.nth(i).inputValue()).toBe(authored[i]);
      expect(await writes(f.page)).toEqual([]);
      expect(await f.page.evaluate(() => (window as any).__ceph.unexpected)).toEqual([]);
      f.verify();
    } finally { await f.context.close(); }
  });
  it("keeps an empty generated report descriptive and visibly unapproved", async () => {
    const f = await open(); try {
      await f.page.getByRole("button", { name: /2\. التحليل والمدارس السبع/ }).click();
      await f.page.getByRole("button", { name: "تعبئة قراءة وصفية" }).click();
      expect(await f.page.locator("textarea").nth(3).inputValue()).toContain("وليست تشخيصًا نهائيًا");
      expect(await f.page.locator("textarea").nth(4).inputValue()).toBe("");
      await f.page.getByRole("button", { name: /3\. التقرير الرسمي والمطابقة/ }).click();
      expect(await f.page.getByText("مسودة للمراجعة؛ لم تُعتمد سريريًا بعد", { exact: true }).isVisible()).toBe(true);
      expect(await f.page.getByText("مسودة التشخيص وملاحظات الطبيب", { exact: true }).isVisible()).toBe(true);
      expect(await writes(f.page)).toEqual([]);
      expect(await f.page.evaluate(() => (window as any).__ceph.unexpected)).toEqual([]);
      f.verify();
    } finally { await f.context.close(); }
  });
});


describe("CephTracer existing suggested landmark review", () => {
  it("does not mark a suggested point reviewed just by selecting it", async () => {
    const f = await open("?review"); try {
      expect(await f.page.getByRole("button", { name: "اعتماد التحليل", exact: true }).isDisabled()).toBe(true);
      const point = await position(f.page, 300, 250); await f.page.mouse.click(point.x, point.y);
      expect(await writes(f.page)).toEqual([]);
      expect(await f.page.getByRole("button", { name: "S ✦", exact: true }).count()).toBe(1);
      expect(await f.page.getByRole("button", { name: "تراجع", exact: true }).isDisabled()).toBe(true);
      f.page.once("dialog", dialog => void dialog.dismiss());
      await f.page.getByRole("button", { name: "راجعت موضع S على الأشعة", exact: true }).click();
      expect(await writes(f.page)).toEqual([]); f.verify();
    } finally { await f.context.close(); }
  });

  it("persists explicit single-point review, source-aware Undo/Redo, and reloaded provenance", async () => {
    const f = await open("?review"); try {
      await f.page.getByRole("button", { name: "S ✦", exact: true }).click();
      f.page.once("dialog", dialog => void dialog.accept());
      await f.page.getByRole("button", { name: "راجعت موضع S على الأشعة", exact: true }).click();
      await expect.poll(async () => (await writes(f.page)).at(-1)).toMatchObject({
        landmarks: [{ code: "S", x: 300, y: 250, source: "manual" }],
        expectedLandmarks: [{ code: "S", x: 300, y: 250, source: "suggested" }],
      });
      await expect.poll(() => f.page.getByRole("button", { name: "اعتماد التحليل", exact: true }).isEnabled()).toBe(true);
      await f.page.getByRole("button", { name: "تراجع", exact: true }).click();
      await expect.poll(async () => (await writes(f.page)).at(-1)).toMatchObject({ landmarks: [{ code: "S", source: "suggested" }], expectedLandmarks: [{ code: "S", source: "manual" }] });
      await expect.poll(() => f.page.getByRole("button", { name: "اعتماد التحليل", exact: true }).isDisabled()).toBe(true);
      await f.page.getByRole("button", { name: "إعادة", exact: true }).click();
      await expect.poll(() => f.page.getByRole("button", { name: "اعتماد التحليل", exact: true }).isEnabled()).toBe(true);
      await f.page.reload();
      await expect.poll(() => f.page.getByRole("button", { name: "S ✓", exact: true }).count()).toBe(1);
      expect(await f.page.getByTestId("ceph-review-required").count()).toBe(0); f.verify();
    } finally { await f.context.close(); }
  });
});

describe('CephTracer read-only clinical capability', () => {
  it('keeps a read-only draft view interactive without clinical mutation', async () => {
    const f = await open('?guides&readonly'); try {
      const initial = await f.page.evaluate(() => JSON.stringify((window as any).__ceph.saved));
      expect(await f.page.getByText(/عرض فقط: تعديل القياسات/).isVisible()).toBe(true);
      expect(await f.page.getByRole('button', { name: 'اعتماد التحليل', exact: true }).count()).toBe(0);
      const from = await position(f.page, 250, 200), to = await position(f.page, 300, 250);
      await f.page.mouse.move(from.x, from.y); await f.page.mouse.down(); await f.page.mouse.move(to.x, to.y); await f.page.mouse.up();
      await f.page.mouse.click(to.x, to.y); await f.page.keyboard.press('ArrowRight'); await f.page.keyboard.press('Control+z');
      expect(await f.page.getByTestId('ceph-loupe').isVisible()).toBe(true);
      await f.page.getByRole('button', { name: /2\. التحليل والمدارس السبع/ }).click();
      expect(await f.page.locator('textarea').count()).toBe(0);
      expect(await f.page.getByRole('button', { name: 'حفظ التشخيص', exact: true }).count()).toBe(0);
      await f.page.getByRole('button', { name: /3\. التقرير الرسمي والمطابقة/ }).click();
      expect(await f.page.getByText('مسودة للمراجعة؛ لم تُعتمد سريريًا بعد', { exact: true }).isVisible()).toBe(true);
      expect(await writes(f.page)).toEqual([]);
      expect(await f.page.evaluate(() => JSON.stringify((window as any).__ceph.saved))).toBe(initial);
      f.verify();
    } finally { await f.context.close(); }
  });
});

describe("CephTracer real browser reviewed-source gate", () => {
  it("waits for the digest-bound image before allowing completion", async () => {
    const f = await open("?review&manual",false,{holdImage:true}); try {
      const complete=f.page.getByRole("button",{name:"اعتماد التحليل",exact:true});
      expect(await complete.isDisabled()).toBe(true);
      expect(await image(f.page).getAttribute("src")).toContain(`cephSource=${sourceFixture.imageSha256}`);
      f.releaseImage();
      await expect.poll(()=>complete.isEnabled()).toBe(true);
      expect(await f.page.evaluate(()=>(window as any).__ceph.completions)).toEqual([]);f.verify();
    } finally { f.releaseImage(); await f.context.close(); }
  });
  it("keeps completion disabled when the reviewed image response fails", async () => {
    const f=await open("?review&manual",false,{failImage:true});try {
      await expect.poll(()=>f.page.getByText("تعذّر تحميل صورة الأشعة.",{exact:false}).isVisible()).toBe(true);
      expect(await f.page.getByRole("button",{name:"اعتماد التحليل",exact:true}).isDisabled()).toBe(true);
      expect(await f.page.evaluate(()=>(window as any).__ceph.completions)).toEqual([]);f.verify();
    } finally { await f.context.close(); }
  });
  it("retries source conflicts with the original browser-reviewed identity without a refetch", async () => {
    const f=await open("?review&manual");try {
      const complete=f.page.getByRole("button",{name:"اعتماد التحليل",exact:true});
      for(let count=1;count<=2;count++) {
        await expect.poll(()=>complete.isEnabled()).toBe(true);
        f.page.once("dialog",dialog=>void dialog.accept());await complete.click();
        await expect.poll(()=>f.page.evaluate(()=>(window as any).__ceph.completions.length)).toBe(count);
      }
      const result=await f.page.evaluate(()=>({posts:(window as any).__ceph.completions,identity:(window as any).__ceph.completionSources.identity,unexpected:(window as any).__ceph.unexpected}));
      expect(result.posts[0].expectedSources).toEqual(result.identity);
      expect(result.posts[1]).toEqual(result.posts[0]);expect(result.unexpected).toEqual([]);f.verify();
    } finally { await f.context.close(); }
  });
});
