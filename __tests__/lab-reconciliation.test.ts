import { describe, expect, it } from "vitest";
import {
  reconcileLabStatement,
  buildBatchSettlementNote,
  detectLabAppointmentMismatches,
  type ReconcileOrderItem,
} from "../lib/lab-reconciliation";
import type { Appointment } from "../lib/schedule";
import type { LabOrder } from "../lib/lab";

describe("lib/lab-reconciliation (Lab Statement Reconciliation & Delivery Alerts)", () => {
  const sampleItems: ReconcileOrderItem[] = [
    {
      orderId: 101,
      patientName: "علي محمد",
      workType: "تاج زيركون",
      sentDate: "2026-09-01",
      dueDate: "2026-09-05",
      systemCostMinor: 25000,
      currency: "YER",
      status: "received",
      financialStatus: "payable_created",
    },
    {
      orderId: 102,
      patientName: "فاطمة أحمد",
      workType: "جسر خزف 3 وحدات",
      sentDate: "2026-09-02",
      dueDate: "2026-09-06",
      systemCostMinor: 60000,
      currency: "YER",
      status: "received",
      financialStatus: "payable_created",
    },
    {
      orderId: 103,
      patientName: "سالم سعيد",
      workType: "حارس ليلي Nightguard",
      sentDate: "2026-09-03",
      dueDate: "2026-09-07",
      systemCostMinor: 15000,
      currency: "YER",
      status: "delivered",
      financialStatus: "payable_created",
    },
  ];

  it("reconciles matching orders without discrepancies", () => {
    const result = reconcileLabStatement({
      partyId: 5,
      partyName: "مختبر النخبة لطب الأسنان",
      currency: "YER",
      items: sampleItems,
      selectedIds: [101, 102],
    });

    expect(result.totalOrdersCount).toBe(2);
    expect(result.totalSystemCostMinor).toBe(85000);
    expect(result.totalClaimedCostMinor).toBe(85000);
    expect(result.varianceMinor).toBe(0);
    expect(result.hasDiscrepancy).toBe(false);
    expect(result.discrepancies.length).toBe(0);
  });

  it("identifies custom claimed cost discrepancies accurately", () => {
    const result = reconcileLabStatement({
      partyId: 5,
      partyName: "مختبر النخبة لطب الأسنان",
      currency: "YER",
      items: sampleItems,
      selectedIds: [101, 102],
      customClaimedCosts: {
        101: 28000, // الفني يطالب بـ 28,000 بدلاً من 25,000
      },
    });

    expect(result.totalSystemCostMinor).toBe(85000);
    expect(result.totalClaimedCostMinor).toBe(88000);
    expect(result.varianceMinor).toBe(3000);
    expect(result.hasDiscrepancy).toBe(true);
    expect(result.discrepancies.length).toBe(1);
    expect(result.discrepancies[0].diffMinor).toBe(3000);
  });

  it("builds comprehensive batch settlement notes", () => {
    const result = reconcileLabStatement({
      partyId: 5,
      partyName: "مختبر النخبة",
      currency: "YER",
      items: sampleItems,
      selectedIds: [101, 103],
    });

    const note = buildBatchSettlementNote("مختبر النخبة", result, "سبتمبر 2026");
    expect(note).toContain("مختبر [مختبر النخبة]");
    expect(note).toContain("سبتمبر 2026");
    expect(note).toContain("عدد (2)");
    expect(note).toContain("RX-101, RX-103");
  });

  it("detects proactive risks when patients have appointments before lab delivery", () => {
    const todayStr = "2026-09-04";

    const appointments: Appointment[] = [
      {
        id: 1,
        patientId: 10,
        patientName: "طارق عبد الله",
        patientPhone: "770111222",
        scheduledDate: "2026-09-04",
        scheduledTime: "10:30",
        durationMinutes: 30,
        status: "booked",
        note: null,
      },
      {
        id: 2,
        patientId: 20,
        patientName: "منيرة خالد",
        patientPhone: "770333444",
        scheduledDate: "2026-09-05",
        scheduledTime: "16:00",
        durationMinutes: 30,
        status: "booked",
        note: null,
      },
    ];

    const labOrders = [
      {
        id: 50,
        patientId: 10,
        patientName: "طارق عبد الله",
        workType: "تاج زيركون",
        labName: "مختبر الجزيرة",
        status: "in_progress", // لم يصل بعد!
        dueDate: "2026-09-04",
      } as unknown as LabOrder,
      {
        id: 51,
        patientId: 20,
        patientName: "منيرة خالد",
        workType: "قشرة فينير Emax",
        labName: "مختبر الجزيرة",
        status: "sent", // لم يصل بعد!
        dueDate: "2026-09-05",
      } as unknown as LabOrder,
    ];

    const risks = detectLabAppointmentMismatches(appointments, labOrders, todayStr);
    expect(risks.length).toBe(2);
    expect(risks[0].riskLevel).toBe("critical"); // موعد اليوم
    expect(risks[0].riskMessage).toContain("خطر حرج");
    expect(risks[1].riskLevel).toBe("warning"); // موعد غداً
  });
});
