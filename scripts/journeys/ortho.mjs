#!/usr/bin/env node
import { loadChromium, executablePath } from "./playwright.mjs";

/**
 * رحلة التقويم — من فتح الحالة إلى قراءة السلك على الكرسي.
 *
 * وأهمّ خطوةٍ فيها السابعة: أن يرى الطبيب سلكَي المريض **في شاشة الزيارة** بلا أن
 * يفتح تبويبًا آخر. فذلك هو الفرق بين نظامٍ مترابط وشاشاتٍ متجاورة — وهو ما يُقاس
 * بالثواني على كرسيٍّ لا يتوقّف.
 *
 *   الاستعمال: node scripts/journeys/ortho.mjs <مجلد-الصور>
 */

const OUT = process.argv[2] ?? ".";
const BASE = process.env.JOURNEY_BASE ?? "http://127.0.0.1:3000";
const USER = process.env.JOURNEY_USER ?? "shots";
const PASS = process.env.JOURNEY_PASS ?? "shots-only-local-1234";
const chromium = await loadChromium();

const b = await chromium.launch({ executablePath });
const ctx = await b.newContext({ viewport: { width: 1280, height: 1200 }, locale: "ar" });
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

const stamp = Date.now().toString().slice(-6);
const name = "مريضة التقويم " + stamp.slice(-4);
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
await page.waitForTimeout(3000);
const patientUrl = page.url();
console.log("1) أُنشئ ملف المريضة");

await page.getByRole("button", { name: "التقويم" }).click();
await page.waitForTimeout(1800);
await page.getByRole("button", { name: /افتح حالة تقويم/ }).click();
await page.waitForTimeout(1200);
await page.getByRole("button", { name: "افتح الحالة" }).click();
await page.waitForTimeout(3000);
const opened = await page.locator("body").innerText();
console.log("2) فُتحت الحالة:", /ثابت معدني · الفكّان/.test(opened) ? "✓" : "لم تُفتح");
console.log("   وبلا سلك بعد:", /السلك العلوي/.test(opened) ? "الحقلان ظاهران ✓" : "غير ظاهرين");
await page.screenshot({ path: OUT + "/ortho-1-open.png", fullPage: true });

// حالةٌ ثانية ممنوعة — والقاعدة تمنعها لا الشاشة
const second = await page.evaluate(async (base) => {
  const response = await fetch(base + "/api/ortho", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientId: Number(location.pathname.split("/").pop()), appliance: "aligners" }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}, BASE);
console.log("3) حالة ثانية مفتوحة:",
  second.status === 409 ? `مرفوضة ✓ — ${second.body?.message ?? ""}` : `مقبولة ✗ (${second.status})`);

// أول شدّة: المقترح أوّل التسلسل
await page.getByRole("button", { name: "سجّل شدّة" }).click();
await page.waitForTimeout(1500);
const upper = await page.getByLabel("السلك العلوي").inputValue();
console.log("4) المقترح للسلك العلوي:", upper === "012 NiTi" ? "012 NiTi ✓" : `${upper}`);
await type(page.getByLabel("ما نُفّذ"), "تركيب وربط");
await page.getByRole("button", { name: "احفظ الشدّة" }).click();
await page.waitForTimeout(3000);
const afterFirst = await page.locator("body").innerText();
console.log("5) بعد الشدّة الأولى:", /012 NiTi/.test(afterFirst) ? "السلك ظاهر ✓" : "لم يظهر");
console.log("   وسجلّ الشدّات:", /سجلّ الشدّات \(1\)/.test(afterFirst) ? "شدّة واحدة ✓" : "غير مسجّل");

// شدّة ثانية: المقترح ينتقل إلى التالي
await page.getByRole("button", { name: "سجّل شدّة" }).click();
await page.waitForTimeout(1500);
const nextUpper = await page.getByLabel("السلك العلوي").inputValue();
console.log("6) المقترح للشدّة الثانية:", nextUpper === "014 NiTi" ? "014 NiTi ✓" : `${nextUpper}`);
await page.getByLabel("السلك السفلي").selectOption("");
await type(page.getByLabel("ما نُفّذ"), "تبديل العلوي فقط");
await page.getByRole("button", { name: "احفظ الشدّة" }).click();
await page.waitForTimeout(3000);
const afterSecond = await page.locator("body").innerText();
console.log("   والسفلي بقي كما هو:",
  /012 NiTi/.test(afterSecond) && /014 NiTi/.test(afterSecond) ? "✓" : "تغيّر أو مُحي");
await page.screenshot({ path: OUT + "/ortho-2-wires.png", fullPage: true });

// وهنا الاختبار الحقيقي: هل يراه الطبيب على الكرسي؟
await page.goto(BASE + "/", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await type(page.getByLabel("اسم المريض"), name);
await page.waitForTimeout(1800);
const match = page.getByRole("button", { name: new RegExp(escape(phone)) });
if (await match.count() > 0) await match.first().click();
await page.waitForTimeout(800);
await page.getByRole("button", { name: "وصل", exact: true }).click();
await page.waitForTimeout(2200);
await page.getByRole("button", { name: /نادِ · كرسي 1/ }).first().click();
await page.waitForTimeout(1800);
await page.getByRole("button", { name: "دخل الكرسي" }).first().click();
await page.waitForTimeout(2000);
await page.getByRole("link", { name: "وثّق وأغلق" }).first().click();
await page.waitForURL(/\/visits\/\d+/, { timeout: 15000 });
await page.waitForTimeout(2500);
const chairView = await page.locator("body").innerText();
console.log("7) على الكرسي — شريط التقويم:", /مريض تقويم/.test(chairView) ? "ظاهر ✓" : "غائب ✗");
console.log("   والسلكان موسومان:",
  /علوي/.test(chairView) && /سفلي/.test(chairView) && /014 NiTi/.test(chairView) ? "✓" : "ناقصان أو بلا وسم");
console.log("   وآخر ما عُمل:", /تبديل العلوي فقط/.test(chairView) ? "✓" : "غير معروض");
await page.screenshot({ path: OUT + "/ortho-3-chair.png", fullPage: true });

// والرابط يفتح التبويب المقصود لا «نظرة عامة»
await page.getByRole("link", { name: /افتح ملف التقويم/ }).click();
await page.waitForTimeout(3000);
const landed = await page.locator("body").innerText();
console.log("8) الرابط يفتح تبويب التقويم:",
  /سجلّ الشدّات/.test(landed) ? "✓" : "فتح تبويبًا آخر ✗");

// الإغلاق يشترط المثبّت
const close = await page.evaluate(async (base) => {
  const id = Number(new URLSearchParams(location.search).get("case") ?? 0);
  const list = await (await fetch(`${base}/api/ortho?patientId=${location.pathname.split("/")[2]}`)).json();
  const caseId = list.cases?.[0]?.id ?? id;
  const response = await fetch(`${base}/api/ortho/${caseId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completed" }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}, BASE);
console.log("9) إكمال بلا مثبّت:",
  close.status === 409 ? `مرفوض ✓ — ${close.body?.message ?? ""}` : `مقبول ✗ (${close.status})`);
await b.close();
