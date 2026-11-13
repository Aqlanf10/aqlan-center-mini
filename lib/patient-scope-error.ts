/** خطأ محكوم عند محاولة وصول أو كتابة خارج نطاق مرضى الطبيب المقيّد. */
export class PatientOutOfScopeError extends Error {
  readonly status = 403;
  constructor(message = "هذا المريض خارج نطاق صلاحيتك السريرية.") {
    super(message);
    this.name = "PatientOutOfScopeError";
  }
}

export interface SharedPhonePatientCandidate {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
}

export class AmbiguousSharedPhonePatientError extends Error {
  readonly code = "shared_phone_patient_selection_required" as const;
  readonly candidates: readonly SharedPhonePatientCandidate[];
  constructor(message: string, candidates: readonly SharedPhonePatientCandidate[]) {
    super(message);
    this.name = "AmbiguousSharedPhonePatientError";
    this.candidates = candidates;
  }
}
