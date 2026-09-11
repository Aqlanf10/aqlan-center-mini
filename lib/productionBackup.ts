import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import {
  acquireBackupLock,
  assertDocumentsDirInsideVolume,
  backupOnceDir,
  backupStateDir,
  productionBackupFilename,
  publishArchiveFile,
  readJsonFile,
  releaseBackupLock,
  resolveBackupDirectory,
  verifyBackupArchiveFile,
  writeArchiveTmpWithFsync,
} from "./backupVolume";
import { upsertBackupHistoryRecord } from "./backupHistory";
import { fullBackupBlocks } from "./fullBackup";
import type { Queryable } from "./db";
import { isSafeKey } from "./storage";
import { isSameOrInside } from "./safe-path";
import { sanitizeErrorMessage } from "./redact";

/**
 * بوابة تفعيل النسخة الإنتاجية — محاولة واحدة برمزٍ صريح، أرشيف موثَّق،
 * صفر كتابة في قاعدة الإنتاج.
 *
 * ### العهد الثابت في هذه الوحدة
 *
 * ١) **القراءة وحدها من قاعدة الإنتاج**: كتلة الأرشيف تأتي من fullBackupBlocks
 *    بمصدرٍ صريح جلسته READ ONLY — لا DML ولا DDL ولا migrations ولا ensureSchema.
 * ٢) **الوجهة داخل القرص الدائم فقط** — احتواءٌ بالمكوّنات عبر lib/backupVolume.
 * ٣) **لا اسم نهائي لغير نسخة مكتملة** — مؤقّت مخفي ثم فحص كامل ثم نشرٌ بربطٍ
 *    يفشل مغلقًا (الاسم النهائي القائم لا يُستبدل أبدًا).
 * ٤) **محاولة واحدة**: الرمز يُخزَّن بصمته (SHA-256) لا نصًّا، في ملف حالة
 *    ذرّيّ على القرص الدائم؛ النجاح يُسجَّل مرة، والاستدعاء اللاحق بنفس الرمز
 *    يعيد الإثبات نفسه، والتوازي داخل العملية يشترك في وعدٍ واحد، وخارجه
 *    القفل الذرّي المشترك مع محرّك النسخ (لا دورٌ يدوي ودورٌ مجدول معًا).
 * ٥) **السجلات نظيفة**: رسالة البدء والإتمام والفشل المعقّم فقط — لا رمز خام،
 *    لا روابط قاعدة، لا مسارات خاصة، لا محتوى SQL (sanitizeErrorMessage).
 */

/* ─── ثوابت البوابة ─────────────────────────────────────────────────────────── */

/** اسم متغير البيئة الذي يحمل رمز التفعيل — لا يُسجَّل أبدًا. */
export const PRODUCTION_BACKUP_TOKEN_ENV = "PRODUCTION_BACKUP_ONCE_TOKEN";

/* ─── أنواع النتائج ─────────────────────────────────────────────────────────── */

/** إثبات النسخة المكتملة — بلا مسارات مطلقة ولا أسرار. */
export interface ProductionBackupProof {
  ok: true;
  /** اسم الملف داخل مجلد backups — نسبيّ، لا مسار مطلق. */
  filename: string;
  bytes: number;
  sha256: string;
  databaseSha256: string;
  documents: number;
  createdAt: string;
}

export type ProductionBackupOutcome =
  | { kind: "completed"; proof: ProductionBackupProof }
  /** إعادة بنفس الرمز بعد نجاح سابق: الإثبات نفسه، لا نسخة ثانية. */
  | { kind: "replayed"; proof: ProductionBackupProof }
  | { kind: "misconfigured"; message: string }
  | { kind: "denied"; message: string }
  /** قفل قيد التشغيل، أو اكتمل تفعيل برمزٍ آخر، أو حالة اللمرة غير مقروءة. */
  | { kind: "conflict"; message: string }
  | { kind: "failed"; message: string };

