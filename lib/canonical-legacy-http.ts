import "server-only";
import { NextResponse } from "next/server";
import { bodyErrorResponse } from "./http-body";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { CanonicalPlanRefusal } from "./canonical-plan-writes";
import { CanonicalLegacyRefusal } from "./canonical-legacy-writes";
import { CanonicalLegacyArchiveRefusal } from "./canonical-legacy-reads";
import { LegacyTreatmentWriteError } from "./legacy-treatment-db";
import { DebtRepaymentError } from "./debt-installments-db";
import { LEGACY_TREATMENT_MESSAGE, LEGACY_TREATMENT_STATUS } from "./legacy-treatment";

/** One HTTP mapping for the canonical pre-system treatment routes (M2 slice 95b): the legacy
 * reason, message and status for every writer refusal; never cached. */
export function canonicalLegacyFailure(error: unknown, fallback: string): NextResponse {
  const bounded = bodyErrorResponse(error); if (bounded) return bounded;
  if (error instanceof CanonicalLegacyRefusal) {
    return NextResponse.json({ reason: error.reason, message: LEGACY_TREATMENT_MESSAGE[error.reason] }, { status: LEGACY_TREATMENT_STATUS[error.reason], headers: NO_STORE });
  }
  if (error instanceof CanonicalPlanRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
  if (error instanceof DebtRepaymentError) {
    return NextResponse.json({ code: error.code, message: error.message }, { status: error.code === "unauthorized" ? 403 : error.code === "invalid" ? 400 : 409, headers: NO_STORE });
  }
  return canonicalPatientReadFailure(error, fallback);
}

/** The canonical historical document routes (M2 slice 95c): the legacy writer's messages and
 * statuses (missing 404, invalid 400, unauthorized 403, stale and conflict 409); the ledger view
 * refusal 403; admission refusals as on every canonical patient route; never cached. */
export function canonicalHistoryFailure(error: unknown, fallback: string): NextResponse {
  const bounded = bodyErrorResponse(error); if (bounded) return bounded;
  if (error instanceof CanonicalLegacyArchiveRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: 403, headers: NO_STORE });
  if (error instanceof LegacyTreatmentWriteError) return NextResponse.json({ code: "conflict", message: LEGACY_TREATMENT_MESSAGE[error.reason] }, { status: 409, headers: NO_STORE });
  if (error instanceof DebtRepaymentError) {
    const status = error.code === "unauthorized" ? 403 : error.code === "missing" ? 404 : error.code === "invalid" ? 400 : 409;
    return NextResponse.json({ code: error.code, message: error.message }, { status, headers: NO_STORE });
  }
  if ((error as { code?: string })?.code === "55P03") return NextResponse.json({ code: "busy", message: "يجري تحديث البيانات؛ أعد الطلب نفسه بعد لحظة." }, { status: 409, headers: NO_STORE });
  return canonicalPatientReadFailure(error, fallback);
}
