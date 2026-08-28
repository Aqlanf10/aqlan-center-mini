#!/usr/bin/env node
import { loadChromium, executablePath } from "./playwright.mjs";

/**
 * رحلة الأشعة — من جهاز الاستقبال إلى ملف المريض.
 *
 * ترفع صورةً حقيقية عبر الشاشة، وتتأكد أنها تظهر في التبويب وتُفتح في العارض،
 * وأن ما يعود من الخادم هو نفس البايتات التي رُفعت — لا صورةٌ تالفة تبدو سليمة
 * حتى يُكبّرها الطبيب.
 *
 *   الاستعمال: node scripts/journeys/documents.mjs <مجلد-الصور>
 */

const OUT = process.argv[2] ?? ".";
const BASE = process.env.JOURNEY_BASE ?? "http://127.0.0.1:3000";
const USER = process.env.JOURNEY_USER ?? "shots";
const PASS = process.env.JOURNEY_PASS ?? "shots-only-local-1234";
const chromium = await loadChromium();

// صورة PNG صغيرة صالحة — بايتاتٌ حقيقية لا نصٌّ متنكّر.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR42mNk+M9Qz0BFwDiqYVTDqIZR" +
  "DaMaRjWMahjVMKphaGgAAJ1cB/1M2fkAAAAASUVORK5CYII=",
  "base64",
);

const b = await chromium.launch({ executablePath });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[خطأ صفحة]", String(e).slice(0, 160)));
const type = async (locator, text) => { await locator.click(); await locator.pressSequentially(text, { delay: 16 }); };

await page.goto(BASE + "/login", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await type(page.locator("#username"), USER);
await type(page.locator("#password"), PASS);
await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });
await page.waitForTimeout(4000);

const name = "مريض الأشعة " + Date.now().toString().slice(-5);
await page.goto(BASE + "/patients", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.getByRole("button", { name: "+ مريض جديد" }).click();
await page.waitForTimeout(1200);
await type(page.getByLabel("الاسم الكامل"), name);
await page.waitForFunction(() => {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("احفظ وافتح الملف"));
  return button && !button.disabled;
});
await page.getByRole("button", { name: /احفظ وافتح الملف/ }).click();
await page.waitForURL(/\/patients\/\d+/, { timeout: 20000 });
await page.waitForTimeout(3000);
console.log("1) أُنشئ ملف المريض");

await page.getByRole("button", { name: "الأشعة" }).click();
await page.waitForTimeout(2000);
const empty = await page.locator("body").innerText();
console.log("2) التبويب:", /لا أشعة ولا مستندات/.test(empty) ? "فارغ كما يجب ✓" : "غير متوقّع");
console.log("   والتخزين مهيَّأ:", /غير مهيَّأ/.test(empty) ? "لا ✗" : "نعم ✓");

await type(page.getByLabel("وصف المستند"), "بانورامي قبل العلاج");
await page.getByLabel("ملف الأشعة").setInputFiles({
  name: "panoramic.png", mimeType: "image/png", buffer: PNG,
});
await page.getByRole("button", { name: "ارفع" }).click();
await page.waitForTimeout(4000);
const listed = await page.locator("body").innerText();
console.log("3) بعد الرفع:", /بانورامي قبل العلاج/.test(listed) ? "ظهر في القائمة ✓" : "لم يظهر");
console.log("   ونوعه وحجمه:", /أشعة · \d+/.test(listed) ? "معروضان ✓" : "غير معروضين");
await page.screenshot({ path: OUT + "/documents-1-list.png", fullPage: true });

// ما يعود من الخادم — هل هو نفس ما رُفع؟
const thumb = page.locator('img[alt="بانورامي قبل العلاج"]').first();
const src = await thumb.getAttribute("src");
const bytes = await page.evaluate(async (url) => {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  return [...new Uint8Array(buffer)];
}, src);
console.log("4) البايتات العائدة:",
  Buffer.compare(Buffer.from(bytes), PNG) === 0 ? "مطابقة ✓" : `مختلفة (${bytes.length} بايت)`);

const decoded = await thumb.evaluate((image) => ({ w: image.naturalWidth, h: image.naturalHeight }));
console.log("   والمتصفّح فكّها:", decoded.w === 16 && decoded.h === 16 ? "16×16 ✓" : `${decoded.w}×${decoded.h}`);

await thumb.click();
await page.waitForTimeout(1800);
const viewer = await page.locator('[role="dialog"]').count();
console.log("5) العارض:", viewer > 0 ? "فُتح ✓" : "لم يُفتح");
await page.screenshot({ path: OUT + "/documents-2-viewer.png", fullPage: true });
await page.getByRole("button", { name: "إغلاق" }).click();
await page.waitForTimeout(1000);

// الأرشيف — الجزء الذي لا تحمله نسخة SQL
const archive = await page.evaluate(async (base) => {
  const response = await fetch(base + "/api/backup/documents");
  return { status: response.status, type: response.headers.get("content-type") };
}, BASE);
console.log("6) أرشيف الأشعة:",
  archive.status === 200 && archive.type?.includes("gzip") ? "يُنزَّل ✓" : `${archive.status} · ${archive.type}`);

await page.goto(BASE + "/settings/export", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
const backupPage = await page.locator("body").innerText();
console.log("7) صفحة النسخ تقول الحقيقة:",
  /والأشعة ليست في الملف أعلاه/.test(backupPage) ? "✓" : "لا تذكر الأشعة");
await page.screenshot({ path: OUT + "/documents-3-backup.png", fullPage: true });
await b.close();
