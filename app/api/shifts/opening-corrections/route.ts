import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { requireSession } from "@/lib/session";
import { canonicalErrorResponse, NO_STORE } from "@/lib/canonical-route";
import { CanonicalOpeningReviewRefusal, commandCanonicalOpeningCorrection } from "@/lib/canonical-shift-opening-reviews";

export const dynamic = "force-dynamic";

/**
 * Correction of an open shift's opening count (migration 0129; docs/finance/SHIFT_OPENING_REVIEWS_0129.md §8.4;
 * owner #483 6886911163). Canonical only: the protected owner or `finance.shifts.review-opening`, never the
 * opener. A legacy session is refused and nothing is written; a canonical failure never falls through to a
 * legacy role.
 */
const LEGACY_REFUSAL = {
  code: "opening_correction_requires_staff_runtime",
  message: "تصحيح عدّ افتتاح الوردية متاح بعد الانتقال إلى نظام صلاحيات الطاقم الجديد، ويقوم به المالك أو المراجع المخوّل. لم يُسجَّل شيء.",
};
const EXPIRED = { message: "انتهت الجلسة. سجّل الدخول من جديد." };

export async function POST(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied" || selected.kind === "none") return NextResponse.json(EXPIRED, { status: 401, headers: NO_STORE });
  if (selected.kind === "legacy") {
    if (!(await requireSession())) return NextResponse.json(EXPIRED, { status: 401, headers: NO_STORE });
    return NextResponse.json(LEGACY_REFUSAL, { status: 403, headers: NO_STORE });
  }
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const response = bodyErrorResponse(error) ?? NextResponse.json({ code: "invalid_opening_correction", message: "طلب غير صالح." }, { status: 400 });
    response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return response;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ code: "invalid_opening_correction", message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await commandCanonicalOpeningCorrection(selected.handle, body as Record<string, unknown>), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalOpeningReviewRefusal) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
    }
    return canonicalErrorResponse(error);
  }
}
