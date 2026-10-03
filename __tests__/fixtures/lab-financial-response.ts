import type { LabOrderClinicalDTO, LabOrderFinancialDTO, LabOrderTrackingEvent } from "../../lib/lab";

export const clinicalOrder: LabOrderClinicalDTO = {
  id: 731, patientId: 101, patientName: "Synthetic clinical patient", patientNumber: "SYN-101",
  patientPhone: "synthetic-patient-phone", labName: "Synthetic clinical lab", labPhone: "synthetic-lab-phone",
  partyId: 401, labServiceId: 501, serviceName: "Synthetic service", workType: "Synthetic crown",
  details: "Clinical details", toothNumbers: "16", shade: "A2", stumpShade: "ND1", priority: "urgent",
  impressionType: "digital_scan", sentDate: "2026-10-03", dueDate: "2026-10-10", status: "sent",
  receivedAt: null, deliveredAt: null, doctorId: 601, doctorName: "Synthetic clinical doctor",
  visitId: 201, toothCode: 16, source: "manual", qualityCheck: "rejected", qualityNotes: "Clinical quality note",
  remakeOriginalId: 730, remakeReason: "Clinical remake reason", technicianName: "Synthetic technician",
  note: "Clinical note", createdAt: "2026-10-03T10:00:00.000Z",
};

// Every canonical financial field plus the optional future pricing link has a value.
export const financialFields = {
  costMinor: 918273, costCurrency: "SAR", baseAmountMinor: 827364, exchangeRate: 736.45,
  financialStatus: "payable_created", payableId: 645738, pricingRuleId: 554627,
  expenseCategoryId: 463516, expenseCategoryName: "FINANCIAL-CATEGORY-NAME-SENTINEL",
  expenseCategoryKey: "FINANCIAL-CATEGORY-KEY-SENTINEL", expenseAccountCode: "FIN-EXP-CODE",
  expenseAccountName: "FINANCIAL-EXPENSE-NAME-SENTINEL", payableAccountCode: "FIN-PAY-CODE",
  payableAccountName: "FINANCIAL-PAYABLE-NAME-SENTINEL", isPosted: true, postedAt: "2098-07-06T05:04:03.000Z",
} satisfies Omit<LabOrderFinancialDTO, keyof LabOrderClinicalDTO>;
export const fullOrder: LabOrderFinancialDTO = { ...clinicalOrder, ...financialFields };

export const financialKinds = [
  "accounting_posted", "accounting_updated", "financial_settlement", "financial_settlement_reversed",
];
export const clinicalKinds = ["create", "status_change", "due_date_change", "quality_check", "marked_for_remake", "created_as_remake", "unclassified"];
export const trackingEvents: LabOrderTrackingEvent[] = [...clinicalKinds, ...financialKinds].map((action, index) => ({
  id: 900 - index, labOrderId: clinicalOrder.id, action, fromStatus: "sent", toStatus: "received",
  notes: financialKinds.includes(action) ? `FINANCIAL-EVENT-${action}-SENTINEL` : `Clinical ${action} note`,
  actor: "synthetic-actor", actorRole: "admin", createdAt: `2026-10-03T10:00:${String(index).padStart(2, "0")}.000Z`,
}));
