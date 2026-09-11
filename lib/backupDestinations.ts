import { assertExternalReplicationAllowed } from "./backupEncryption";
import type { BackupRunConfig } from "./backupConfig";

/**
 * تجريد وجهات النسخ الاحتياطي — مزوّدٌ لكل وجهة، وسجلٌّ واحد للنتائج.
 *
 * ### القاعدة الذهبية متعددة الوجهات
 *
 * **بناء الأرشيف والتحقق منه هو العملية الأم** — تحقَّق ⇒ نجحت النسخة. فشل
 * مزوّدٍ ثانوي لا يمسّ الأصل الصالح ولا يحذفه ولا يعيد البناء: النتيجة
 * verified + replication_status=partial، والمزوّد الراسب يُعاد وحده لاحقًا
 * على الأرشيف نفسه بلا لمس database.sql.
 *
 * ### المزوّدون في PR#21
 *
 *  * `railway_volume` — الوجهة الدائمة، بيت الأرشيف المُتحقق منه.
 *  * `google_drive` — المعمارية والتكوين والسجل جاهزة؛ الاتصال الفعلي (OAuth)
 *    PR#21B، والبلوكِر الأمني (التشفير) مفروض هنا قبل أي رفع.
 *  * `local_agent` — بروتوكول وواجهة فقط: وكيل العيادة المستقبلي يسحب بنفسه
 *    ولا يزعم أحد أن خادم السحابة يكتب على أقراص العيادة المحلية.
 *
 * أنواع مستقبلية (s3/onedrive/dropbox/nas) تدخل كأنواع في الاتحاد نفسه
 * ومزوّد لاحق في السجل — بلا تغيير في شكل النتائج ولا في المحرّك.
 */

export type BackupDestinationType =
  | "railway_volume"
  | "google_drive"
  | "local_agent"
  // أنواع محفوظة في الاتحاد من اليوم — مزوّدوها لاحقون:
  | "s3"
  | "onedrive"
  | "dropbox"
  | "nas";

export type DestinationStatus =
  | "success"
  | "failed"
  | "skipped"
  | "not_connected"
  | "blocked"
  | "pending";

export interface DestinationResult {
  destination: BackupDestinationType;
  status: DestinationStatus;
  /** سبب معقّم مقروء — لا مسارات ولا أسرار ولا رسائل مزوّد خام. */
  detail?: string;
  /** معرّف الملف لدى المزوّد (Google Drive file id مثلًا) عند النجاح. */
  providerFileId?: string;
  bytes?: number;
  sha256?: string;
}

/** مقبض الأرشيف المُتحقق منه — ما يُمرَّر للمزوّدين، بلا مسارات مطلقة في الردود. */
export interface VerifiedArchiveHandle {
  /** اسم الملف داخل مجلد backups — نسبيّ. */
  filename: string;
  sha256: string;
  bytes: number;
  databaseSha256: string;
  documentCount: number;
  createdAt: string;
  /** المسار المطلق على القرص الدائم — داخلي للمزوّد، لا يخرج في أي رد. */
  localPath: string;
}

export interface DestinationContext {
  config: BackupRunConfig;
}

export interface BackupDestinationProvider {
  readonly type: BackupDestinationType;
  readonly label: string;
  /** هل الوجهة متصلة ومهيَّأة الآن؟ — لحالة الشاشة والقرار قبل التشغيل. */
  connectionStatus(ctx: DestinationContext): DestinationResult;
  /** نسخ الأرشيف المُتحقق منه إلى الوجهة — الأصل لا يُلمس مهما كانت النتيجة. */
  replicate(archive: VerifiedArchiveHandle, ctx: DestinationContext): Promise<DestinationResult>;
}

/* ─── المزوّد الدائم: Railway Volume ───────────────────────────────────────── */

/**
 * الوجهة الدائمة — الأرشيف بُني ومُتحقق منه هنا أصلًا، فال«نسخ» إليها شهادة
 * اكتمال لا نقل: نجاحها = الشهادة، وإطفاؤها من الإعدادات = skipped لا حذف
 * للأرشيف (هو بيت البناء الوحيد في PR#21).
 */
export const railwayVolumeProvider: BackupDestinationProvider = {
  type: "railway_volume",
  label: "قرص Railway الدائم",
  connectionStatus() {
    return { destination: "railway_volume", status: "success", detail: "الوجهة الدائمة الأساسية." };
  },
  async replicate(archive) {
    return {
      destination: "railway_volume",
      status: "success",
      bytes: archive.bytes,
      sha256: archive.sha256,
      detail: "الأرشيف مكتمل ومُتحقق منه على القرص الدائم.",
    };
  },
};

/* ─── Google Drive — معمارية PR#21، اتصال PR#21B ──────────────────────────── */

