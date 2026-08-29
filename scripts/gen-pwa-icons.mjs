import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * توليد أيقونات PWA من شعار النظام.
 *
 * المصدر `app/icon.svg` — الرسم المتجهي الوحيد، فالأيقونات مشتقة منه لا مرسومة
 * يدويًا بأحجام منفصلة تتقادم. قناع maskable بخلفية ممتدة كاملة (rx=0) لأن
 * الأندرويد يقصّ دائرة داخل الرمز، والحواف المفرّغة تظهر فيها فراغًا أبيض.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const source = join(repo, "app", "icon.svg");
const outDir = join(repo, "public", "icons");
mkdirSync(outDir, { recursive: true });

const svg = await import("node:fs").then((fs) => fs.promises.readFile(source, "utf8"));

const write = async (name, size, content) => {
  await sharp(Buffer.from(content)).resize(size, size).png().toFile(join(outDir, name));
  console.log(`✓ public/icons/${name}`);
};

// الأيقونة العادية — بحوافها المفرّغة كما هي.
await write("icon-192.png", 192, svg);
await write("icon-512.png", 512, svg);

// قابلة للقناع: خلفية تصل إلى الحواف حتى لا يقصّ الأندرويد زوايا بيضاء.
const maskable = svg
  .replace('rx="10"', 'rx="0"')
  .replace('<rect width="48" height="48"', '<rect width="48" height="48" transform="scale(1)"');
// تكبير المحتوى داخل القناع ١٠٪ عمدًا؟ لا — الشعار يملأ المساحة أصلًا بكثافة
// كافية، والقصّ الدائري يلمس الزوايا لا الرمز.
await write("maskable-512.png", 512, maskable);
console.log("تم توليد أيقونات PWA من icon.svg");
