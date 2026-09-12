/**
 * يبني المخطط الحالي كاملًا في قاعدة مؤقتة ويعيد عقده — ثم يهدم القاعدة.
 *
 * مشتركٌ بين المولّد والمُتحقّق ليكون المقيس والمقاس به من طريقٍ واحد: لو بنى كلٌّ
 * منهما بطريقته لكان الأخضرُ اتفاقَ طريقتين لا صحةَ مخطط.
 */
import { Client } from "pg";
import { randomBytes } from "node:crypto";
import { introspectSchema, type SchemaContract } from "./schema-introspect";

export function sslFor(url: string): false | { rejectUnauthorized: boolean } {
  const lowered = url.toLowerCase();
  if (lowered.includes("sslmode=disable")) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(lowered)) return false;
  return { rejectUnauthorized: false };
}

export function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * ينشئ قاعدةً مؤقتة باسمٍ فريد، يبني فيها المخطط بـ`ensureSchema` نفسها التي
 * يستعملها البرنامج في الإقلاع، ثم يسلّم العقد ووحدةَ القاعدة لمن طلب — ويهدم
 * القاعدة في كل الأحوال.
 */
export async function withFreshSchema<T>(
  source: string,
  use: (ctx: { contract: SchemaContract; db: typeof import("../lib/db"); database: string }) => Promise<T>,
): Promise<T> {
  const database = `schema_check_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: source, ssl: sslFor(source) });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  let db: typeof import("../lib/db") | null = null;
  try {
    process.env.DATABASE_URL = withDatabase(source, database);
    /* بلا امتداد: tsx يحلّها من ملف .ts، وtsconfig يمنع الامتداد الصريح في
       الاستيراد. والوحدة واحدةٌ في الحالين ما دام المستورِد ملفَّ .ts. */
    db = await import("../lib/db");
    await db.ensureSchema();
    const client = await db.getPool().connect();
    let contract: SchemaContract;
    try {
      contract = await introspectSchema(client);
    } finally {
      client.release();
    }
    return await use({ contract, db, database });
  } finally {
    /* تُغلق اتصالات المجمّع **قبل** الهدم: الهدم القسريّ يقطع اتصالًا حيًّا فيرمي
       المجمّع خطأً غير ملتقَط يقتل العملية بعد أن تكون قد نجحت فعلًا. */
    await db?.resetPoolForTesting().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${database}`).catch(() => {});
    await admin.end().catch(() => {});
  }
}
