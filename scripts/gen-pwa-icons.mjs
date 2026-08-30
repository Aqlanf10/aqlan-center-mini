import sharp from "sharp";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * توليد أيقونات PWA وأيقونة التبويب من شعار المركز الحقيقي.
 *
 * المصدر `public/logo-icon.png` — مربّع ٥١٢ من أصل الشعار الذي يوفره المالك،
 * فالأيقونات مشتقة منه لا مرسومة يدويًا بأحجام منفصلة تتقادم. النسخ العادية
 * تُرسم بشعارها الملوّن على خلفية شفافة، وقناع maskable يُرسم بالنسخة البيضاء
 * على قرص كحلي كامل (لون الهوية نفسه): الأندرويد يقصّ دائرة داخل الرمز،
 * والشعار الملوّن — خطّه الكحلي — يذوب في خلفية كحلية، بينما الأبيض يبرز.
 *
 * وأيقونة التبويب `app/favicon.ico` تُبنى هنا أيضًا: حاوية ICO تضم أربعة
 * أحجام PNG (١٦/٣٢/٤٨/٦٤) — صيغة PNG داخل ICO تعترفها كل المتصفحات الحديثة،
 * فلا حاجة لمكتبة ICO ثالثة يتعيّر تحديثها.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const colorSource = join(repo, "public", "logo-icon.png");
const whiteSource = join(repo, "public", "logo-white.png");
const outDir = join(repo, "public", "icons");
const appDir = join(repo, "app");
mkdirSync(outDir, { recursive: true });

const NAVY = "#0d2137"; // لون الهوية نفسه: theme_color وbackground_color في البيان.

const write = async (name, size, source, background) => {
  let pipeline = sharp(source).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
  if (background) {
    pipeline = sharp({
      create: { width: size, height: size, channels: 4, background: background },
    }).composite([{ input: await pipeline.png().toBuffer(), gravity: "center" }]);
  }
  await pipeline.png().toFile(join(outDir, name));
  console.log(`✓ public/icons/${name}`);
};

// الأيقونات العادية — الشعار الملوّن كما هو بخلفيته الشفافة.
await write("icon-192.png", 192, colorSource);
await write("icon-512.png", 512, colorSource);

// قابلة للقناع: خلفية كحلية تصل إلى الحواف + النسخة البيضاء مصغّرة إلى ٧٦٪
// حتى يبقى هامش أمان بين الرمز وحدّ القصّ الدائري الذي يجريه الأندرويد.
const maskableCanvas = sharp({
  create: { width: 512, height: 512, channels: 4, background: NAVY },
}).composite([
  {
    input: await sharp(whiteSource)
      .resize(390, 390, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer(),
    gravity: "center",
  },
]);
await maskableCanvas.png().toFile(join(outDir, "maskable-512.png"));
console.log("✓ public/icons/maskable-512.png");

// ─── favicon.ico: حاوية ICO تضم أحجام PNG ────────────────────────────────────
// التبويب يُرسم ١٦ بكسل غالبًا، والشعار الكامل بخطّه الدقيق يصير غبضًا عنده —
// فالأحجام الأصغر تُرسم من ملف favicon.png الأصلي ١٢٨ التي جاء من المالك
// مصمَّمًا للتبويب، والأكبر من المربع ٥١٢.

const favicon128 = join(repo, "public", "favicon.png");
const hasFavicon128 = existsSync(favicon128);

const pngAt = async (size, source) =>
  sharp(source).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();

const smallSrc = hasFavicon128 ? favicon128 : colorSource;
const sizes = [16, 32, 48, 64];
const blobs = [];
for (const size of sizes) blobs.push(await pngAt(size, size <= 48 ? smallSrc : colorSource));

// بناء الحاوية: ترويسة ICO + مدخل لكل حجم ثم كتل PNG نفسها.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);

const entries = [];
let offset = 6 + sizes.length * 16;
sizes.forEach((size, index) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0); // width
  entry.writeUInt8(size === 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits
  entry.writeUInt32LE(blobs[index].length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += blobs[index].length;
  entries.push(entry);
});

await writeFile(join(appDir, "favicon.ico"), Buffer.concat([header, ...entries, ...blobs]));
console.log("✓ app/favicon.ico");
console.log("تم التوليد من شعار المالك (logo-icon.png / logo-white.png / favicon.png)");
