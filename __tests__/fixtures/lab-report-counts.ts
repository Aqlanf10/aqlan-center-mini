import type { LabOrderClinicalDTO, LabOrderStatus } from "../../lib/lab";
import { addDays } from "../../lib/schedule";

/** Synthetic test data only; no patient/financial data is read from any system. */
export const REPORT_LAB_TODAY = "2026-10-04";
export const ZERO_LAB_COUNTS = { outstanding: 0, late: 0, dueToday: 0, waitingFitting: 0 };
export const LAB_REPORT_STATUSES = [
  "needed", "sent", "in_progress", "received", "delivered", "remake", "cancelled",
] as const satisfies readonly LabOrderStatus[];

// Same clinical shape as the existing __tests__/lab.test.ts order fixture.
export function reportLabOrder(
  id: number, status: LabOrderStatus, dueDate: string,
): LabOrderClinicalDTO {
  return {
    id, patientId: 1, patientName: "Synthetic report patient", patientNumber: "SYN-REPORT-LAB",
    patientPhone: null, labName: "Synthetic report lab", labPhone: null, partyId: null,
    labServiceId: null, serviceName: null, workType: "Synthetic crown", details: null,
    toothNumbers: null, shade: null, stumpShade: null, priority: "normal", impressionType: "physical",
    sentDate: "1999-12-01", dueDate, status, receivedAt: null, deliveredAt: null,
    doctorId: null, doctorName: null, visitId: null, qualityCheck: "pending", qualityNotes: null,
    remakeOriginalId: null, remakeReason: null, technicianName: null, note: null,
    createdAt: "1999-12-01T00:00:00.000Z",
  };
}

export function reportStatusMatrix(today = REPORT_LAB_TODAY): LabOrderClinicalDTO[] {
  return LAB_REPORT_STATUSES.flatMap((status, statusIndex) => [-1, 0, 1].map((offset, index) =>
    reportLabOrder(statusIndex * 3 + index + 1, status, addDays(today, offset)),
  ));
}

export function reportLateOrders(count: number, status: LabOrderStatus = "sent"): LabOrderClinicalDTO[] {
  return Array.from({ length: count }, (_, i) => reportLabOrder(i + 1, status, "2000-01-01"));
}

export function reportDisplacedReceived(): LabOrderClinicalDTO[] {
  return [
    ...reportLateOrders(300, "delivered"),
    reportLabOrder(301, "received", REPORT_LAB_TODAY),
  ];
}

/** Counterfactual only: mirrors the pinned SQL's due_date ASC/id DESC and cap.
 * It is NOT a replacement aggregate or a proposed production implementation. */
export function legacyReportWindow(orders: LabOrderClinicalDTO[], limit = 300): LabOrderClinicalDTO[] {
  return [...orders].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.id - a.id)
    .slice(0, Math.min(limit, 500));
}
