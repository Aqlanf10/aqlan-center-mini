import { describe, expect, it } from "vitest";
import {
  MAX_ANNOUNCEMENTS_COUNT,
  MAX_ANNOUNCEMENT_BODY_LENGTH,
  MAX_ANNOUNCEMENT_TITLE_LENGTH,
  cleanAnnouncementBody,
  cleanAnnouncementTitle,
  parseAnnouncementId,
  parseAnnouncementReorder,
  parseAnnouncementsForMigration,
  sanitizeAnnouncementText,
  validateAnnouncementInput,
  validateAnnouncementPatch,
} from "../lib/waiting-room";

/**
 * إعلانات الصالة المنظّمة — حدود السجل الواحد قبل القاعدة.
 *
 * كل حدٍّ هنا يحمي شاشةً أو بيانًا: العنوان الفارغ يُعرض فراغًا على التلفاز،
 * والوسم المخزن غفلةً يظهر يوم يُعرض النص في سياقٍ آخر، وقائمة الترتيب
 * الناقصة تدفن إعلانًا جديدًا في ترتيبٍ لم يُسأل عنه.
 */

describe("غسل نصّ الإعلان", () => {
  it("يقصّ الأطراف ويجمع الفراغات المتكررة", () => {
    expect(sanitizeAnnouncementText("  الالتزام   بالمطاط  ")).toBe("الالتزام بالمطاط");
  });

  it("ينزع وسوم HTML كلها — ما يُخزَّن نصٌّ خالص لا سلاح نائم", () => {
    expect(sanitizeAnnouncementText("<b>عاجل</b>: <script>alert(1)</script>الوقت")).toBe(
      "عاجل: alert(1)الوقت",
    );
  });

  it("ينزع محارف التحكم والمحارف الاتجاهية الخفية — قلبُ السطر خدعةٌ معروفة", () => {
    expect(sanitizeAnnouncementText("عاجل\u202Eمستقبل")).toBe("عاجلمستقبل");
    expect(sanitizeAnnouncementText("نص\u0000مع محرف تحكم")).toBe("نصمع محرف تحكم");
    expect(sanitizeAnnouncementText("بدون\u200B فاصل صفري")).toBe("بدون فاصل صفري");
  });

  it("يبقي السطر الواحد سطرًا واحدًا ويجمع الفارغة المتتالية", () => {
    expect(sanitizeAnnouncementText("سطر\n\n\nثانٍ")).toBe("سطر\nثانٍ");
  });
});

describe("حدود العنوان والنص", () => {
  it("العنوان سطرٌ واحد: الأسطر المتعددة تصبح فراغًا واحدًا", () => {
    const verdict = cleanAnnouncementTitle("عنوان\nعلى سطرين");
    expect(verdict.ok && verdict.value).toBe("عنوان على سطرين");
  });

  it("الفراغ بعد الغسل مرفوض برسالةٍ تأمر بالكتابة", () => {
    const verdict = cleanAnnouncementTitle("   <b></b>   ");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain("اكتب");
  });

  it("الحدّ على النص بعد الغسل لا قبله — الوسوم لا تُحسب حروفًا", () => {
    const padded = `${"م".repeat(70)}<b>وسم</b>`;
    const verdict = cleanAnnouncementTitle(padded);
    expect(verdict.ok && verdict.value.length).toBe(73); // ٧٠ حرفًا + «وسم» بعد نزع الوسمين
    expect(verdict.ok && verdict.value).not.toContain("<");
  });

  it("تجاوز الحدّ يُرفض ويقول الطول الحالي — الرسالة تسمّي الرقم", () => {
    const longTitle = "م".repeat(MAX_ANNOUNCEMENT_TITLE_LENGTH + 1);
    const verdict = cleanAnnouncementTitle(longTitle);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain(String(MAX_ANNOUNCEMENT_TITLE_LENGTH));

    const longBody = "ن".repeat(MAX_ANNOUNCEMENT_BODY_LENGTH + 1);
    const bodyVerdict = cleanAnnouncementBody(longBody);
    expect(bodyVerdict.ok).toBe(false);
    if (!bodyVerdict.ok) expect(bodyVerdict.message).toContain(String(MAX_ANNOUNCEMENT_BODY_LENGTH));
  });

  it("الحدّ نفسه مقبول — الحدُّ ليس أقل بواحد", () => {
    expect(cleanAnnouncementTitle("م".repeat(MAX_ANNOUNCEMENT_TITLE_LENGTH)).ok).toBe(true);
    expect(cleanAnnouncementBody("ن".repeat(MAX_ANNOUNCEMENT_BODY_LENGTH)).ok).toBe(true);
  });
});

describe("تحدي الإعلان الجديد", () => {
  it("الصالح يمر مقصوصًا ومغسولًا", () => {
    const verdict = validateAnnouncementInput({
      title: "  العناية بعد التقويم  ",
      body: "<i>الالتزام</i> بالمطاط حسب تعليمات الطبيب.",
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.value.title).toBe("العناية بعد التقويم");
      expect(verdict.value.body).toBe("الالتزام بالمطاط حسب تعليمات الطبيب.");
    }
  });

  it("النقص والأنواع الغريبة مرفوضة", () => {
    expect(validateAnnouncementInput({ title: "عنوان", body: "" }).ok).toBe(false);
    expect(validateAnnouncementInput({ title: "", body: "نص" }).ok).toBe(false);
    expect(validateAnnouncementInput({ title: 42, body: "نص" }).ok).toBe(false);
    expect(validateAnnouncementInput({ title: "عنوان" }).ok).toBe(false);
  });
});

