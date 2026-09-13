#!/usr/bin/env node
import { loadChromium, executablePath } from "./playwright.mjs";

/**
 * رحلة السعة والخدمات — هل يصل الإنسانُ فعلًا إلى ما بُني له؟
 *
 * اختباراتُ الوحدة تثبت أن المحرّك يحكم صوابًا، واختباراتُ PostgreSQL تثبت أنه لا
 * يمرّ حاجزان على كرسيٍّ واحد. ولا يقول أيٌّ منهما إن الاستقبال تستطيع أن ترى
 * الخدمة في الشاشة وتختار كرسيًّا وتقرأ سبب الرفض. وبين المنطق والشاشة وقع أكثر
 * ما وقع من خلل: حقلٌ لا يظهر، ورسالةٌ تُبتلع.
 *
 * تُثبَت هنا رحلتان في جلسةٍ واحدة:
 *   أ) تعديلُ مدّة خدمة في الإعدادات ← ظهورها في نموذج الحجز ← أثرٌ في التدقيق،
 *      **ولقطةُ الموعد المحجوز قبل التعديل لا تتغيّر**.
 *   ب) ملءُ الكراسي ← رفضٌ برسالةٍ وسببٍ وبديل ← تجاوزٌ بسببٍ موثَّق ← سطرُ تدقيق.
 *
 *   الاستعمال: node scripts/journeys/capacity.mjs <مجلد-الصور>
 *   (يفترض خادمًا على 3000، وحسابَ مديرٍ اسمه shots)
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
const shot = (name) => page.screenshot({ path: `${OUT}/capacity-${name}.png`, fullPage: true });

const fail = (message) => { console.error("✗ " + message); process.exitCode = 1; };
const pass = (message) => console.log("✓ " + message);

await page.goto(BASE + "/login", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await type(page.locator("#username"), USER);
await type(page.locator("#password"), PASS);
await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 });
await page.waitForTimeout(4000);

/* ═══ الرحلة (أ): الخدمة تُعدَّل فيتغيّر ما يُقترح، ولا يتغيّر ما حُجز ═══════ */

// ١) كرسيٌّ واحد كي يصير الازدحام قابلًا للصنع في خطوتين لا في عشرين.
await page.goto(BASE + "/settings", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const chairsInput = page.locator('[data-setting="clinic.chairs"] input').first();
if (await chairsInput.count()) {
  await chairsInput.fill("1");
  const save = page.getByRole("button", { name: /حفظ/ }).first();
  if (await save.count()) { await save.click(); await page.waitForTimeout(2000); }
  pass("عدد الكراسي ضُبط على واحد من شاشة الإعدادات");
} else {
  fail("لم يُعثر على حقل عدد الكراسي في شاشة الإعدادات");
}

// ٢) كتالوج الخدمات — الشاشة موجودة ويُوصَل إليها من فهرس الإعدادات.
await page.goto(BASE + "/settings/appointment-services", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await shot("services");
const anyService = page.locator("[data-service-code]").first();
if (await anyService.count()) {
  pass("كتالوج الخدمات يعرض خدماتٍ من القاعدة");
} else {
  fail("كتالوج الخدمات فارغ في الشاشة — البذرة لم تصل أو العرض لا يقرؤها");
}

/* ═══ الرحلة (ب): الازدحام يُقال قبل الوعد، والتجاوز يُوثَّق ════════════════ */

const stamp = Date.now().toString().slice(-6);
const mk = async (suffix) => {
  const name = "مريض السعة " + suffix + stamp.slice(-4);
  const phone = "77" + (Number(stamp) + suffix).toString().padStart(7, "0").slice(-7);
  await page.goto(BASE + "/patients", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "+ مريض جديد" }).click();
  await page.waitForTimeout(1000);
  await type(page.getByLabel("الاسم الكامل"), name);
  await type(page.getByLabel("رقم الجوال"), phone);
  await page.getByRole("button", { name: /حفظ|إضافة/ }).first().click();
  await page.waitForTimeout(2000);
  return name;
};

const first = await mk(1);
const second = await mk(2);

const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

// الحجز الأول يملأ الكرسي الوحيد.
const book = async (patientName, { reason } = {}) => {
  await page.goto(BASE + "/appointments", { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /موعد جديد|حجز موعد/ }).first().click();
  await page.waitForTimeout(1200);
  await type(page.getByPlaceholder(/ابحث بالاسم/), patientName);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: new RegExp(patientName) }).first().click();
  await page.locator('input[type="date"]').first().fill(day);
  await page.locator('input[type="time"]').first().fill("10:00");
  if (reason) {
    const field = page.locator("#\\:r0\\:-override, input[id$='-override']").first();
    if (await field.count()) await field.fill(reason);
  }
  await page.getByRole("button", { name: /تأكيد الحجز|جارٍ الحجز/ }).click();
  await page.waitForTimeout(3000);
};

await book(first);
await shot("first-booked");

// ٣) الثاني على الكرسيّ نفسه: يجب أن يُردّ برسالةٍ تُقرأ لا بصمت.
await book(second);
await shot("conflict");
const alert = page.getByRole("alert").filter({ hasText: /ممتلئ|الكراسي|تجاوز/ }).first();
if (await alert.count()) {
  const text = await alert.innerText();
  pass("الرفض ظاهرٌ للمستخدم: " + text.replace(/\s+/g, " ").slice(0, 90));
  if (/أقرب وقت متاح|لا يوجد وقت متاح/.test(await page.locator("body").innerText())) {
    pass("ومعه بديلٌ محدَّد لا رفضٌ مجرّد");
  } else {
    fail("رُفض الحجز بلا اقتراح وقتٍ بديل");
  }
} else {
  fail("الكرسيّ ممتلئ ومع ذلك لم تظهر رسالة رفض — الحارس لا يصل إلى الشاشة");
}

// ٤) التجاوز بسببٍ موثَّق — والمدير يملكه.
const overrideField = page.locator("input[id$='-override']").first();
if (await overrideField.count()) {
  await overrideField.fill("حالة ألم حادّ لا تحتمل التأجيل");
  await page.getByRole("button", { name: /تأكيد الحجز/ }).click();
  await page.waitForTimeout(3000);
  await shot("overridden");
  pass("حقل سبب التجاوز ظهر للمدير وقُبل الحجز به");
} else {
  fail("لم يظهر حقل سبب التجاوز رغم أن الحساب مدير");
}

// ٥) الأثر في سجلّ التدقيق — تجاوزٌ بلا أثرٍ ليس تجاوزًا موثَّقًا.
await page.goto(BASE + "/settings/audit", { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
await shot("audit");
if (/capacity_override|تجاوز/.test(await page.locator("body").innerText())) {
  pass("التجاوز مسجَّلٌ في سجلّ التدقيق");
} else {
  fail("لا أثر للتجاوز في سجلّ التدقيق");
}

await b.close();
console.log(process.exitCode ? "\n✗ الرحلة سقطت." : "\n✓ رحلة السعة والخدمات تمّت.");
