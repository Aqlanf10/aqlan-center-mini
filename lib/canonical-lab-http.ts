import "server-only";
import { NextResponse } from "next/server";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { CanonicalLabDirectoryRefusal } from "./canonical-lab-directory";
import { CanonicalLabPricingRefusal } from "./canonical-lab-pricing";
import { selectRequestStaffEnvelope } from "./staff-session-admission";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * The canonical branch of a lab directory / catalogue / pricing request (M2 slices
 * 70a–70b): the envelope selected once; a canonical cookie never falls back to the legacy
 * session; bounded codes and Arabic messages; never cached. Returns null for a legacy (or
 * absent) envelope so the caller continues with its unchanged legacy path.
 */
export async function canonicalLabRoute(
  request: Request | null,
  run: (handle: VerifiedDurableSession, body: Record<string, unknown>) => Promise<unknown>,
  fallback: string,
  status = 200,
): Promise<NextResponse | null> {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind !== "canonical") return null;
  let body: Record<string, unknown> = {};
  if (request) {
    try {
      const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    } catch (error) {
      return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
  }
  try {
    return NextResponse.json(await run(selected.handle, body), { status, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalLabDirectoryRefusal || error instanceof CanonicalLabPricingRefusal) {
      return NextResponse.json({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }, { status: error.status, headers: NO_STORE });
    }
    return canonicalPatientReadFailure(error, fallback);
  }
}
