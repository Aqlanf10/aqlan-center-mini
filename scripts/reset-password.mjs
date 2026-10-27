#!/usr/bin/env node
/**
 * إعادة تعيين كلمة مرور مدير (أو أي مستخدم) نسيها مالكها.
 *
 * لماذا سكربت منفصل؟ إدارة المستخدمين في الواجهة تتطلب جلسة مدير، ومن نسي كلمة مرور
 * المدير لا يستطيع الدخول أصلًا — حلقة مغلقة. هذا السكربت يكسرها بأمان.
 *
 * الاستخدام من جهازك (بالرابط العام من لوحة Railway، لا الداخلي):
 *
 *   DATABASE_URL="postgresql://postgres:…@…proxy.rlwy.net:5432/railway" \
 *     node scripts/reset-password.mjs admin كلمة-المرور-الجديدة
 *
 * أو على الخادم داخل Railway:
 *
 *   node scripts/reset-password.mjs admin كلمة-المرور-الجديدة
 *
 * الحمايات:
 *  1. التجزئة بـ scrypt بالصيغة نفسها المستخدمة في `lib/auth.ts` — `scrypt:ملح:هيكس`.
 *  2. رابط `.railway.internal` من خارج Railway يُرفض لا أن يتجاهل بصمت (الرابط الداخلي
 *     غير قابل للوصول من الإنترنت العام، والبرنامج الرئيسي يتراجع عنه إلى PGlite محلي —
 *     والسكربت هنا يكتب مباشرة في القاعدة فلا يُسمح بهذا الالتباس).
 *  3. قاعدة Railway تُوجَّه إلى `aqlan_center_mini_v2` كما يفعل الإنتاج فعلًا —
 *     otherwise سينتهي التحديث في قاعدة `railway` القديمة (مصدر التراجع الذي لا يُمسّ)
 *     ولن تتغير كلمة المرور الحقيقية.
 *  4. التحقق بعد الكتابة: يقرأ التجزئة من القاعدة ويطابقها بالمقارنة ثابتة الزمن.
 *  5. كلمة المرور لا تقل عن 8 أحرف — القاعدة نفسها في واجهة الإنشاء.
 */
import "./load-env.mjs";
import { resetLegacyPassword } from "./security/legacy-password-reset.mjs";
import { Client } from "pg";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const SCRYPT_KEY_LENGTH = 64;

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, expected] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  const expectedBuffer = Buffer.from(expected, "hex");
  if (expectedBuffer.length !== derived.length) return false;
  return timingSafeEqual(derived, expectedBuffer);
}

/** نفس قاعدة التشفير في `lib/db.ts`: المزوّدون المُدارون يفرضون TLS. */
function sslFor(url) {
  const lowered = url.toLowerCase();
  if (lowered.includes("sslmode=disable")) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(lowered)) return false;
  return { rejectUnauthorized: false };
}

const MINI_DB = "aqlan_center_mini_v2";

/** يقرر إن كان الرابط يحتاج توجيهًا إلى قاعدة Mini — مرآة سلوك الإنتاج. */
function resolveDatabaseUrl(raw) {
  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase();
  const isRailwayHost = host.includes(".rlwy.net") || host.includes(".railway.internal");
  const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const path = decodeURIComponent(parsed.pathname || "/").replace(/\/+$/, "");
  const defaultish = path === "" || path === "/" || path === "/railway" || path === "/postgres";

  if (path === `/${MINI_DB}`) return { url: raw, redirected: false };
  if (isRailwayHost && host.includes(".railway.internal") && !process.env.RAILWAY_PROJECT_ID) {
    console.error(
      "خطأ: هذا الرابط الداخلي (postgres.railway.internal) لا يعمل إلا داخل شبكة Railway.\n" +
        "خذ الرابط العام بدلًا منه: لوحة Railway ← خدمة PostgreSQL ← تبويب Connect ← Public Networking.",
    );
    process.exit(1);
  }
  if ((isRailwayHost || (!isLocalHost && defaultish)) && path !== `/${MINI_DB}`) {
    parsed.pathname = `/${MINI_DB}`;
    return { url: parsed.toString(), redirected: true };
  }
  return { url: raw, redirected: false };
}

function usage() {
  console.log(
    "الاستخدام:\n" +
      "  node scripts/reset-password.mjs <اسم-المستخدم> <كلمة-المرور-الجديدة> [--url <رابط-القاعدة>]\n\n" +
      "مثال (من جهازك، بالرابط العام من Railway):\n" +
      '  DATABASE_URL="postgresql://…@….proxy.rlwy.net:5432/railway" node scripts/reset-password.mjs admin PassWord123\n\n' +
      "إن لم يُمرَّ الاسم افترض `admin`.",
  );
}

const args = process.argv.slice(2);
const urlFlagIdx = args.indexOf("--url");
let explicitUrl = null;
if (urlFlagIdx !== -1) {
  explicitUrl = args[urlFlagIdx + 1];
  args.splice(urlFlagIdx, 2);
}
if (args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(0);
}

const username = (args[0] ?? "admin").trim();
const password = args[1] ?? "";

if (!password) {
  usage();
  console.error("\nخطأ: اكتب كلمة المرور الجديدة.");
  process.exit(1);
}
if (password.length < 8) {
  console.error("خطأ: كلمة المرور يجب ألا تقل عن 8 أحرف — القاعدة نفسها المطبَّقة في النظام.");
  process.exit(1);
}
if (/^\s|\s$/.test(password)) {
  console.error("خطأ: كلمة المرور تبدأ أو تنتهي بمسافة — غالبًا خطأ لصق. أزل المسافة وأعد المحاولة.");
  process.exit(1);
}

const rawUrl =
  explicitUrl ??
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL ??
  process.env.POSTGRES_PRISMA_URL ??
  process.env.POSTGRES_URL_NON_POOLING ??
  "";
if (!rawUrl.trim()) {
  usage();
  console.error(
    "\nخطأ: لا يوجد رابط قاعدة بيانات. مرِّره في DATABASE_URL أو بعلم --url.\n" +
      "الرابط العام تجده في: لوحة Railway ← خدمة PostgreSQL ← تبويب Connect ← Public Networking.",
  );
  process.exit(1);
}

let resolved;
try { resolved = resolveDatabaseUrl(rawUrl.trim()); } catch {
  console.error("رابط قاعدة البيانات غير صالح.");
  process.exit(1);
}
const { url, redirected } = resolved;
if (redirected) {
  console.log(`ℹ التوجيه إلى قاعدة الإنتاج «${MINI_DB}» — كما يفعل التطبيق داخل Railway.`);
}

let client;
try {
  client = new Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();
} catch (error) {
  console.error("خطأ في الاتصال بالقاعدة.");
  console.error("تأكد من الرابط العام (Public Networking) وصلاحيته.");
  process.exit(1);
}

try {
  await resetLegacyPassword(client, { username, password, hashPassword, verifyPassword });
  console.log("✓ أُعيدت كلمة المرور وتم التحقق منها وحفظ المعاملة بنجاح.");
} catch {
  // Database/driver errors may contain sensitive connection or query details.
  console.error("تعذّر تغيير كلمة المرور. قد يكون الهدف محجوزاً لترقية الصلاحيات أو غير صالح. لم يُؤكَّد نجاح العملية.");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