describe("تحدي التعديل الجزئي", () => {
  it("الحقل المُرسَل وحده يمر والباقي لا يُلمس", () => {
    const verdict = validateAnnouncementPatch({ isActive: false });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.value).toEqual({ isActive: false });
      expect(verdict.value.title).toBeUndefined();
    }
  });

  it("تعديل العنوان وحده جائز — النص القديم يبقى", () => {
    const verdict = validateAnnouncementPatch({ title: "عنوان جديد" });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value).toEqual({ title: "عنوان جديد" });
  });

  it("الفراغ التام والأنواع الغريبة مرفوضة برسائل مفهومة", () => {
    expect(validateAnnouncementPatch({}).ok).toBe(false);
    expect(validateAnnouncementPatch({ isActive: "نعم" }).ok).toBe(false);
    expect(validateAnnouncementPatch({ title: "   " }).ok).toBe(false);
  });

  it("العنوان الفارغ في التعديل مرفوض — لا يُمحى عنوان إعلانٍ قائم", () => {
    const verdict = validateAnnouncementPatch({ title: "" });
    expect(verdict.ok).toBe(false);
  });
});

describe("معرّف الإعلان", () => {
  it("الرقم الموجب يمر نصًّا أو رقمًا", () => {
    expect(parseAnnouncementId(7)).toBe(7);
    expect(parseAnnouncementId("7")).toBe(7);
  });

  it("السالب والصفر والكسر والنص والفراغ مرفوضة", () => {
    expect(parseAnnouncementId(0)).toBeNull();
    expect(parseAnnouncementId(-3)).toBeNull();
    expect(parseAnnouncementId(2.5)).toBeNull();
    expect(parseAnnouncementId("abc")).toBeNull();
    expect(parseAnnouncementId(null)).toBeNull();
  });
});

describe("قائمة إعادة الترتيب", () => {
  it("أرقام فريدة موجبة تمر بالترتيب المُرسَل", () => {
    expect(parseAnnouncementReorder([3, 1, 2])).toEqual([3, 1, 2]);
    expect(parseAnnouncementReorder(["5", "9"])).toEqual([5, 9]);
  });

  it("التكرار والفراغ والغريب والكسور تُرفض القائمة كلها", () => {
    expect(parseAnnouncementReorder([1, 1])).toBeNull();
    expect(parseAnnouncementReorder([])).toBeNull();
    expect(parseAnnouncementReorder("1,2")).toBeNull();
    expect(parseAnnouncementReorder([1, "x"])).toBeNull();
    expect(parseAnnouncementReorder([1, -2])).toBeNull();
    expect(parseAnnouncementReorder(null)).toBeNull();
  });
});

describe("قارئ الترحيلة — لا يضيع إعلان", () => {
  it("كل سطرٍ صالح يصبح إعلانًا ولو تجاوز عشرة — الترحيلة لا تعرف سقف العشرة", () => {
    const fifteen = Array.from({ length: 15 }, (_, index) => `إعلان ${index + 1} | نص ${index + 1}`);
    const parsed = parseAnnouncementsForMigration(fifteen.join("\n"));
    expect(parsed).toHaveLength(15);
    expect(parsed[0]).toEqual({ title: "إعلان 1", body: "نص 1" });
  });

  it("السطر التالف والفارغ يُتخطيان والبقية تسلم", () => {
    const parsed = parseAnnouncementsForMigration(
      "سطر بلا فاصل\nعنوان | نص سليم\n\n| بلا عنوان\nآخر | نص | فيه فواصل",
    );
    expect(parsed).toEqual([
      { title: "عنوان", body: "نص سليم" },
      { title: "آخر", body: "نص | فيه فواصل" },
    ]);
  });

  it("الغسل يجري على المهجَّر أيضًا — لا يهاجر وسمٌ ولا محرف تحكم", () => {
    const parsed = parseAnnouncementsForMigration("<b>عنوان</b> | نص\u202Eمعاد");
    expect(parsed[0]).toEqual({ title: "عنوان", body: "نصمعاد" });
  });

  it("الفراغ والعدم يعنيان: لا شيء يستحق الترحيل", () => {
    expect(parseAnnouncementsForMigration("")).toEqual([]);
    expect(parseAnnouncementsForMigration(null)).toEqual([]);
    expect(parseAnnouncementsForMigration("   ")).toEqual([]);
  });

  it("النص الطويل جدًا يُقصّ عند الحدّ الجديد لا يُرفض — الترحيلة لا تخسر سليمًا", () => {
    const parsed = parseAnnouncementsForMigration(`عنوان | ${"ن".repeat(MAX_ANNOUNCEMENT_BODY_LENGTH + 50)}`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.body.length).toBe(MAX_ANNOUNCEMENT_BODY_LENGTH);
  });
});

describe("سقف القائمة", () => {
  it("السقف الوقائي كبير لا صغير — يمرّ خمسون ومئة بلا اعتراض", () => {
    expect(MAX_ANNOUNCEMENTS_COUNT).toBeGreaterThanOrEqual(100);
    // الحدود المنشورة التي تظهر في عدّادات الواجهة.
    expect(MAX_ANNOUNCEMENT_TITLE_LENGTH).toBe(80);
    expect(MAX_ANNOUNCEMENT_BODY_LENGTH).toBe(300);
  });
});
