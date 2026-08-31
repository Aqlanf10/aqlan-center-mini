import { describe, expect, it } from "vitest";

import {
  ALLOWED_FILE_MIMES,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_LENGTH,
  MAX_VOICE_BYTES,
  MAX_VOICE_MS,
  fileMatchesMagicBytes,
  formatFileSize,
  formatVoiceDuration,
  isAllowedFileMime,
  isAllowedVoiceMime,
  isBase64,
  messagePreview,
  normalizeVoiceMime,
  parseMessageId,
  parseMessageTarget,
  parseReplyToId,
  parseUrgentFlag,
  sanitizeFileName,
  validateMessageEdit,
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
  it("زميل ومريض بالرقم، والطاقم كلهم بلا رقم، والبثّ الجماعي بلا رقم", () => {
    expect(parseMessageTarget({ type: "user", id: 3 })).toEqual({ type: "user", id: 3 });
    expect(parseMessageTarget({ type: "patient", id: 7 })).toEqual({ type: "patient", id: 7 });
    expect(parseMessageTarget({ type: "staff_all" })).toEqual({ type: "staff_all" });
    expect(parseMessageTarget("staff_all")).toEqual({ type: "staff_all" });
    expect(parseMessageTarget({ type: "staff_broadcast" })).toEqual({ type: "staff_broadcast" });
    expect(parseMessageTarget("staff_broadcast")).toEqual({ type: "staff_broadcast" });
  });

  it("البثّ الجماعي بلا معرّف لا رقم زائد، ورسالة طاقم بلا رقم مرفوضة", () => {
    const broadcastTarget = parseMessageTarget({ type: "staff_broadcast", id: 5 });
    expect(broadcastTarget?.type).toBe("staff_broadcast");
    expect(broadcastTarget?.id).toBeUndefined();
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

describe("تحدي المرفقات — صور ومستندات", () => {
  const target: MessageTarget = { type: "patient", id: 4 };
  // رأس PNG صالح حقيقي (8 بايتات البصمة) مع حشوة صغيرة.
  const pngBase64 = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]).toString("base64");
  const jpegBase64 = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(20, 0x41),
  ]).toString("base64");
  const pdfBase64 = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.alloc(20, 0x42),
  ]).toString("base64");

  it("صورة PNG صالحة تمر باسمها وحجمها ووصفها", () => {
    const verdict = validateOutgoingMessage(target, {
      kind: "file", fileMime: "image/png", fileName: "أشعة بانورامية.png",
      fileSize: 12, fileData: pngBase64, body: "  صورتي الجديدة  ",
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.value.kind).toBe("file");
      expect(verdict.value.fileName).toBe("أشعة بانورامية.png");
      expect(verdict.value.fileSize).toBe(12);
      expect(verdict.value.body).toBe("صورتي الجديدة");
    }
  });

  it("PDF صالح يمر بلا وصف", () => {
    const verdict = validateOutgoingMessage(target, {
      kind: "file", fileMime: "application/pdf", fileName: "تقرير.pdf",
      fileData: pdfBase64,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value.body).toBeNull();
  });

  it("النوع غير المدرج مرفوض — لا SVG ولا تنفيذيات", () => {
    for (const mime of ["image/svg+xml", "application/x-msdownload", "text/html", "image/bmp"]) {
      const verdict = validateOutgoingMessage(target, {
        kind: "file", fileMime: mime, fileName: "x.png", fileData: pngBase64,
      });
      expect(verdict.ok).toBe(false);
    }
  });

  it("اسم الملف يُغسل من المسارات ومحارف التحكم", () => {
    expect(sanitizeFileName("/etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\secret.pdf")).toBe("secret.pdf");
    expect(sanitizeFileName("a\u0000b.png")).toBe("ab.png");
    expect(sanitizeFileName("   ")).toBe("");
    const long = `${"م".repeat(MAX_FILE_NAME_LENGTH + 30)}.png`;
    expect(sanitizeFileName(long).length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH + 4);
  });

  it("الملف فوق عشرة ميغابايت مرفوض من طول ترميزه", () => {
    const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_FILE_BYTES + 100)]).toString("base64");
    const verdict = validateOutgoingMessage(target, {
      kind: "file", fileMime: "image/jpeg", fileName: "big.jpg", fileData: huge,
    });
    expect(verdict.ok).toBe(false);
  });

  it("البصمة السحرية تمسك الخداع: امتداد صورة بجسم غير صورة", () => {
    // نص تنفيذي ينتحل اسم صورة PNG — البايتات تكذب الادعاء.
    const fakePng = Buffer.concat([Buffer.from("#!/bin/bash\n"), Buffer.alloc(24, 0x41)]).toString("base64");
    const verdict = validateOutgoingMessage(target, {
      kind: "file", fileMime: "image/png", fileName: "invoice.png", fileData: fakePng,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain("لا يطابق");
  });

  it("بصمات الصيغ الصحيحة كلها مقبولة، والمشوهة مرفوضة", () => {
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16)]).toString("base64");
    const webp = Buffer.concat([
      Buffer.from("RIFF"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WEBP"),
      Buffer.alloc(16),
    ]).toString("base64");
    expect(fileMatchesMagicBytes("image/png", pngBase64)).toBe(true);
    expect(fileMatchesMagicBytes("image/jpeg", jpegBase64)).toBe(true);
    expect(fileMatchesMagicBytes("image/gif", gif)).toBe(true);
    expect(fileMatchesMagicBytes("image/webp", webp)).toBe(true);
    expect(fileMatchesMagicBytes("application/pdf", pdfBase64)).toBe(true);
    expect(fileMatchesMagicBytes("image/png", jpegBase64)).toBe(false);
    expect(fileMatchesMagicBytes("application/pdf", pngBase64)).toBe(false);
    expect(fileMatchesMagicBytes("image/webm", "QUJD")).toBe(false);
  });

  it("قائمة الأنواع المسموحة مغلقة على الصور وPDF", () => {
    expect([...ALLOWED_FILE_MIMES]).toEqual([
      "image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf",
    ]);
    expect(isAllowedFileMime("IMAGE/PNG")).toBe(true);
    expect(isAllowedFileMime("application/pdf ")).toBe(true);
    expect(isAllowedFileMime("application/x-pdf")).toBe(false);
  });
});