export interface ProductionBackupDeps {
  /** رمز التفعيل المُقدَّم من الطلب. */
  providedToken: string;
  /** رمز التفعيل المُهيَّأ في البيئة — يُقارَن بزمنٍ ثابت عبر بصمتيهما. */
  expectedToken: string;
  /** جذر القرص الدائم (RAILWAY_VOLUME_MOUNT_PATH محلولًا). */
  volumeRoot: string;
  /** دليل المستندات الفعلي — يجب أن يقع داخل جذر القرص الدائم. */
  documentsDir: string;
  /**
   * مولّد كتل الأرشيف — حقنٌ للاختبار؛ الإنتاج يستخدم مولّد القاعدة
   * (productionBackupArchiveBlocks) بجلسته READ ONLY.
   */
  blocks?: () => AsyncGenerator<Uint8Array>;
  /** SHA لإيداع التطبيق — يدخل manifest.json إن توفر. */
  appCommitSha?: string | null;
  /** إصدار PostgreSQL — يدخل manifest.json إن توفر. */
  pgVersion?: string | null;
  /** سجل التطبيق — الرسائل المعقّمة فقط تمر من هنا. */
  log?: (message: string) => void;
}

/* ─── أدوات الرمز ───────────────────────────────────────────────────────────── */

/** بصمة SHA-256 لرمز التفعيل — البصمة وحدها هي ما يُخزَّن في ملف الحالة. */
export function hashBackupToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** مقارنة بصمتي رمز بزمنٍ ثابت — لا تسريب بطول أو موضع أول اختلاف. */
function tokenHashMatches(providedToken: string, storedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const provided = Buffer.from(hashBackupToken(providedToken), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return provided.length === stored.length && timingSafeEqual(provided, stored);
}

/* ─── الحارس الزمني للتشغيل الإنتاجي (endpoint-level) ───────────────────────── */

/**
 * هل تعمل العملية داخل تفعيل إنتاجي حقيقي؟ — كلا الإشارتين إلزاميتان معًا:
 * DATABASE_ENVIRONMENT=production **و** إشارة Railway صريحة. NODE_ENV وحده
 * لا يفتح شيئًا عمدًا: بيئات الاختبار تشتغل NODE_ENV=production.
 */
export function productionRuntimeActivated(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.DATABASE_ENVIRONMENT?.trim() !== "production") return false;
  const railwaySignal = env.RAILWAY_PROJECT_ID?.trim()
    || env.RAILWAY_SERVICE_ID?.trim();
  return Boolean(railwaySignal);
}

/* ─── قراءة المستندات بحارس realpath ────────────────────────────────────────── */

/**
 * قراءة مستند بعصا التحقق: المفتاح من النمط الآمن الصارم، ثم realpath الملف
 * وrealpath دليل المستندات ويجب أن يبقى الأول داخل الثاني — symlink خارج
 * دليل المستندات (حتى لو نُصب في المكان الصحيح) يُكتشف هنا وتُفشل النسخة.
 */
export async function readDocumentWithRealpathGuard(
  storageKey: string,
  documentsDir: string,
): Promise<Buffer> {
  if (!isSafeKey(storageKey)) {
    throw new Error("مفتاح مستند بنمط غير آمن في مسار النسخة.");
  }
  const documentsRoot = await realpath(documentsDir);
  const documentPath = path.resolve(documentsRoot, storageKey);
  const realDocumentPath = await realpath(documentPath);
  if (!isSameOrInside(documentsRoot, realDocumentPath)) {
    throw new Error("مستند يخرج من دليل المستندات عبر رابط رمزي — النسخة مرفوضة.");
  }
  const { readFile } = await import("node:fs/promises");
  // القراءة من المسار المحلول المُتحقق منه حرفيًّا — لا من متغير بيئةٍ قد
  // يتغيّر بين الفحص والقراءة: ما فُحص هو ما يُقرأ، وهذا شرط الحارس.
  return readFile(realDocumentPath);
}

/* ─── الكتل الإنتاجية: جلسة قاعدة READ ONLY ─────────────────────────────────── */

