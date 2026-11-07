import "server-only";
import { NextResponse } from "next/server";
import { bodyErrorResponse } from "./http-body";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { CanonicalPlanRefusal } from "./canonical-plan-writes";
import { CanonicalLegacyRefusal } from "./canonical-legacy-writes";
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
