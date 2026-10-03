/** A stale patient/visit context cannot be saved as a prescription. */
export class PrescriptionIdentityConflict extends Error {
  readonly code = "identity_changed";

  constructor() {
    super("تغيّر ارتباط الوصفة بملف المريض أو الزيارة. حدّث الشاشة وأعد المحاولة.");
    this.name = "PrescriptionIdentityConflict";
  }
}
