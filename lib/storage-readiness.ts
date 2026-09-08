import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storageStatus } from "./files";

/**
 * جاهزية التخزين الدائم للمستندات (P1.17 + P1-FIX-7 + P1-FINAL-4).
 *
 * المبدأ: في الإنتاج (Railway) لا يُقبل سقوطٌ صامت إلى نظام ملفات مؤقّت —
 * حاوية النشر تُمحى عند أول إعادة نشر، فتضيع أشعة المرضى بعد شهور بلا أثر.
 *
 * (P1-FIX-7) المسار المطلق وحده ليس دليل دوام: مجلد absolute داخل الحاوية
 * بلا قرص مثبت هو ephemeral كما هو. الدوام يُثبت بأحد طريقين فقط:
 *
 *  ١) `DURABLE_STORAGE_ROOT` — جذر صريح يوثّقه المشغّل (مثال: قرص مربوط على
 *     `/data` ⇒ الجذر `/data` و`DOCUMENTS_DIR=/data/documents`). الاحتواء
 *     يُفحص حلًّا آمنًا بالمكوّنات (path.relative) لا بstartsWith الساذج.
 *
 *  ٢) (P1-FINAL-4) داخل Railway: `RAILWAY_VOLUME_MOUNT_PATH` — توفّره
 *     Railway تلقائيًّا عند ربط Volume، وهو **المصدر الـauthoritative** لوجود
 *     القرص ونقطة تركيبه. إن وُجد: يجب أن يكون DOCUMENTS_DIR داخله
 *     (path.relative) — root `/data` وdocs `/data/documents` ⇒ دائم؛ أما
 *     `/data-evil/documents` أو `/app/data/documents` فخارج `/data` ⇒ DENY،
 *     حتى لو ادّعى `DURABLE_STORAGE_ROOT` خلاف ذلك: بيانات المنصة هي الحقيقة.
 *     و`/proc/mounts` يبقى defense-in-depth/فحصًا إضافيًا حين تغيب سلة المنصة
 *     — لا المصدر الرئيسي الذي يحدد أن Volume موجود.
 *
 * القرار (نقي وقابل للاختبار بلا قرص عبر حقن ملف mounts وبيئة):
 *
 *  * `unconfigured` — DOCUMENTS_DIR غير مضبوط: حرج في الإنتاج (رفض الرفض
 *    قائم أصلًا في lib/files.ts — هنا يُصعَّد إلى readiness)، وتحذير في التطوير.
 *
 *  * `ephemeral` — مسار إلى منطقة مؤقّتة (tmpdir//var/tmp//dev/shm//run)،
 *    أو مسار نسبي، أو — في الإنتاج — مسار **داخل جذر غير موثَّق** (بلا
 *    DURABLE_STORAGE_ROOT ومن خارج أي قرص مثبت): الرفض صريح لا «ربما يعمل».
 *
 *  * `ready` — مسار دائم داخل جذر موثَّق (متغير صريح أو قرص Railway مثبت)،
 *    والفحص الحيّ (probe) يؤكد أنه قابل للإنشاء والكتابة.
 *
 * في التطوير/الاختبار (بلا سياق إنتاج) يبقى المسار المطلق خارج المناطق
 * المؤقّتة مقبولًا كما كان — القرار الصارم لسياق الإنتاج حصرًا.
 */

export type StorageReadinessLevel = "ready" | "unconfigured" | "ephemeral" | "unwritable";

export interface StorageReadiness {
  level: StorageReadinessLevel;
  durable: boolean;
  production: boolean;
  /** أسباب مقروءة بلا مسارات كاملة (لا تسريب تفاصيل الخادم). */
  reasons: string[];
  /** الجذر الدائم الذي وثّق القرار (DURABLE_STORAGE_ROOT أو نقطة تركيب قرص). */
  verifiedRoot: string | null;
}

export function isProductionRuntime(): boolean {
  return (
    process.env.NODE_ENV === "production"
    || Boolean(process.env.RAILWAY_PROJECT_ID)
    || Boolean(process.env.RAILWAY_SERVICE_ID)
  );
}