/**
 * مزوّد Drive في PR#21: القرار والسجل وشكل النتيجة (providerFileId، bytes،
 * sha256) معرَّفون من اليوم، والرفع الفعلي يأتي مع اتصال OAuth في PR#21B.
 * ترتيب الحواجز صارم قبل أي رفع مستقبلًا:
 *  ١) مفعَّل في الإعدادات، ٢) **التشفير مهيَّأ** (البلوكِر)، ٣) متصل فعليًّا
 *  (OAuth) — والترتيب هنا يفرضه قبل الاتصال حتى لا يسبق رفعٌ حاجزه الأمني أبدًا.
 *
 * الوجهة المُطفأة تعيد `skipped` (مستثناة من replication_status)، والمُفعَّلة
 * في PR#21 تعيد blocked أو not_connected — وكلاهما **يُحتسب**: Railway ناجح
 * مع Drive مفعَّل غير واصل ⇒ partial لا complete، بلا تجميل للحقيقة.
 */
export const googleDriveProvider: BackupDestinationProvider = {
  type: "google_drive",
  label: "Google Drive",
  connectionStatus() {
    // PR#21: لا اتصال OAuth بعد — الحالة الصادقة قبل أي محاولة.
    return {
      destination: "google_drive",
      status: "not_connected",
      detail: "اتصال Google Drive غير مفعَّل بعد — يأتي في مرحلة PR#21B بعد مراجعة المالك.",
    };
  },
  async replicate(_archive, ctx) {
    if (!ctx.config.destinations.googleDrive) {
      return { destination: "google_drive", status: "skipped", detail: "الوجهة غير مفعَّلة في الإعدادات." };
    }
    // البلوكِر الأمني: لا نسخ خارجي بلا تشفير — حتى لو وصل الاتصال مستقبلًا
    // قبل تهيئة المفتاح، يبقى الرفع مقفولًا من هنا لا من حسن نية المستدعي.
    try {
      assertExternalReplicationAllowed();
    } catch (error) {
      return {
        destination: "google_drive",
        status: "blocked",
        detail: error instanceof Error ? error.message : "النسخ الخارجي مقفول حتى تهيئة التشفير.",
      };
    }
    return {
      destination: "google_drive",
      status: "not_connected",
      detail: "اتصال Google Drive غير مفعَّل بعد — يأتي في مرحلة PR#21B بعد مراجعة المالك.",
    };
  },
};

/* ─── وكيل العيادة المحلي — واجهة وبروتوكول فقط ────────────────────────── */

/**
 * لا يكتب خادم السحابة على أقراص العيادة — الوكيل (تطبيق سطح المكتب/الخادم
 * المحلي) هو من يأتي: يوثِّق نفسه، يرى قائمة النسخ المُتحققة، ينزّل، يتحقق
 * من SHA-256، ويخزّن حيث يختار المالك ثم يقرّ بالاستلام. بروتوكوله موثَّق في
 * docs/PRODUCTION_BACKUP_GATE.md، وبياناته (history + SHA) جاهزة من اليوم.
 *
 * القرار في الدورة: `skipped` — الوكيل ليس وجهةً مُفعَّلة في PR#21 (لا عميل
 * موجود بعد)، فصمته لا يجوز أن يُعدّ نقصَ نسخٍ يُطفئ replication_status.
 * أما `connectionStatus` فيبقى صادقًا: not_connected للشاشة لا للعدّاد.
 */
export const localAgentProvider: BackupDestinationProvider = {
  type: "local_agent",
  label: "وكيل العيادة المحلي",
  connectionStatus() {
    return {
      destination: "local_agent",
      status: "not_connected",
      detail: "وكيل النسخ المحلي (تطبيق العيادة) غير متوفر بعد — الواجهة والبروتوكول جاهزان.",
    };
  },
  async replicate() {
    return {
      destination: "local_agent",
      status: "skipped",
      detail: "وكيل العيادة المحلي غير مفعَّل في هذه المرحلة — الواجهة والبروتوكول جاهزان لتفعيلٍ لاحق.",
    };
  },
};

/** سجل المزوّدين — من هنا تُقرأ الحالات وتُنفَّذ النسخ، لا من شتى مواضع. */
export function destinationProviders(): BackupDestinationProvider[] {
  return [railwayVolumeProvider, googleDriveProvider, localAgentProvider];
}

export function destinationProviderByType(
  type: BackupDestinationType,
): BackupDestinationProvider | null {
  return destinationProviders().find((provider) => provider.type === type) ?? null;
}

/**
 * الحالة الكلية للنسخ المُوزَّع — partial تعني: الأصل سليم والبقية ناقصة.
 *
 * القاعدة (بعد إصلاح الحالة المضلِّلة): **الوجهة المُفعَّلة/المُهيَّأة تُحتسب
 * أيًّا كانت نتيجتها** — failed وblocked وnot_connected وpending كلها تعني
 * "معروفة النتيجة وغير مكتملة"، فوجودها مع نجاح Railway = partial لا
 * complete. المستثنى الوحيد هو `skipped`: وجهةً أُطفئت صراحةً من التكوين
 * فلم تُطلب منها نسخة أصلًا — صمتُ الوجهة المُطفأة ليس نقصًا في النسخ.
 */
export function replicationStatusOf(
  results: DestinationResult[],
): "complete" | "partial" | "none" {
  const counted = results.filter((result) => result.status !== "skipped");
  if (counted.length === 0) return "none";
  if (counted.every((result) => result.status === "success")) return "complete";
  return counted.some((result) => result.status === "success") ? "partial" : "none";
}
