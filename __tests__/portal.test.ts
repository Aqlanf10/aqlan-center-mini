import { describe, expect, it } from "vitest";

process.env.SESSION_SECRET = "x".repeat(48);

import { createSessionToken, readSessionToken } from "../lib/auth";
import {
  CONFIRM_WINDOW_DAYS,
  LOGIN_MAX_FAILURES,
  PORTAL_COOKIE,
  confirmVerdict,
  createPortalToken,
  loginLocked,
  portalCredentialsMatch,
  readPortalToken,
  toPortalAppointment,
  validateIntake,
  validatePortalLogin,
} from "../lib/portal";

/**
 * بوابة المريض — اختبارات العزل والقواعد.
 *
 * أهم سطر هنا ليس حسابًا: **توكن البوابة لا يقرأه قارئ الطاقم ولا العكس**.
 * العزل بالمجال التوقيعي لا بالمصادفة، واختباره يمنع أن يتحول إلى مطابقة شكل.
 */

describe("جلسة البوابة — العزل التوقيعي", () => {
  it("توكن البوابة يُقرأ بقرائها ويعطي حمولته", () => {
    const token = createPortalToken({
      patientId: 7, patientNumber: "P-0007", fullName: "مريض البوابة",
      expiresAt: Date.now() + 60_000,
    });
    const payload = readPortalToken(token);
    expect(payload?.patientId).toBe(7);
    expect(payload?.patientNumber).toBe("P-0007");
  });

  it("توكن الطاقم لا يفتح البوابة، وتوكن البوابة لا يفتح الطاقم", () => {
    const staffToken = createSessionToken({
      userId: 1, username: "admin", role: "admin", expiresAt: Date.now() + 60_000,
    });
    const portalToken = createPortalToken({
      patientId: 7, patientNumber: "P-0007", fullName: "مريض",
      expiresAt: Date.now() + 60_000,
    });
    // عكس الاتجاهين: كل قراء يرى توكنه فقط.
    expect(readPortalToken(staffToken)).toBeNull();
    expect(readSessionToken(portalToken)).toBeNull();
  });

  it("تزوير المحتوى بلا توقيع يسقط، والانتهاء يسقط", () => {
    const token = createPortalToken({
      patientId: 7, patientNumber: "P-0007", fullName: "مريض",
      expiresAt: Date.now() + 60_000,
    });
    const [body] = token.split(".");
    // تحويل patientId إلى 1 بلا إعادة توقيع.
    const forged = `${Buffer.from(JSON.stringify({
      patientId: 1, patientNumber: "P-0001", fullName: "X", expiresAt: Date.now() + 60_000,
    })).toString("base64url")}.${token.split(".")[1]}`;
    expect(readPortalToken(forged)).toBeNull();
    expect(readPortalToken(body)).toBeNull();
    const expired = createPortalToken({
      patientId: 7, patientNumber: "P-0007", fullName: "مريض", expiresAt: Date.now() - 1,
    });
    expect(readPortalToken(expired)).toBeNull();
  });

  it("اسم كوكي البوابة غير كوكي الطاقم", () => {
    expect(PORTAL_COOKIE).not.toBe("aqlan_flow_session");
  });
});

describe("دخول البوابة", () => {
  it("الهاتف القصير ورقم الملف الفارغ مرفوضان", () => {
    expect(validatePortalLogin({ phone: "12345", patientNumber: "P-1" }).ok).toBe(false);
    expect(validatePortalLogin({ phone: "777000000", patientNumber: "" }).ok).toBe(false);
    expect(validatePortalLogin({ phone: "777000000", patientNumber: "P-1" }).ok).toBe(true);
  });

  it("مطابقة الهاتف تستخدم منطق هواتف الملف نفسه، ورقم الملف بلا حساسية حالة", () => {
    const patient = { patientNumber: "p-0001", phone: "+967777000000", altPhone: null };
    expect(portalCredentialsMatch(patient, "777000000", "P-0001")).toBe(true);
    expect(portalCredentialsMatch(patient, "777111111", "P-0001")).toBe(false);
    expect(portalCredentialsMatch(patient, "777000000", "p-0001")).toBe(true);
    expect(portalCredentialsMatch(patient, "777000000", "P-9999")).toBe(false);
  });

  it("حد المحاولات: تحت الحد مفتوح، وعنده إغلاق حتى تنقضي أقدم محاولة", () => {
    const now = Date.now();
    const few = [now - 60_000, now - 50_000];
    expect(loginLocked(few, now)).toEqual({ locked: false, retryAfterSeconds: 0 });
    const many = Array.from({ length: LOGIN_MAX_FAILURES }, (_, index) => now - (index + 1) * 60_000);
    const lock = loginLocked(many, now);
    expect(lock.locked).toBe(true);
    expect(lock.retryAfterSeconds).toBeGreaterThan(0);
    // محاولات قديمة خارج النافذة لا تُحسب.
    const stale = many.map((time) => time - 16 * 60_000);
    expect(loginLocked(stale, now).locked).toBe(false);
  });
});