describe("عرض المرفقات والمدد", () => {
  it("حجم الملف مقروء بالكيلو والميغا", () => {
    expect(formatFileSize(500)).toBe("1 KB");
    expect(formatFileSize(153_600)).toBe("154 KB");
    expect(formatFileSize(2_500_000)).toBe("2.5 MB");
  });

  it("معاينة المرفق تعرض نوعه واسمه", () => {
    expect(messagePreview("file", null, null, "أشعة.png")).toContain("أشعة.png");
    expect(messagePreview("file", null, null, null)).toBe("مرفق");
  });
});

describe("عاجلة المريض — علمٌ صريح لا تفسير", () => {
  it("الحقيقة الصريحة وحدها تشعلها", () => {
    expect(parseUrgentFlag(true)).toBe(true);
    expect(parseUrgentFlag(false)).toBe(false);
  });

  it("النصوص والأرقام والحقول الغريبة كلها عادية", () => {
    expect(parseUrgentFlag("true")).toBe(false);
    expect(parseUrgentFlag("yes")).toBe(false);
    expect(parseUrgentFlag(1)).toBe(false);
    expect(parseUrgentFlag("1")).toBe(false);
    expect(parseUrgentFlag(undefined)).toBe(false);
    expect(parseUrgentFlag(null)).toBe(false);
  });

  it("الرسالة النصية تحمل العلم إلى طبقة القاعدة", () => {
    const verdict = validateOutgoingMessage({ type: "staff_all" }, {
      kind: "text", body: "ألم شديد لا يحتمل", urgent: true,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value.urgent).toBe(true);
  });

  it("الإرسال من الطاقم لا يمرر العلم — العاجلة للمريض وحده، والجهة هنا لا تهمّ", () => {
    const verdict = validateOutgoingMessage({ type: "user", id: 2 }, {
      kind: "text", body: "رسالة عادية", urgent: true,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value.urgent).toBe(true);
  });
});

describe("معرّف الردّ — رقم موجب أو لا شيء", () => {
  it("الرقم الصحيح الموجب يمر", () => {
    expect(parseReplyToId(41)).toBe(41);
    expect(parseReplyToId("17")).toBe(17);
  });

  it("السالب والكسر والنص والفراغ تُهمَل لا تُفسد الإرسال", () => {
    expect(parseReplyToId(-3)).toBeNull();
    expect(parseReplyToId(2.5)).toBeNull();
    expect(parseReplyToId("abc")).toBeNull();
    expect(parseReplyToId(null)).toBeNull();
    expect(parseReplyToId(undefined)).toBeNull();
    expect(parseReplyToId(0)).toBeNull();
  });

  it("الردّ يرافق الرسالة النصية إلى القاعدة", () => {
    const verdict = validateOutgoingMessage({ type: "user", id: 2 }, {
      kind: "text", body: "ردّي على رسالتك", replyTo: 41,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value.replyToId).toBe(41);
  });

  it("المعرّف الغريب يُهمَل والرسالة تمر بلا ردّ", () => {
    const verdict = validateOutgoingMessage({ type: "user", id: 2 }, {
      kind: "text", body: "رسالة", replyTo: "غريب",
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value.replyToId).toBeNull();
  });
});

describe("تعديل الرسالة — نفس حدود الإرسال", () => {
  it("النص الصالح بمعرّف صحيح يمر", () => {
    const verdict = validateMessageEdit({ id: 12, body: "  نص معدّل  " });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.value.messageId).toBe(12);
      expect(verdict.value.body).toBe("نص معدّل");
    }
  });

  it("الفراغ والنص الطويل والمعرّف الغريب مرفوضة برسائل مفهومة", () => {
    const empty = validateMessageEdit({ id: 12, body: "   " });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toContain("اكتب");

    const tooLong = validateMessageEdit({ id: 12, body: "أ".repeat(4001) });
    expect(tooLong.ok).toBe(false);

    const badId = validateMessageEdit({ id: -1, body: "نص" });
    expect(badId.ok).toBe(false);
    const noId = validateMessageEdit({ body: "نص" });
    expect(noId.ok).toBe(false);
  });
});

describe("معرّف الرسالة للحذف", () => {
  it("رقم موجب يمر، وما عداه يُرفض", () => {
    expect(parseMessageId(99)).toBe(99);
    expect(parseMessageId("99")).toBe(99);
    expect(parseMessageId(0)).toBeNull();
    expect(parseMessageId(-5)).toBeNull();
    expect(parseMessageId(null)).toBeNull();
    expect(parseMessageId("xyz")).toBeNull();
  });
});

describe("معاينة المحادثة مع العاجلة والمحذوفة", () => {
  it("المحذوفة قبر ظاهر مهما كان جوهرها", () => {
    expect(messagePreview("text", "نص", null, null, { deleted: true })).toBe("رسالة محذوفة");
    expect(messagePreview("voice", null, 90_000, null, { deleted: true })).toBe("رسالة محذوفة");
    expect(
      messagePreview("text", "نص", null, null, { deleted: true, urgent: true }),
    ).toBe("🚨 عاجلة · رسالة محذوفة");
  });

  it("العاجلة تحمل شعارها قبل المعاينة أياً كان نوعها", () => {
    expect(messagePreview("text", "ألم شديد", null, null, { urgent: true }))
      .toBe("🚨 عاجلة · ألم شديد");
    expect(messagePreview("voice", null, 65_000, null, { urgent: true }))
      .toBe("🚨 عاجلة · رسالة صوتية 1:05");
    expect(messagePreview("file", null, null, "xray.png", { urgent: true }))
      .toContain("🚨 عاجلة · مرفق: xray.png");
  });

  it("العادية بلا شعار كما كانت", () => {
    expect(messagePreview("text", "سلام", null, null)).toBe("سلام");
  });
});
