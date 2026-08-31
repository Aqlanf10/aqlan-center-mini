import { describe, expect, it } from "vitest";

import {
  MAX_VOICE_BYTES,
  MAX_VOICE_MS,
  formatVoiceDuration,
  isAllowedVoiceMime,
  isBase64,
  messagePreview,
  normalizeVoiceMime,
  parseMessageTarget,
  validateOutgoingMessage,
  type MessageTarget,
} from "../lib/messages";

/**
 * قواعد المراسلة — الحدود والتحدي قبل القاعدة.
 *
 * كل حدٍّ هنا يحمي قاعدةً أو شاشة: الصوت بلا نوع مرفوض قبل أن يُخزن، والحجم
 * الفجّ يُحسب من طول Base64 لا من ادّعاء العميل، والجهة بلا رقم لا تمرّ.
 */

describe("تحديد جهة الرسالة", () => {
  it("زميل ومريض بالرقم، والطاقم كلهم بلا رقم", () => {
    expect(parseMessageTarget({ type: "user", id: 3 })).toEqual({ type: "user", id: 3 });
    expect(parseMessageTarget({ type: "patient", id: 7 })).toEqual({ type: "patient", id: 7 });
    expect(parseMessageTarget({ type: "staff_all" })).toEqual({ type: "staff_all" });
    expect(parseMessageTarget("staff_all")).toEqual({ type: "staff_all" });
  });

  it("ما عدا ذلك مرفوض: بلا رقم، أو رقم سالب، أو نوع غريب", () => {
    expect(parseMessageTarget({ type: "user" })).toBeNull();
    expect(parseMessageTarget({ type: "patient", id: 0 })).toBeNull();
    expect(parseMessageTarget({ type: "patient", id: -2 })).toBeNull();
    expect(parseMessageTarget({ type: "printer" })).toBeNull();
    expect(parseMessageTarget(null)).toBeNull();
    expect(parseMessageTarget(42)).toBeNull();
    expect(parseMessageTarget("user:3")).toBeNull();
  });
});

describe("تحدي الرسائل النصية", () => {
  const target: MessageTarget = { type: "user", id: 2 };

  it("النص الصالح يمر مقصوصًا من الأطراف", () => {
    const verdict = validateOutgoingMessage(target, { kind: "text", body: "  صباح الخير  " });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value.body).toBe("صباح الخير");
  });

  it("الفراغ يُرفض برسالة مفهومة", () => {
    const verdict = validateOutgoingMessage(target, { kind: "text", body: "   " });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain("اكتب");
  });

  it("النص الأطول من الحد مرفوض", () => {
    const verdict = validateOutgoingMessage(target, { kind: "text", body: "أ".repeat(4001) });
    expect(verdict.ok).toBe(false);
  });
});

describe("تحدي الرسائل الصوتية", () => {
  const target: MessageTarget = { type: "staff_all" };
  // بايت صالحة بلا معنى: 'QUJD' هي ABC بعد الترميز.
  const validBase64 = "QUJD";

  it("الصوت الصالح يمر بنوع مطوَّع وبمدة محدودة", () => {
    const verdict = validateOutgoingMessage(target, {
      kind: "voice", voiceMime: "audio/webm;codecs=opus", voiceData: validBase64, voiceMs: 4000,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.value.voiceMime).toBe("audio/webm");
      expect(verdict.value.voiceMs).toBe(4000);
      expect(verdict.value.kind).toBe("voice");
    }
  });

  it("المدة فوق الحد تُقصّ إلى الحد لا تُرفض — التسجيل أُخذ فعلًا", () => {
    const verdict = validateOutgoingMessage(target, {
      kind: "voice", voiceMime: "audio/mp4", voiceData: validBase64, voiceMs: MAX_VOICE_MS + 9999,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value.voiceMs).toBe(MAX_VOICE_MS);
  });

  it("النوع غير المدعوم مرفوض", () => {
    const verdict = validateOutgoingMessage(target, {
      kind: "voice", voiceMime: "video/mp4", voiceData: validBase64, voiceMs: 3000,
    });
    expect(verdict.ok).toBe(false);
  });

  it("Base64 غير الصالح مرفوض", () => {
    const verdict = validateOutgoingMessage(target, {
      kind: "voice", voiceMime: "audio/webm", voiceData: "ليس-ترميزا", voiceMs: 3000,
    });
    expect(verdict.ok).toBe(false);
  });

  it("الملف فوق حد الحجم مرفوض من طول ترميزه لا من قوله", () => {
    const huge = "A".repeat(Math.ceil((MAX_VOICE_BYTES / 3) * 4) + 4);
    const verdict = validateOutgoingMessage(target, {
      kind: "voice", voiceMime: "audio/webm", voiceData: huge, voiceMs: 3000,
    });
    expect(verdict.ok).toBe(false);
  });

  it("المدة الصفرية مرفوضة", () => {
    const verdict = validateOutgoingMessage(target, {
      kind: "voice", voiceMime: "audio/webm", voiceData: validBase64, voiceMs: 0,
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("أنواع الصوت والترميز", () => {
  it("لواحق الترميز تُقصف عند التطبيع", () => {
    expect(normalizeVoiceMime("AUDIO/WEBM;codecs=opus")).toBe("audio/webm");
    expect(normalizeVoiceMime(" audio/mp4 ")).toBe("audio/mp4");
  });

  it("أنواع التسجيل المعروفة مقبولة كلها", () => {
    for (const mime of ["audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/aac"]) {
      expect(isAllowedVoiceMime(mime)).toBe(true);
    }
  });

  it("ما ليس صوتًا مرفوض", () => {
    expect(isAllowedVoiceMime("video/webm")).toBe(false);
    expect(isAllowedVoiceMime("audio/flac")).toBe(false);
    expect(isAllowedVoiceMime("")).toBe(false);
  });
});

describe("Base64", () => {
  it("يقبل الصحيح ويرفض المشوه", () => {
    expect(isBase64("QUJD")).toBe(true);
    expect(isBase64("")).toBe(false);
    expect(isBase64("ABC")).toBe(false);
    expect(isBase64("AB==")).toBe(true);
    expect(isBase64("A B C")).toBe(false);
  });
});

describe("العرض", () => {
  it("المدة المقروءة بالدقائق والثواني", () => {
    expect(formatVoiceDuration(0)).toBe("0:00");
    expect(formatVoiceDuration(65_000)).toBe("1:05");
    expect(formatVoiceDuration(120_000)).toBe("2:00");
  });

  it("معاينة المحادثة: الصوت مدته والنص مقتطع", () => {
    expect(messagePreview("voice", null, 65_000)).toContain("1:05");
    const long = "نص طويل ".repeat(20);
    expect(messagePreview("text", long, null).length).toBeLessThanOrEqual(60);
  });
});
