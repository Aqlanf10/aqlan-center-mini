import os from "node:os";
import path from "node:path";
import { storageStatus } from "./files";

/**
 * جاهزية التخزين الدائم للمستندات (P1.17).
 *
 * المبدأ: في الإنتاج (Railway) لا يُقبل سقوطٌ صامت إلى نظام ملفات مؤقّت —
 * حاوية النشر تُمحى عند أول إعادة نشر، فتضيع أشعة المرضى بعد شهور بلا أثر.
 * القرار هنا (نقّي وقابل للاختبار بلا قرص):
 *
 *  ١) `unconfigured` — DOCUMENTS_DIR غير مضبوط: في الإنتاج هذا **حرج** مع رسالة
 *     إعداد صريحة (رفض الرفع قائم أصلًا في lib/files.ts — هنا يُصعَّد إلى
 *     readiness)، وفي التطوير مجرد تحذير (PGlite التجريبي لا يخزن أشعة).
 *
 *  ٢) `ephemeral` — المسار مضبوط لكنه إلى نظام مؤقّت: داخل tmpdir، أو مسار
 *     نسبي (يحل إلى داخل المشروع/الحاوية)، أو داخل /var/tmp — رفضٌ صريح في
 *     الإنتاج بلا «ربما يعمل».
 *
 *  ٣) `ready` — مسار مطلق دائم خارج المناطق المؤقّتة، والفحص الحيّ (probe)
 *     يؤكد أنه قابل للإنشاء والكتابة.
 */

export type StorageReadinessLevel = "ready" | "unconfigured" | "ephemeral" | "unwritable";

export interface StorageReadiness {
  level: StorageReadinessLevel;
  durable: boolean;
  production: boolean;
  /** أسباب مقروءة بلا مسارات كاملة (لا تسريب تفاصيل الخادم). */
  reasons: string[];
}

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.RAILWAY_PROJECT_ID);
}

function isEphemeralPath(rawEnv: string, resolved: string): boolean {
  // القيمة الخام قبل الحل: مسار نسبي = داخل مجلد التشغيل/الحاوية — مؤقّت بنيويًّا.
  if (!path.isAbsolute(rawEnv)) return true;
  const tmp = os.tmpdir();
  if (resolved === tmp || resolved.startsWith(tmp + path.sep)) return true;
  if (resolved.startsWith("/var/tmp") || resolved.startsWith("/dev/shm")) return true;
  return false;
}

export function evaluateStorageDurability(): StorageReadiness {
  const production = isProductionRuntime();
  const reasons: string[] = [];
  const raw = process.env.DOCUMENTS_DIR?.trim();

  if (!raw) {
    return {
      level: "unconfigured",
      durable: false,
      production,
      reasons: [
        production
          ? "حرج: DOCUMENTS_DIR غير مضبوط في بيئة إنتاج — رفع الأشعة مرفوض ولا يوجد تخزين دائم. اربط قرصًا دائمًا (Volume) واضبط المسار."
          : "تحذير تطوير: DOCUMENTS_DIR غير مضبوط — رفع الأشعة مرفوض حتى يُضبط.",
      ],
    };
  }

  const resolved = path.resolve(raw);
  if (isEphemeralPath(raw, resolved)) {
    reasons.push(
      `مسار التخزين (مؤقّت أو نسبي) لا يصلح للإنتاج: ${production ? "مرفوض" : "تحذير"} — ` +
      "اربط قرصًا دائمًا (مثل /data) واضبط DOCUMENTS_DIR=/data/documents.",
    );
    return { level: "ephemeral", durable: false, production, reasons };
  }

  return { level: "ready", durable: true, production, reasons };
}

/**
 * الفحص الحيّ: القرار أعلاه + فحص قائمة للكتابة فعليًا (probe من lib/files.ts
 * نفسه — نفس سلوك الرفع). النتيجة النهائية لبوابة readiness.
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
