#!/usr/bin/env node
import { loadChromium, executablePath } from "./playwright.mjs";

/**
 * رحلة الهوية — مريضٌ واحد بسجلٍّ واحد.
 *
 * تمشي الطريق الذي كان يُنتج الملف الثاني: مريضٌ مسجَّل يصل بلا رقم جوال. وتتأكد
 * أن الشاشة تعرض ملفّه، وأن اختياره يربط الزيارة به، وأن التوقيع بعده لا يُنشئ
 * ملفًّا ثانيًا — ثم تتأكد من الحارس الثاني: زيارةٌ وصلت بلا ربط تُحذَّر قبل
 * التوقيع وتُعرض عليها ملفّات مطابقة.
 *
 *   الاستعمال: node scripts/journeys/identity.mjs <مجلد-الصور>
 */

const OUT = process.argv[2] ?? ".";
const BASE = process.env.JOURNEY_BASE ?? "http://127.0.0.1:3000";
const USER = process.env.JOURNEY_USER ?? "shots";
const PASS = process.env.JOURNEY_PASS ?? "shots-only-local-1234";
const chromium = await loadChromium();

const b = await chromium.launch({ executablePath });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[خطأ صفحة]", String(e).slice(0, 160)));
const type = async (locator, text) => { await locator.click(); await locator.pressSequentially(text, { delay: 16 }); };
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

await page.goto(BASE + "/login", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await type(page.locator("#username"), USER);
await type(page.locator("#password"), PASS);
await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });
await page.waitForTimeout(4000);

// ١) مريضٌ يُسجَّل برقمه
const stamp = Date.now().toString().slice(-6);
const name = "سعيد الهوية " + stamp.slice(-4);
const phone = "77" + stamp.padStart(7, "0");
await page.goto(BASE + "/patients", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.getByRole("button", { name: "+ مريض جديد" }).click();
await page.waitForTimeout(1200);
await type(page.getByLabel("الاسم الكامل"), name);
await type(page.getByLabel("رقم الجوال"), phone);
await page.waitForFunction(() => {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("احفظ وافتح الملف"));
  return button && !button.disabled;
});
await page.getByRole("button", { name: /احفظ وافتح الملف/ }).click();
await page.waitForURL(/\/patients\/\d+/, { timeout: 20000 });
await page.waitForTimeout(2500);
const fileNumber = (await page.locator("body").innerText()).match(/P-\d{5}/)?.[0] ?? "؟";
console.log("1) سُجّل المريض — الملف", fileNumber);

// ٢) يصل بلا رقم: الشاشة تعرض ملفّه
await page.goto(BASE + "/", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await type(page.getByLabel("اسم المريض"), name);
await page.waitForTimeout(1800);
const suggested = page.getByRole("button", { name: new RegExp(escape(fileNumber)) });
console.log("2) الشاشة عرضت ملفّه:", (await suggested.count()) > 0 ? "✓" : "لم تعرضه");
await page.screenshot({ path: OUT + "/identity-1-match.png", fullPage: true });

await suggested.first().click();
await page.waitForTimeout(1000);
const bound = await page.locator("body").innerText();
console.log("3) بعد الاختيار:", bound.includes(`مربوط بملف ${fileNumber}`) ? "مربوط ✓" : "غير مربوط");

await page.getByRole("button", { name: "وصل", exact: true }).click();
await page.waitForTimeout(2200);

// ٣) يُنادى ويُوثَّق ويُوقَّع — بلا ملفٍّ ثانٍ
await page.getByRole("button", { name: /نادِ · كرسي 1/ }).first().click();
await page.waitForTimeout(1800);
await page.getByRole("button", { name: "دخل الكرسي" }).first().click();
await page.waitForTimeout(2000);
await page.getByRole("link", { name: "وثّق وأغلق" }).first().click();
await page.waitForURL(/\/visits\/\d+/, { timeout: 15000 });
await page.waitForTimeout(2500);
const visitScreen = await page.locator("body").innerText();
console.log("4) شاشة الزيارة:", /غير مربوطة بملف/.test(visitScreen) ? "حذّرت بلا داعٍ ✗" : "لا تحذير — مربوطة ✓");

await type(page.getByLabel("التشخيص"), "كشف");
await type(page.getByLabel("ما نُفّذ"), "كشف");
const pick = async (needle) => {
  const value = await page.getByLabel("أضف إجراءً").evaluate((select, text) =>
    [...select.options].find((o) => o.textContent.includes(text))?.value ?? "", needle);
  await page.getByLabel("أضف إجراءً").selectOption(value);
};
await pick("كشف");
await page.waitForTimeout(1200);
await page.getByRole("button", { name: /وقّع الزيارة/ }).click();
await page.waitForURL(BASE + "/", { timeout: 25000 });
await page.waitForTimeout(2500);

await page.goto(BASE + "/patients", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await type(page.getByLabel("بحث عن مريض"), name);
await page.waitForTimeout(2500);
const files = await page.getByRole("link", { name: new RegExp(escape(name)) }).count();
console.log("5) بعد التوقيع — عدد ملفّاته:", files === 1 ? "ملفٌّ واحد ✓" : `${files} ملفّات ✗`);
await page.screenshot({ path: OUT + "/identity-2-one-file.png", fullPage: true });

// ٤) الحارس الثاني: وصولٌ بلا ربط يُحذَّر قبل التوقيع
await page.goto(BASE + "/", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await type(page.getByLabel("اسم المريض"), name);
await page.waitForTimeout(1800);
await page.getByRole("button", { name: "وصل", exact: true }).click();  // بلا اختيار ملف
await page.waitForTimeout(2200);
await page.getByRole("button", { name: /نادِ · كرسي 1/ }).first().click();
await page.waitForTimeout(1800);
await page.getByRole("button", { name: "دخل الكرسي" }).first().click();
await page.waitForTimeout(2000);
await page.getByRole("link", { name: "وثّق وأغلق" }).first().click();
await page.waitForURL(/\/visits\/\d+/, { timeout: 15000 });
await page.waitForTimeout(2500);
const unlinked = await page.locator("body").innerText();
console.log("6) زيارةٌ بلا ربط:", /غير مربوطة بملف/.test(unlinked) ? "حُذِّرت ✓" : "مرّت صامتة ✗");

await page.getByRole("button", { name: "ابحث عن ملفّه" }).click();
await page.waitForTimeout(2000);
const candidate = page.getByRole("button", { name: new RegExp(escape(fileNumber)) });
console.log("7) وعُرض ملفّه:", (await candidate.count()) > 0 ? "✓" : "لم يُعرض");
await page.screenshot({ path: OUT + "/identity-3-link.png", fullPage: true });

await candidate.first().click();
await page.waitForTimeout(2500);
const afterLink = await page.locator("body").innerText();
console.log("8) بعد الربط:", /غير مربوطة بملف/.test(afterLink) ? "ما زال التحذير ✗" : "زال التحذير ✓");
await b.close();
