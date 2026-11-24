import { newIdempotencyKey } from "./idempotency-key";

/** Retain the key for this submitted form until its acknowledgment is received. */
export function createRegistrationKey() {
  let pending: { body: string; key: string } | null = null;
  return {
    forBody(body: string) {
      if (!pending || pending.body !== body) pending = { body, key: newIdempotencyKey("register") };
      return pending.key;
    },
    acknowledged() { pending = null; },
  };
}

/** Local UI acknowledgement only. Not an API grant or idempotency key. */
export interface PatientCreateAttempt {
  readonly snapshot: string;
  readonly revision: number;
}

export const PATIENT_CREATE_RECHECK = "تغيّرت بيانات التسجيل. احفظ مرة أخرى لفحص البيانات الحالية.";
export const PATIENT_CREATE_UNCERTAIN = "تعذّر تأكيد الحفظ. ابحث عن الملف للتأكد قبل إعادة المحاولة.";

export function createPatientDuplicateWarningGuard() {
  let revision = 0;
  let active: PatientCreateAttempt | null = null;
  let warning: PatientCreateAttempt | null = null;
  return {
    registrationKey: createRegistrationKey(),
    edit() {
      revision += 1;
      warning = null;
    },
    begin(snapshot: string, confirm: boolean, reviewed?: PatientCreateAttempt):
      { kind: "started"; attempt: PatientCreateAttempt } | { kind: "busy" } | { kind: "stale" } {
      if (active) return { kind: "busy" };
      if (confirm && (!warning || warning !== reviewed || warning.revision !== revision || warning.snapshot !== snapshot)) {
        warning = null;
        return { kind: "stale" };
      }
      warning = null; // consume at send; even an uncertain result needs a new check
      active = Object.freeze({ snapshot, revision });
      return { kind: "started", attempt: active };
    },
    warn(attempt: PatientCreateAttempt) {
      if (active !== attempt || attempt.revision !== revision) return false;
      warning = attempt;
      return true;
    },
    finish(attempt: PatientCreateAttempt) {
      if (active === attempt) active = null;
    },
  };
}
