import type { LabOrder, LabOrderClinicalDTO, LabOrderTrackingEvent } from "./lab";

// Explicit structured financial kinds only. Clinical/unclassified free text is
// preserved; new financial kinds must be added here with regression coverage.
const FINANCIAL_EVENT_KINDS = new Set([
  "accounting_posted",
  "accounting_updated",
  "financial_settlement",
  "financial_settlement_reversed",
]);

export function projectLabTrackingEvents(
  events: LabOrderTrackingEvent[],
  canViewFinancials: boolean,
): LabOrderTrackingEvent[] {
  return canViewFinancials ? events : events.filter((event) => !FINANCIAL_EVENT_KINDS.has(event.action));
}

/** Pure outgoing projection. Never pass this shape into accounting or audit.
 * Explicit clinical keys prevent future financial fields from leaking via spread.
 * The checked key coverage includes optional clinical properties as well. */
export function projectLabOrderResponse(order: LabOrder, canViewFinancials: boolean): LabOrder {
  if (canViewFinancials) return order;
  const clinical = {
    id: order.id,
    patientId: order.patientId,
    patientName: order.patientName,
    patientNumber: order.patientNumber,
    patientPhone: order.patientPhone,
    labName: order.labName,
    labPhone: order.labPhone,
    partyId: order.partyId,
    labServiceId: order.labServiceId,
    serviceName: order.serviceName,
    workType: order.workType,
    details: order.details,
    toothNumbers: order.toothNumbers,
    shade: order.shade,
    stumpShade: order.stumpShade,
    priority: order.priority,
    impressionType: order.impressionType,
    sentDate: order.sentDate,
    dueDate: order.dueDate,
    status: order.status,
    receivedAt: order.receivedAt,
    deliveredAt: order.deliveredAt,
    doctorId: order.doctorId,
    doctorName: order.doctorName,
    visitId: order.visitId,
    toothCode: order.toothCode,
    source: order.source,
    qualityCheck: order.qualityCheck,
    qualityNotes: order.qualityNotes,
    remakeOriginalId: order.remakeOriginalId,
    remakeReason: order.remakeReason,
    technicianName: order.technicianName,
    note: order.note,
    createdAt: order.createdAt,
    events: order.events === undefined ? undefined : projectLabTrackingEvents(order.events, false),
  } satisfies LabOrderClinicalDTO & Record<keyof LabOrderClinicalDTO, unknown>;
  // Compatibility with existing readers: withheld is null, never zero/default currency.
  return { ...clinical, costMinor: null, costCurrency: null };
}
