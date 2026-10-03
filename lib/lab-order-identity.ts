/** A supplied lab-order context must retain its exact patient/visit owner. */
export class LabOrderIdentityConflict extends Error {
  readonly code = "lab_order_identity_changed";

  constructor() {
    super("تغيّر ارتباط طلب المختبر بملف المريض أو الزيارة. حدّث الشاشة وأعد المحاولة.");
    this.name = "LabOrderIdentityConflict";
  }
}
