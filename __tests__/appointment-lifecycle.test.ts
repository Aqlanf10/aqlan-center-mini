import { describe, expect, it } from "vitest";
import {
  ALLOWED_FROM,
  APPOINTMENT_STATUSES,
  STATUS_LABEL,
  allowedSources,
  canTransition,
  isTerminal,
  reasonAcceptable,
  rejectionMessage,
  requiresReason,
  transitionAction,
} from "@/lib/appointment-lifecycle";
import type { AppointmentStatus } from "@/lib/schedule";

/**
 * قانون دورة حياة الموعد.
 *
 * ما يُثبَت هنا ليس «هل الدالّة تعمل» بل **ما الذي لا يجوز**: أنّ موعدًا انتهى لا
 * يُعاد فتحه بأيّ طريق. وفي عيادةٍ تُحاسِب أطباءها على ما تمّ، قلبُ «لم يحضر» إلى
 * «تمّت» بعد أسبوع ليس تصحيحًا — هو مالٌ يتحرّك بلا أثر.
 */

const TERMINALS: AppointmentStatus[] = ["done", "cancelled", "no_show"];

describe("النهائيّ لا يُفتح", () => {
  it.each(TERMINALS)("«%s» لا يقبل أيّ انتقالٍ بعده", (from) => {
    for (const to of APPOINTMENT_STATUSES) {
      expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
    }
  });

  it("والثلاثة نهائيّة، و«محجوز» و«وصل» ليسا كذلك", () => {
    for (const status of TERMINALS) expect(isTerminal(status)).toBe(true);
    expect(isTerminal("booked")).toBe(false);
    expect(isTerminal("arrived")).toBe(false);
  });

  it("لا يُعاد الموعد إلى «محجوز» من أيّ حال", () => {
    expect(ALLOWED_FROM.booked).toEqual([]);
    for (const from of APPOINTMENT_STATUSES) {
      expect(canTransition(from, "booked"), `${from} → booked`).toBe(false);
    }
  });
});

describe("الانتقالات المشروعة", () => {
  it.each([
    ["booked", "arrived"],
    ["booked", "cancelled"],
    ["booked", "no_show"],
    ["booked", "done"],
    ["arrived", "done"],
  ] as const)("«%s» → «%s» جائز", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it("«وصل» لا يُلغى ولا يُعدّ متغيّبًا — المريض في الصالة فعلًا", () => {
    expect(canTransition("arrived", "cancelled")).toBe(false);
    expect(canTransition("arrived", "no_show")).toBe(false);
  });

  it("«تمّت» تُقبل من «محجوز» — وهو باب إغلاق المواعيد المعلّقة", () => {
    expect(allowedSources("done")).toContain("booked");
    expect(allowedSources("done")).toContain("arrived");
  });

  it("الانتقال إلى الحال نفسها ليس انتقالًا", () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });
});

describe("سبب الإلغاء", () => {
  it("مطلوبٌ للإلغاء وحده", () => {
    expect(requiresReason("cancelled")).toBe(true);
    for (const status of ["arrived", "done", "no_show"] as AppointmentStatus[]) {
      expect(requiresReason(status), status).toBe(false);
    }
  });

  it("والفراغات ليست سببًا", () => {
    expect(reasonAcceptable("   ")).toBe(false);
    expect(reasonAcceptable("")).toBe(false);
    expect(reasonAcceptable(null)).toBe(false);
    expect(reasonAcceptable(undefined)).toBe(false);
    expect(reasonAcceptable("ا")).toBe(false);
    expect(reasonAcceptable("اتصل المريض واعتذر")).toBe(true);
  });
});

describe("رسالة الرفض تقول ما جرى", () => {
  it("النهائيّ يُقال إنه نهائيّ ويُعرض البديل", () => {
    const message = rejectionMessage("done", "arrived");
    expect(message).toContain("تمّت");
    expect(message).toContain("موعدًا جديدًا");
  });

  it("والحال نفسها تُقال كما هي لا كخطأ", () => {
    expect(rejectionMessage("arrived", "arrived")).toBe("الموعد وصل أصلًا.");
  });

  it("ولكل حالٍ اسمٌ عربيّ — لا يظهر مصطلحٌ إنجليزيّ للمستخدم", () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(STATUS_LABEL[status]).toMatch(/[؀-ۿ]/);
    }
    expect(rejectionMessage("booked", "booked")).not.toMatch(/[a-z_]{4,}/);
  });
});

describe("فعل التدقيق", () => {
  it("فعلٌ مستقلّ لكل حال، فيُستخرج بلا خلط", () => {
    expect(transitionAction("cancelled")).toBe("appointment.cancelled");
    expect(new Set(APPOINTMENT_STATUSES.map(transitionAction)).size)
      .toBe(APPOINTMENT_STATUSES.length);
  });
});
