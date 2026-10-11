import type { LabOrder } from "../../lib/lab";

// Synthetic canaries only. No real clinic/patient identifiers or documents.
export const DISPATCH_PRIVATE_CANARIES = [
  "SYNTHETIC_PRIVATE_PATIENT", "SYNTHETIC_PRIVATE_FILE", "777999887766",
  "SYNTHETIC_PRIVATE_DETAILS", "SYNTHETIC_PRIVATE_NOTE", "SYNTHETIC_PRIVATE_QUALITY",
  "SYNTHETIC_PRIVATE_REMAKE", "SYNTHETIC_PRIVATE_EVENT", "SYNTHETIC_PRIVATE_TECHNICIAN",
];

export function dispatchOrder(overrides: Partial<LabOrder> = {}): LabOrder {
  return {
    id: 381, patientId: 910007, patientName: DISPATCH_PRIVATE_CANARIES[0],
    patientNumber: DISPATCH_PRIVATE_CANARIES[1], patientPhone: DISPATCH_PRIVATE_CANARIES[2],
    labName: "SYNTHETIC_LAB", labPhone: "000-111-222", partyId: 47,
    labServiceId: 17, serviceName: "SYNTHETIC_CATALOGUE_CROWN", workType: "SYNTHETIC_CATALOGUE_CROWN",
    details: DISPATCH_PRIVATE_CANARIES[3], note: DISPATCH_PRIVATE_CANARIES[4],
    toothNumbers: "14(Abutment), 15(Pontic), 16(Abutment)", shade: "A2", stumpShade: "ND2",
    priority: "urgent", impressionType: "digital_scan", sentDate: "2000-02-02", dueDate: "2000-02-05",
    status: "sent", receivedAt: null, deliveredAt: null,
    doctorId: 23, doctorName: "SYNTHETIC_DOCTOR", visitId: 910008,
    qualityCheck: "pending", qualityNotes: DISPATCH_PRIVATE_CANARIES[5],
    remakeOriginalId: null, remakeReason: DISPATCH_PRIVATE_CANARIES[6],
    technicianName: DISPATCH_PRIVATE_CANARIES[8], createdAt: "2000-02-02T10:00:00Z",
    costMinor: 875431, costCurrency: "YER", payableId: 910010,
    events: [{ id: 910011, labOrderId: 381, action: "sent", fromStatus: null, toStatus: "sent",
      notes: DISPATCH_PRIVATE_CANARIES[7], actor: "SYNTHETIC_PRIVATE_ACTOR", actorRole: "admin", createdAt: "2000-02-02T10:00:00Z" }],
    ...overrides,
  };
}
