import type { LabBacklogItem, LabBacklogSnapshot } from "../../lib/lab-backlog";
export const backlogItem = (extra: Partial<LabBacklogItem> = {}): LabBacklogItem => ({
  id: 11, patientId: 21, patientName: "Synthetic waiting patient", patientNumber: "SYN-21", workType: "Synthetic crown",
  teeth: "36", doctorName: "Synthetic doctor", labName: "Synthetic laboratory", status: "received",
  createdAt: "2025-01-01T12:00:00Z", sentDate: "2025-01-02", dueDate: "2025-01-10", receivedAt: "2026-10-01T22:00:00Z",
  latestAction: null, visibleTaskCount: 0, tasks: [], ...extra,
});
export const backlogSnapshot = (extra: Partial<LabBacklogSnapshot> = {}): LabBacklogSnapshot => ({
  scope: "all_open_now", asOf: "2026-10-24T23:00:00Z", today: "2026-10-25", timeZone: "Asia/Aden", filter: "all",
  counts: { orders: 1, patients: 1, preparing: 0, withLab: 0, overdue: 0, awaitingFitting: 1 }, total: 1, page: 0, hasMore: false,
  items: [backlogItem()], ...extra,
});
