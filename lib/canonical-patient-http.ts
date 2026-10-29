import "server-only";
import { NextResponse } from "next/server";
import { CanonicalPatientReadRefusal } from "./canonical-patient-reads";
import { staffAdmissionRefusal } from "./staff-capability-editor";

/**
 * One HTTP mapping for canonical patient routes (M2): bounded codes, Arabic messages,
 * no driver text, never cached.
 *  - CanonicalPatientReadRefusal: 404 (missing or outside the scope), 400 (invalid
 *    input) or 403 (a filter on a hidden column group);
 *  - staff admission refusals: 401 (stale/expired), 403 (capability or record scope),
 *    503 (identity not ready);
 *  - anything else: 500 with the caller's Arabic fallback.
 */
export const NO_STORE = { "Cache-Control": "private, no-store" } as const;
export function canonicalPatientReadFailure(error: unknown, fallback: string): NextResponse {
  if (error instanceof CanonicalPatientReadRefusal) {
    const status = error.code === "patient_not_found" ? 404 : error.code === "invalid_patient_query" ? 400 : 403;
    return NextResponse.json({ code: error.code, message: error.message }, { status, headers: NO_STORE });
  }
  const refusal = staffAdmissionRefusal(error);
  if (refusal) {
    const message = /RECORD_SCOPE_DENIED$/.test(refusal.code) ? "لا تملك صلاحية عرض المرضى." : refusal.message;
    return NextResponse.json({ code: refusal.code, message }, { status: refusal.status, headers: NO_STORE });
  }
  return NextResponse.json({ message: fallback }, { status: 500, headers: NO_STORE });
}
