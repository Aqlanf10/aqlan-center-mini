import { describe, expect, it } from "vitest";
import {
  friendlyDate, friendlyDateLong, friendlyTime, reminderNeedsOverride, reminderText,
  toWhatsAppNumber, whatsAppLink, bookingConfirmationText, postProcedureCareText, whatsAppDirectLink,
} from "../lib/reminders";

import type { Appointment } from "../lib/schedule";

const appointment: Appointment = {
  id: 1, patientId: 1, patientName: "عبدالله محمد", patientPhone: "770245745",
  scheduledDate: "2026-08-27", scheduledTime: "10:00", durationMinutes: 30,
  note: null, status: "booked",
};

describe("رقم واتساب اليمني", () => {
  it("يضيف مفتاح الدولة للرقم المحلي", () => {
    expect(toWhatsAppNumber("770245745")).toBe("967770245745");
    expect(toWhatsAppNumber("0770245745")).toBe("967770245745");
  });
  it("يقبل الرقم الدولي كما هو", () => {
    expect(toWhatsAppNumber("967770245745")).toBe("967770245745");
    expect(toWhatsAppNumber("+967 770 245 745")).toBe("967770245745");
  });
  it("يحوّل الأرقام العربية الهندية القادمة من لوحة مفاتيح الهاتف", () => {
    expect(toWhatsAppNumber("٧٧٠٢٤٥٧٤٥")).toBe("967770245745");
  });
  it("يرفض ما لا يصلح بدل فتح محادثة مع رقم خاطئ", () => {
    expect(toWhatsAppNumber("04253028")).toBeNull();  // أرضي
    expect(toWhatsAppNumber("12345")).toBeNull();
    expect(toWhatsAppNumber(null)).toBeNull();
    expect(toWhatsAppNumber("")).toBeNull();
  });
});

describe("صياغة الموعد للمريض", () => {
  it("يبدأ بيوم الأسبوع لأنه ما يتذكره المريض", () => {
    expect(friendlyDate("2026-08-27")).toContain("الخميس");
  });
  it("يكتب الوقت بصيغة يقرأها بلا حساب", () => {
    expect(friendlyTime("10:00")).toBe("10:00 صباحًا");
    expect(friendlyTime("16:30")).toBe("4:30 مساءً");
    expect(friendlyTime("12:15")).toBe("12:15 مساءً");
    expect(friendlyTime("00:30")).toBe("12:30 صباحًا");
  });
});

describe("نص الرسالة", () => {
  it("يذكر الاسم والموعد ويفتح باب التأجيل", () => {
    const text = reminderText(appointment, "upcoming");
    expect(text).toContain("عبدالله محمد");
    expect(text).toContain("الخميس");
    expect(text).toContain("10:00 صباحًا");
    // الجملة التي تحرّر الكرسي: من يستطيع التأجيل يعتذر بدل أن يتغيّب.
    expect(text).toContain("أخبرونا لنؤجله");
  });

  it("رسالة المتغيّب لا تلومه", () => {
    const text = reminderText(appointment, "missed");
    expect(text).toContain("افتقدناكم");
    expect(text).not.toContain("لم تحضر");
    expect(text).not.toContain("تخلفت");
  });
});

describe("الرابط", () => {
  it("يبني رابط واتساب صالحًا", () => {
    const link = whatsAppLink(appointment, "upcoming");
    expect(link).toContain("https://wa.me/967770245745?text=");
  });
  it("يعيد null بلا رقم صالح بدل رابط مكسور", () => {
    expect(whatsAppLink({ ...appointment, patientPhone: null }, "upcoming")).toBeNull();
    expect(whatsAppLink({ ...appointment, patientPhone: "04253028" }, "upcoming")).toBeNull();
  });
});

describe("تاريخ الملف", () => {
  it("يحمل السنة — ملف مريض تقويم فيه زيارات من سنتين", () => {
    expect(friendlyDateLong("2026-08-27")).toBe("الخميس 27/08/2026");
    expect(friendlyDateLong("2024-08-27")).toBe("الثلاثاء 27/08/2024");
  });
});

describe("قاعدة لا رسالة مكررة خلال ١٢ ساعة", () => {
  const now = Date.parse("2026-08-27T10:00:00Z");
  it("لا تسأل عن تذكير لم يُرسل قط", () => {
    expect(reminderNeedsOverride(null, now)).toBe(false);
    expect(reminderNeedsOverride(undefined, now)).toBe(false);
  });
  it("تطلب تأكيدًا قبل مرور النافذة — الضغطة المزدوجة رسالتان", () => {
    expect(reminderNeedsOverride("2026-08-27T09:59:00Z", now)).toBe(true);
    expect(reminderNeedsOverride("2026-08-26T22:00:01Z", now)).toBe(true);
  });
  it("تتجاوز ما بعد النافذة — المريض يستحق تذكيرًا جديدًا", () => {
    expect(reminderNeedsOverride("2026-08-26T22:00:00Z", now)).toBe(false);
    expect(reminderNeedsOverride("2026-08-20T10:00:00Z", now)).toBe(false);
  });
  it("لا تنهار بطابع تالف — التسامح هنا أرحم من تعطيل زر التذكير", () => {
    expect(reminderNeedsOverride("ليس تاريخًا", now)).toBe(false);
  });
});

describe("رسائل تأكيد الحجز والتعليمات السريرية", () => {
  it("تصيغ رسالة تأكيد الحجز بالتاريخ والوقت", () => {
    const text = bookingConfirmationText(appointment);
    expect(text).toContain("تم بنجاح تأكيد حجز موعدكم");
    expect(text).toContain("عبدالله محمد");
    expect(text).toContain("10:00 صباحًا");
  });

  it("تصيغ تعليمات ما بعد الخلع الجراحي بدقة", () => {
    const text = postProcedureCareText("عبدالله محمد", "extraction");
    expect(text).toContain("تعليمات وإرشادات هامة بعد خلع السن");
    expect(text).toContain("الشاش");
    expect(text).toContain("تجنب البصق");
  });

  it("تنشئ رابط واتساب مباشر للنص", () => {
    const link = whatsAppDirectLink("770245745", "مرحبًا بكم");
    expect(link).toBeTruthy();
    expect(link).toContain("https://wa.me/967770245745?text=");
  });
});

