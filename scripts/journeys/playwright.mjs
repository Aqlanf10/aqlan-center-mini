/**
 * يعثر على Playwright أينما كان مثبَّتًا.
 *
 * وهو **ليس** تبعيةً في `package.json` عمدًا: إضافته هناك تجعل `npm ci` داخل
 * Docker يحاول تنزيل متصفّح عند كل بناء — فيبطؤ النشر أو يفشل بلا سبب ظاهر.
 * والرحلات أدواتُ تحقّقٍ تُشغَّل باليد على جهاز التطوير، لا جزءًا من الإنتاج.
 *
 *   npm i -g playwright   ثم:   node scripts/journeys/plan.mjs
 */
export async function loadChromium() {
  const candidates = [
    "playwright",
    process.env.PLAYWRIGHT_MODULE,
    "/opt/node22/lib/node_modules/playwright/index.js",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const loaded = await import(candidate);
      const chromium = loaded.chromium ?? loaded.default?.chromium;
      if (chromium) return chromium;
    } catch {
      // يُجرَّب التالي — وغيابُ الحزمة ليس خطأً يستحق إيقاف الرحلة قبل أوانها.
    }
  }
  throw new Error(
    "لم يُعثر على Playwright. ثبّته: npm i -g playwright — أو اضبط PLAYWRIGHT_MODULE على مساره.",
  );
}

/** المتصفّح المثبَّت في هذه البيئة، وإلا فما تجده Playwright بنفسها. */
export const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? "/opt/pw-browsers/chromium";