/** إصدار PostgreSQL من الاتصال — "PostgreSQL 18.6 …" ⇒ "18.6". */
export async function readPostgresVersion(
  client: { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> },
): Promise<string | null> {
  try {
    const { rows } = await client.query("SELECT version() AS version");
    const raw = String(rows[0]?.version ?? "");
    const match = raw.match(/PostgreSQL (\d+(?:\.\d+)?)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * كتل أرشيف الإنتاج من اتصالٍ مُمرَّر: جلسة الاتصال تُقفل READ ONLY قبل أي
 * شيء (فأي كتابةٍ يومًا ما في مسار النسخ يرفضها الخادم نفسه)، ثم
 * fullBackupBlocks بالمصدر الصريح — وهو المسار الذي **لا يستدعي**
 * ensureSchema. وإذا سقطت القراءة أعادت finally الجلسة لحالها.
 */
export async function* productionBackupBlocksWithClient(
  client: Queryable,
  options: {
    appCommitSha?: string | null;
    pgVersion?: string | null;
    /**
     * دليل المستندات المُتحقَّق منه — **إلزامي**: من تحقّق من الدليل مرة في
     * أعلى المسار هو من يمرّره صريحًا (لا storageStatus ثانية داخل المولّد
 * تعيد الاكتشاف وتُمهد لفحصٍ مختلف عمّا بُنيت عليه النسخة).
     */
    documentsDir: string;
  },
): AsyncGenerator<Uint8Array> {
  const documentsDir = options.documentsDir;
  if (!documentsDir || !path.isAbsolute(path.resolve(documentsDir))) {
    throw new Error("دليل المستندات المُتحقَّق منه مطلوب لمسار النسخة — لا اكتشافٍ ثانٍ.");
  }
  await client.query("SET default_transaction_read_only = on");
  try {
    const pgVersion = options.pgVersion ?? await readPostgresVersion(client);
    yield* fullBackupBlocks({
      source: client,
      appCommitSha: options.appCommitSha,
      pgVersion,
      readDocument: (storageKey) => readDocumentWithRealpathGuard(storageKey, documentsDir),
    });
  } finally {
    // الاتصال قد يعود إلى مجمعٍ يعيد استخدامه: لا يجوز أن يبقى القفل الجلسي
    // مفتوحًا على من يأخذه بعدها — وإذا سقط الاتصال نفسه فالإبطال لا يهم.
    await client.query("SET default_transaction_read_only = off").catch(() => {});
  }
}

/**
 * كتل أرشيف الإنتاج من مجمع قاعدة البيانات — اتصالٌ مخصص بجلسته READ ONLY،
 * وهذا هو المولّد الذي يعمل في الإنتاج افتراضيًّا. دليل المستندات يمرّر
 * صريحًا من المستدعي الذي تحقّق منه (المحرك/البوابة) — لا اكتشافٍ ثانٍ هنا.
 */
export async function* productionBackupArchiveBlocks(options: {
  appCommitSha?: string | null;
  pgVersion?: string | null;
  /** دليل المستندات المُتحقَّق منه في أعلى المسار — إلزامي. */
  documentsDir: string;
}): AsyncGenerator<Uint8Array> {
  const { getPool } = await import("./db");
  const client = await getPool().connect();
  try {
    yield* productionBackupBlocksWithClient(client, options);
  } finally {
    (client as { release?: () => void }).release?.();
  }
}

/* ─── ملف حالة التفعيل الواحد (دوام على القرص، لا قاعدة) ────────────────────── */

interface OnceState {
  tokenHash: string;
  startedAt: string;
  completedAt: string;
  filename: string;
  sha256: string;
  bytes: number;
  databaseSha256: string;
  documents: number;
}

async function readOnceState(
  backupDir: string,
): Promise<{ state: OnceState } | { absent: true } | { corrupt: true }> {
  const result = await readJsonFile<Partial<OnceState>>(
    path.join(backupOnceDir(backupDir), "state.json"),
  );
  if (!result.ok) return result.missing ? { absent: true } : { corrupt: true };
  const parsed = result.data;
  if (typeof parsed.tokenHash !== "string"
      || typeof parsed.completedAt !== "string"
      || typeof parsed.filename !== "string"
      || typeof parsed.sha256 !== "string") {
    return { corrupt: true };
  }
  return { state: parsed as OnceState };
}

/* ─── التنسيق النهائي: المحاولة الواحدة ─────────────────────────────────────── */

/**
 * الوعد المشترك داخل العملية — مُبعث بالرمز لا بالاسم:
 * التوازي لا يشترك في تشغيلٍ إلا لو حمل **الرمز نفسه** — طلبٌ برمزٍ خاطئ
 * وطلبٌ جارٍ برمزٍ صحيح لا يجتمعان على وعدٍ واحد أبدًا (والرمز الخاطئ يُرد
 * فورًا بلا انتظار وبلا مشاركة). البصمة المقارنة هي بصمة الرمز المُقدَّم
 * نفسها، والمقارنة بزمنٍ ثابت كي لا يسرّب طولها أو موضع أول اختلاف شيئًا.
 */
let inFlight: { tokenHash: string; promise: Promise<ProductionBackupOutcome> } | null = null;

/** مقارنة بصمتي رمز مُقدَّمَين بزمنٍ ثابت — للمشاركة في الوعد المشترك فقط. */
function providedHashEquals(providedHash: string, runningHash: string): boolean {
  const first = Buffer.from(providedHash, "hex");
  const second = Buffer.from(runningHash, "hex");
  return first.length === second.length && timingSafeEqual(first, second);
}

/**
 * المحاولة الواحدة للنسخة الإنتاجية الكاملة.
 *
 * ترتيب القرار الصارم: رمزٌ مُقدَّم غير فارغ ⇒ **التحقق قبل الإنشاء والانضمام
 * معًا**: لا وعدٌ مشترك يُنشأ لرمزٍ غير صحيح ولا يُنشَر لغيره — الرمز الخاطئ
 * يُرد فورًا (denied) بلا أن يملك الحالة المشتركة لحظةً واحدة، فلا يحجب
 * صاحبَ الرمز الصحيح ولا يسطو على مكانِه. ثم المتوازي بنفس الرمز (المُتحقّق
 * مُسبقًا) يشترك في العملية الجارية، والمتوازي برمزٍ صحيحٍ آخر يُرفض فورًا
 * (denied) لا ينضم ولا ينتظر. ثم داخل التنفيذ: تكوينٌ سليم ⇒ حالة اللمرة
 * ⇒ القفل الذرّي المشترك ⇒ نسخٌ مؤقت ⇒ تحققٌ كامل ⇒ نشرٌ نهائي بربطٍ يفشل
 * مغلقًا (لا استبدال اسمٍ قائم أبدًا) ⇒ سجل اكتمال ذرّي ⇒ سجل history
 * موحّد. أي فشل قبل الاكتمال: تنظيفٌ كامل، رسالة معقّمة، ومحاولةٌ لاحقة
 * بنفس الرمز مسموحة (باسمٍ جديدٍ مضمون التفرد).
 */
export async function runProductionBackupOnce(deps: ProductionBackupDeps): Promise<ProductionBackupOutcome> {
  const provided = typeof deps.providedToken === "string" ? deps.providedToken : "";
  if (!provided) {
    return { kind: "denied", message: "رمز التفعيل مطلوب." };
  }
  const expectedToken = deps.expectedToken?.trim() ?? "";
  if (!expectedToken) {
    return { kind: "misconfigured", message: "بوابة النسخة الإنتاجية غير مهيَّأة." };
  }
  // التحقق أولًا وبلا استثناء — قبل إنشاء الوعد المشترك أو الانضمام إليه:
  // الرمز غير الصحيح لا يملك الحالة المشتركة ولا يحجب من بعده صاحبَ الرمز
  // الصحيح؛ والرمز الصحيح وحده من يجوز له أن ينشئ أو ينضم.
  if (!tokenHashMatches(provided, hashBackupToken(expectedToken))) {
    return { kind: "denied", message: "رمز التفعيل غير صحيح." };
  }
  const providedHash = hashBackupToken(provided);
  if (inFlight) {
    // لا انضمام إلا لصاحب الرمز نفسه: الرمز الصحيح المخالف يُرد فورًا — لا
    // انتظار في ظلّ عمليةٍ لم يُسمح له بالانضمام إليها أصلًا.
    if (!providedHashEquals(providedHash, inFlight.tokenHash)) {
      return { kind: "denied", message: "رمز التفعيل غير صحيح." };
    }
    return inFlight.promise;
  }
  const promise = executeProductionBackupOnce(deps).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { tokenHash: providedHash, promise };
  return promise;
}

async function executeProductionBackupOnce(deps: ProductionBackupDeps): Promise<ProductionBackupOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));

  try {
    // ١) التكوين: رمزٌ مهيَّأ، جذر دائم مطلق.
    const expectedToken = deps.expectedToken?.trim() ?? "";
    if (!expectedToken) {
      return { kind: "misconfigured", message: "بوابة النسخة الإنتاجية غير مهيَّأة." };
    }
    if (!deps.providedToken || typeof deps.providedToken !== "string") {
      return { kind: "denied", message: "رمز التفعيل مطلوب." };
    }
    if (!path.isAbsolute(path.resolve(deps.volumeRoot))) {
      return { kind: "misconfigured", message: "جذر القرص الدائم غير مضبوط." };
    }

    // ٢) الرمز: مقارنة بصمتيه بزمنٍ ثابت — النتيجة عامة بلا تفاصيل.
    if (!tokenHashMatches(deps.providedToken, hashBackupToken(expectedToken))) {
      return { kind: "denied", message: "رمز التفعيل غير صحيح." };
    }

    // ٣) الاحتواء قبل أي كتابة.
    let backupDir: string;
    try {
      backupDir = resolveBackupDirectory(deps.volumeRoot);
      assertDocumentsDirInsideVolume(deps.documentsDir, deps.volumeRoot);
    } catch {
      return { kind: "misconfigured", message: "وجهة النسخة أو دليل المستندات خارج القرص الدائم." };
    }
    await mkdir(backupDir, { recursive: true });
    await mkdir(backupOnceDir(backupDir), { recursive: true });
    await mkdir(backupStateDir(backupDir), { recursive: true });

    // ٤) حالة اللمرة: اكتملت سابقًا بنفس الرمز ⇒ الإثبات نفسه (لا نسخة ثانية)،
    //    برمزٍ آخر ⇒ صراع، حالةٌ غير مقروءة ⇒ فشل مغلق (لا يُخمَّن الاتجاه).
    const current = await readOnceState(backupDir);
    if ("corrupt" in current) {
      return { kind: "conflict", message: "حالة التفعيل غير مقروءة — يلزم تدخّل يدوي قبل أي نسخة." };
    }
    if ("state" in current) {
      if (tokenHashMatches(deps.providedToken, current.state.tokenHash)) {
        return { kind: "replayed", proof: proofFromState(current.state) };
      }
      return { kind: "conflict", message: "التفعيل اكتمل سابقًا برمز آخر — لا نسخة ثانية." };
    }

    // ٥) القفل الذرّي المشترك مع محرّك النسخ — عبر العمليات كلها.
    const lock = await acquireBackupLock(backupStateDir(backupDir), "backup.lock");
    if (lock === "in-progress") {
      return { kind: "conflict", message: "نسخة قيد التشغيل حاليًّا." };
    }
    try {
      // ٦) الحالة قد تتغيّر بين القراءة والقفل (سباق عمليات) — تُقرأ بعد الفوز.
      const afterLock = await readOnceState(backupDir);
      if ("state" in afterLock) {
        if (tokenHashMatches(deps.providedToken, afterLock.state.tokenHash)) {
          return { kind: "replayed", proof: proofFromState(afterLock.state) };
        }
        return { kind: "conflict", message: "التفعيل اكتمل سابقًا برمز آخر — لا نسخة ثانية." };
      }

      const now = new Date();
      const startedAt = now.toISOString();
      const filename = productionBackupFilename(now, deps.appCommitSha);
      log(`[production-backup] started`);

      // ٧) التجميع والكتابة المؤقتة داخل مجلد النسخ نفسه (لا /tmp نهائيًّا) —
      //    ودليل المستندات المُتحقَّق منه يمرّر صريحًا إلى المولّد نفسه.
      const blocks = deps.blocks ?? (() => productionBackupArchiveBlocks({
        appCommitSha: deps.appCommitSha,
        pgVersion: deps.pgVersion,
        documentsDir: deps.documentsDir,
      }));
      const tmpPath = await writeArchiveTmpWithFsync(backupDir, filename, (await import("node:stream")).Readable.from(blocks()));

      // ٨) التحقق الكامل على الملف المؤقت — الرسوب هنا يحذفه ولا يمنح اسمًا نهائيًّا.
      let verified: Awaited<ReturnType<typeof verifyBackupArchiveFile>>;
      try {
        verified = await verifyBackupArchiveFile(tmpPath, deps.documentsDir);
      } catch (error) {
        await rm(tmpPath, { force: true }).catch(() => {});
        const safe = sanitizeErrorMessage(error, "فشل التحقق من أرشيف النسخة.");
        log(`[production-backup] failed reason=${safe}`);
        return { kind: "failed", message: safe };
      }

      // ٩) النشر النهائي بربطٍ يفشل مغلقًا ثم سجل الاكتمال — وبهذا وحده صارت
      //    النسخة "مكتملة". الهدف القائم لا يُستبدل أبدًا (EEXIST فشلٌ مغلق) —
      //    والاسم المولَّد مضمون التفرد أصلًا (ملي ثانية + لاحقة عشوائية).
      const finalPath = path.join(backupDir, filename);
      try {
        await publishArchiveFile(tmpPath, finalPath);
      } catch (error) {
        await rm(tmpPath, { force: true }).catch(() => {});
        throw error;
      }
      const state: OnceState = {
        tokenHash: hashBackupToken(expectedToken),
        startedAt,
        completedAt: new Date().toISOString(),
        filename,
        sha256: verified.sha256,
        bytes: verified.bytes,
        databaseSha256: verified.databaseSha256,
        documents: verified.documents,
      };
      const { atomicWriteJson } = await import("./backupVolume");
      try {
        await atomicWriteJson(path.join(backupOnceDir(backupDir), "state.json"), state);
      } catch (error) {
        // الاكتمال غير مسجَّل: لا نكذب على القادمين بلا إثبات — الفشل معقّم
        // والمحاولة تُعاد **باسمٍ جديدٍ مضمون التفرد** (لا استبدالٍ للأرشيف
        // المنشور غير المسجَّل: بقاءُه على القرص شهادةٌ تُقيَّم يدويًّا، ودسُّ
        // نسخةٍ فوقه ممنوع بناءً على قاعدة عدم الاستبدال).
        const safe = sanitizeErrorMessage(error, "تعذّر تسجيل اكتمال النسخة.");
        log(`[production-backup] failed reason=${safe}`);
        return { kind: "failed", message: safe };
      }

      // ١٠) سجل النسخ الموحّد (قرص الدوام) — التفعيل نسخةٌ يدوية مُتحققة.
      await upsertBackupHistoryRecord(backupDir, {
        backupId: filename,
        createdAt: state.completedAt,
        triggerType: "manual",
        archiveSha256: verified.sha256,
        archiveBytes: verified.bytes,
        databaseSha256: verified.databaseSha256,
        documentCount: verified.documents,
        status: "verified",
        replicationStatus: "complete",
        destinations: [{
          destination: "railway_volume",
          status: "success",
          bytes: verified.bytes,
          sha256: verified.sha256,
          detail: "أرشيف التفعيل مكتمل ومُتحقق منه على القرص الدائم.",
        }],
      }).catch(() => {});

      log(`[production-backup] completed filename=${filename} bytes=${verified.bytes} sha256=${verified.sha256}`);
      return { kind: "completed", proof: proofFromState(state) };
    } finally {
      await releaseBackupLock(lock);
    }
  } catch (error) {
    const safe = sanitizeErrorMessage(error, "فشلت النسخة الإنتاجية بخطأ غير متوقع.");
    log(`[production-backup] failed reason=${safe}`);
    return { kind: "failed", message: safe };
  }
}

function proofFromState(state: OnceState): ProductionBackupProof {
  return {
    ok: true,
    filename: state.filename,
    bytes: state.bytes,
    sha256: state.sha256,
    databaseSha256: state.databaseSha256,
    documents: state.documents,
    createdAt: state.completedAt,
  };
}

/** قراءة إثبات التفعيل إن وُجد — لشاشة الحالة، بلا أي مسار مطلق. */
export async function readProductionBackupActivationState(
  volumeRoot: string,
): Promise<ProductionBackupProof | null> {
  try {
    const backupDir = resolveBackupDirectory(volumeRoot);
    const result = await readOnceState(backupDir);
    return "state" in result ? proofFromState(result.state) : null;
  } catch {
    return null;
  }
}

/** قراءة ملف أرشيف خام (لأغراض الوكيل المستقبلي وفحوص التشفير) — داخلي. */
export async function readBackupArchiveBytes(archivePath: string): Promise<Buffer> {
  return readFile(archivePath);
}