/** هل العملية داخل Railway فعلًا؟ — لإشارة كشف الأقراص من /proc/mounts. */
function runningOnRailway(): boolean {
  return Boolean(
    process.env.RAILWAY_PROJECT_ID
    || process.env.RAILWAY_SERVICE_ID
    || (process.env.RAILWAY_ENVIRONMENT_NAME && process.env.RAILWAY_ENVIRONMENT),
  );
}

function isEphemeralPath(rawEnv: string, resolved: string): boolean {
  // القيمة الخام قبل الحل: مسار نسبي = داخل مجلد التشغيل/الحاوية — مؤقّت بنيويًّا.
  if (!path.isAbsolute(rawEnv)) return true;
  const tmp = os.tmpdir();
  if (resolved === tmp || isInside(resolved, tmp)) return true;
  for (const zone of ["/var/tmp", "/dev/shm", "/run", "/tmp"]) {
    if (resolved === zone || isInside(resolved, zone)) return true;
  }
  return false;
}

/**
 * احتواء آمن بالمكوّنات — لا startsWith: /data/documents داخل /data، أما
 * /data-evil/documents فليس داخل /data، و/data/../etc ليس داخل /data.
 */
function isInside(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** أنظمة الملفات التي تُعد دائمة الحقيقة (ليست overlay/tmpfs/squashfs). */
const DURABLE_FS_TYPES = new Set([
  "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "jfs", "f2fs", "apfs", "ufs",
]);

export interface MountInfo {
  device: string;
  mountPoint: string;
  fsType: string;
}

/** يقرأ /proc/mounts — قابل للحقن في الاختبارات بفحصٍ بلا قرص. */
export function readProcMounts(source: string = defaultProcMounts()): MountInfo[] {
  const mounts: MountInfo[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [device, mountPointRaw, fsType] = trimmed.split(/\s+/);
    if (!device || !mountPointRaw || !fsType) continue;
    // unescape octal escapes like \040 (space) التي يستعملها kernel في /proc/mounts
    const mountPoint = mountPointRaw.replace(/\\(0[0-7]{2})/g, (_match, oct: string) =>
      String.fromCharCode(parseInt(oct, 8)),
    );
    mounts.push({ device, mountPoint, fsType });
  }
  return mounts;
}

function defaultProcMounts(): string {
  try {
    return fs.readFileSync("/proc/mounts", "utf8");
  } catch {
    return "";
  }
}

/** الجذور الدائمة الموثَّقة (P1-FINAL-4):
 *  ١) داخل Railway مع `RAILWAY_VOLUME_MOUNT_PATH` — المصدر الـauthoritative:
 *     الدوام يقرره هذا الجذر وحده (احتواء path.relative)، وأي `DURABLE_STORAGE_ROOT`
 *     يخالفه لا يوثّق شيئًا ولا يفتح بابًا.
 *  ٢) داخل Railway بلا سلة منصة — أقراص مثبتة فعلًا من /proc/mounts بنظام ملفات
 *     دائم (defense-in-depth/البديل الموثوق المثبت): أطول نقطة تركيب تحوي المسار.
 *  ٣) خارج Railway — الجذر الصريح الموثَّق `DURABLE_STORAGE_ROOT` وحده، كما كان. */
function verifiedDurableRoot(
  resolvedDocumentsDir: string,
  mounts: MountInfo[],
): string | null {
  if (runningOnRailway()) {
    const railwayMount = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
    if (railwayMount) {
      // المصدر الـauthoritative: لا يُتجاوز بمتغيّر صريح مضاد داخل Railway.
      const root = path.resolve(railwayMount);
      return isInside(resolvedDocumentsDir, root) ? root : null;
    }
    // بلا سلة المنصة: قرصٌ مثبت فعلًا بنظام ملفات دائم هو البديل الموثوق —
    // بلاه fail closed (لا يكفي DURABLE_STORAGE_ROOT وحده داخل Railway).
    let best: string | null = null;
    for (const mount of mounts) {
      if (!DURABLE_FS_TYPES.has(mount.fsType)) continue;
      if (isInside(resolvedDocumentsDir, mount.mountPoint)) {
        if (best === null || mount.mountPoint.length > best.length) best = mount.mountPoint;
      }
    }
    return best;
  }
  const explicit = process.env.DURABLE_STORAGE_ROOT?.trim();
  if (explicit) {
    const root = path.resolve(explicit);
    return isInside(resolvedDocumentsDir, root) ? root : null;
  }
  return null;
}

export function evaluateStorageDurability(
  options: { mountsSource?: string } = {},
): StorageReadiness {
  // البيئة تُقرأ مباشرة (تُختبر عبر vi.stubEnv/delete كما في باقي الوحدة)،
  // ومصدر /proc/mounts قابل للحقن بفحصٍ بلا قرص.
  return evaluateInternal(options.mountsSource);
}

function evaluateInternal(mountsSource?: string): StorageReadiness {
  const production = isProductionRuntime();
  const reasons: string[] = [];
  const raw = process.env.DOCUMENTS_DIR?.trim();

  if (!raw) {
    return {
      level: "unconfigured",
      durable: false,
      production,
      verifiedRoot: null,
      reasons: [
        production
          ? "حرج: DOCUMENTS_DIR غير مضبوط في بيئة إنتاج — رفع الأشعة مرفوض ولا يوجد تخزين دائم. اربط قرصًا دائمًا واضبط المسار."
          : "تحذير تطوير: DOCUMENTS_DIR غير مضبوط — رفع الأشعة مرفوض حتى يُضبط.",
      ],
    };
  }

  const resolved = path.resolve(raw);
  if (isEphemeralPath(raw, resolved)) {
    reasons.push(
      `مسار التخزين (مؤقّت أو نسبي) لا يصلح للإنتاج: ${production ? "مرفوض" : "تحذير"} — ` +
        "اربط قرصًا دائمًا واضبط DOCUMENTS_DIR داخل جذر دائم.",
    );
    return { level: "ephemeral", durable: false, production, reasons, verifiedRoot: null };
  }

  const root = verifiedDurableRoot(resolved, readProcMounts(mountsSource));
  if (root === null) {
    if (production) {
      const railwayMount = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ?? "";
      reasons.push(
        runningOnRailway()
          ? (railwayMount
              ? `المسار خارج جذر قرص Railway (RAILWAY_VOLUME_MOUNT_PATH=${railwayMount}) — ` +
                "داخل Railway نقطة التركيب التي توفّرها المنصة هي الحكم، ومتغيّر آخر لا يفتح بابًا حولها. " +
                "اجعل DOCUMENTS_DIR داخل نقطة تركيب القرص ثم أعد النشر."
              : "المسار مطلق لكن لا دليل على دوامه داخل Railway: RAILWAY_VOLUME_MOUNT_PATH غائب " +
                "ولا قرص مثبت بنظام ملفات دائم يظهر في /proc/mounts يحتوي المسار — " +
                "اربط Volume (فيتوفّر المتغير تلقائيًّا) واجعل DOCUMENTS_DIR داخله، ثم أعد النشر.")
          : "المسار مطلق لكن لا دليل على دوامه: ليس داخل DURABLE_STORAGE_ROOT موثَّق " +
            "— اضبط DURABLE_STORAGE_ROOT (خارج Railway) ثم أعد النشر.",
      );
      return { level: "ephemeral", durable: false, production, reasons, verifiedRoot: null };
    }
    // تطوير: المسار المطلق خارج المناطق المؤقّتة مقبول كما كان (بلا إلزام جذر).
    return { level: "ready", durable: true, production, reasons, verifiedRoot: null };
  }

  return {
    level: "ready",
    durable: true,
    production,
    reasons: [`دليل المستندات داخل جذر دائم موثَّق (${root}).`],
    verifiedRoot: root,
  };
}

/**
 * الفحص الحيّ: القرار أعلاه + فحص قائمة للكتابة فعليًا (probe من lib/files.ts
 * نفسه — نفس سلوك الرفع). النتيجة النهائية لبوابة readiness، وهي التي تدخل
 * جاهزية /api/health (P1-FIX-7): تخزين غير دائم في الإنتاج = غير جاهز.
 */
export async function probeStorageReadiness(): Promise<StorageReadiness> {
  const decision = evaluateStorageDurability();
  if (!decision.durable) return decision;
  const status = await storageStatus();
  if (!status.ready) {
    return {
      ...decision,
      level: "unwritable",
      durable: false,
      reasons: ["دليل المستندات لا يُنشأ أو لا يُكتب فيه — تحقق من تصاريح القرص المربوط."],
    };
  }
  return decision;
}