describe("تأكيد الحضور", () => {
  const TODAY = "2026-08-30";

  it("موعد مؤكد القيد مستقبلي يؤكد، وغيره يُرفض بسبب واضح", () => {
    expect(confirmVerdict({ status: "booked", scheduledDate: "2026-09-02" }, TODAY)).toEqual({ ok: true });
    expect(confirmVerdict({ status: "cancelled", scheduledDate: "2026-09-02" }, TODAY))
      .toEqual({ ok: false, reason: "not_booked" });
    expect(confirmVerdict({ status: "booked", scheduledDate: "2026-08-29" }, TODAY))
      .toEqual({ ok: false, reason: "past" });
  });

  it("حد الثلاثين يومًا: قبل الحد يقبل وفقط بعده يرفض", () => {
    const edge = addDaysLocal(TODAY, CONFIRM_WINDOW_DAYS);
    expect(confirmVerdict({ status: "booked", scheduledDate: edge }, TODAY).ok).toBe(true);
    expect(confirmVerdict({ status: "booked", scheduledDate: addDaysLocal(TODAY, CONFIRM_WINDOW_DAYS + 1) }, TODAY))
      .toEqual({ ok: false, reason: "too_far" });
  });

  function addDaysLocal(date: string, days: number): string {
    const parsed = new Date(`${date}T00:00:00Z`);
    parsed.setUTCDate(parsed.getUTCDate() + days);
    return parsed.toISOString().slice(0, 10);
  }

  it("عرض الموعد: المؤكد يظهر بعلامته، والمؤكد-قيد وحده قابل للتأكيد", () => {
    const appointment = {
      id: 3, scheduledDate: "2026-09-02", scheduledTime: "10:30", durationMinutes: 30,
      appointmentType: "شد", note: null, status: "booked",
    };
    const view = toPortalAppointment(appointment, null, TODAY);
    expect(view.confirmable).toBe(true);
    const confirmed = toPortalAppointment(appointment, "2026-08-29T09:00:00.000Z", TODAY);
    expect(confirmed.confirmable).toBe(false);
    expect(confirmed.patientConfirmedAt).toBe("2026-08-29T09:00:00.000Z");
    const cancelled = toPortalAppointment({ ...appointment, status: "cancelled" }, null, TODAY);
    expect(cancelled.confirmable).toBe(false);
  });
});

describe("الاستمارة الصحية", () => {
  it("مفتاح حالة غير معروف يُرفض، والمكرر يُنزع", () => {
    const bad = validateIntake({ conditions: ["mystery"] });
    expect(bad.ok).toBe(false);
    const good = validateIntake({ conditions: ["diabetes", "diabetes", "asthma"] });
    expect(good.ok && good.value.conditions).toEqual(["diabetes", "asthma"]);
  });

  it("النصوص تُقلَّم فراغاتها وتُسقَّف أطوالها، والفراغ يصير null", () => {
    const result = validateIntake({
      conditions: [], allergies: "  بنسلين  ", medications: "   ", emergencyName: "", emergencyPhone: null, note: "—",
    });
    expect(result.ok && result.value.allergies).toBe("بنسلين");
    expect(result.ok && result.value.medications).toBeNull();
    expect(result.ok && result.value.emergencyName).toBeNull();
  });

  it("هاتف طوارئ قصير يُرفض", () => {
    const result = validateIntake({ emergencyPhone: "123" });
    expect(result.ok).toBe(false);
  });
});
