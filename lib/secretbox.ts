/**
 * صندوق الأسرار — تشفير متناظر لقيم لا يجوز تخزينها نصًّا صريحًا.
 *
 * أول مستفيد منها مفتاح خدمة الذكاء الاصطناعي: قيمةٌ يملكها المالك وحده، وإذا
 * تسرّبت من قاعدة البيانات — نسخة احتياطية مسروقة، تصدير، خطأ في صلاحية — يجب أن
 * تكون مجرد سطر مشفّر لا مفتاحًا يعمل. **ولا يعتمد ذلك على إخفائه في الواجهة**:
 * الإخفاء في الشاشة راحةٌ للعين، والتشفير هو الحماية الفعلية.
 *
 * AES-256-GCM: تشفير مصادق عليه — أي تعديل بايت واحد في النص المشفّر أو الـ IV
 * يُكشف عند فك التشفير ويرمي خطأً، لا أن يعيد قيمة تالفة بصمت.
 *
 * مفتاح التشفير **مشتق** من SESSION_SECRET بـ scrypt وملح ثابت خاص بهذا الغرض:
 * لا يُخزَّن مفتاحٌ ثانٍ في مكان ثانٍ يجب مزامنته، ودوران SESSION_SECRET يجعل
 * النصوص المشفّرة القديمة غير قابلة للفك — وهذا مقصود: غيّر السرّ يعيد إدخال
 * مفتاح الخدمة مرة واحدة.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/** ملح الاشتقاق ثابت عمدًا: نفس السرّ يجب أن يشتق نفس مفتاح التشفير في كل إقلاع. */
const KEY_SALT = "aqlan-secretbox-v1";
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM القياسي

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET مفقود أو قصير — يجب ألا يقل عن 32 حرفًا.");
  }
  return value;
}

function derivedKey(): Buffer {
  return scryptSync(secret(), KEY_SALT, KEY_LENGTH);
}

/** شكل النص المخزَّن: iv.tag.ciphertext — كلها base64url. */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) throw new Error("لا يُشفَّر نص فارغ.");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** يعيد النص الأصلي أو يرمي خطأً — التلاعب لا يعيد قيمة، بل يُكشف. */
export function decryptSecret(encrypted: string): string {
  const parts = encrypted.split(".");
  if (parts.length !== 3) throw new Error("نص مشفّر بصيغة غير معروفة.");
  const [iv, tag, ciphertext] = parts;
  const decipher = createDecipheriv("aes-256-gcm", derivedKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * بصمة العرض: لا تُظهر المفتاح في أي شاشة — الأولى والثانية تُعرَفان بغدًا بعد
 * الدخول، والبصمة هنا حتى يميّز المالك المفتاح المُدخل من غيره دون أن يُقرأ أي منهما.
 */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  const head = trimmed.slice(0, 4);
  const tail = trimmed.slice(-4);
  if (trimmed.length <= 8) return `${head}••••`;
  return `${head}••••••••${tail}`;
}
