/**
 * التحقق من بصمة المحتوى (magic bytes) — P2/S9.
 *
 * المشكلة: التحقق الحالي يعتمد على MIME Type الذي **يكتبه العميل** في
 * ترويسة multipart. ملف تنفيذي باسم image/png ومحتوى خبيث يمرّ إلى
 * التخزين، ثم يُقدَّم للطبيب بالمُمَوّه نفسه — والمتصفح بلا nosniff يعيده
 * وفق المُمَوّه. الحل: فحص بايتات الملف الفعلية قبل الحفظ.
 *
 * الفحص هنا خفيف عمدًا: بصمة الرأس المنطقية لكل نوع مسموح، بلا parser
 * ثقيل — الهدف تمييز «هذا فعلًا JPEG/PNG/WebP/PDF» لا التحقق الكامل من
 * سلامة الملف (ذلك عمل عارض الملفات، ومسؤولية مضاعفة لا تشتري أمنًا هنا).
 *
 * الاسم الأصلي من العميل لا يُخزَّن أصلًا — التخزين content-addressed
 * بمفتاح sha256 (lib/storage.ts) — وهذا باقٍ كما هو.
 */

/**
 * هل بايتات الملف تطابق نوع MIME المعلن؟
 * أي تنافر (المُمَوّه صورة والمحتوى تنفيذي/نص) ⇒ false.
 */
export function contentMatchesMimeType(bytes: Buffer, mimeType: string): boolean {
  if (!bytes || bytes.length < 12) return false; // أقصر ملف مشروع أكبر من هذا.

  switch (mimeType) {
    case "image/jpeg":
      // SOI + بداية marker: FF D8 FF — بصمة JPEG العالمية.
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

    case "image/png": {
      // 89 50 4E 47 0D 0A 1A 0A ثم chunk IHDR — البصمة + بنية منطقية.
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (!bytes.subarray(0, 8).equals(signature)) return false;
      // أول chunk بعد البصمة: طول 4 بايت + النوع "IHDR".
      const chunkType = bytes.subarray(12, 16).toString("latin1");
      return chunkType === "IHDR";
    }

    case "image/webp": {
      // RIFF + حجم + WEBP.
      if (bytes.toString("latin1", 0, 4) !== "RIFF") return false;
      if (bytes.toString("latin1", 8, 12) !== "WEBP") return false;
      const declaredSize = bytes.readUInt32LE(4);
      // حجم الحاكم المعلن منطقي مع ما وصل فعلًا (بما يتسع ترويساتها 12).
      return declaredSize > 0 && declaredSize <= bytes.length - 8;
    }

    case "application/pdf": {
      // %PDF-1.x في أول البايتات + %%EOF في الذيل — بصمتا البداية والنهاية
      // اللتان لا يقوم بدونهما PDF سليم (بمواصفة PDF نفسها). بلا parser ثقيل.
      const head = bytes.toString("latin1", 0, 9);
      if (!/^%PDF-1\.\d/.test(head)) return false;
      const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1");
      return tail.includes("%%EOF");
    }

    default:
      // نوع غير ضمن القائمة المغلقة أصلًا — يرفضه validateUpload قبله.
      return false;
  }
}

/** رسالة عربية موحدة للرفض — تُدمج في رد المسار. */
export const SIGNATURE_MISMATCH_MESSAGE =
  "محتوى الملف لا يطابق نوعه المعلن. ارفع ملف JPEG أو PNG أو WebP أو PDF سليمًا.";
