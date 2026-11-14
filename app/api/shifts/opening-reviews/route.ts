import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { requireSession } from "@/lib/session";
import { canonicalErrorResponse, NO_STORE } from "@/lib/canonical-route";
import {
  CanonicalOpeningReviewRefusal, commandCanonicalOpeningReview, readCanonicalOpeningReviews,
} from "@/lib/canonical-shift-opening-reviews";

export const dynamic = "force-dynamic";

/**
 * Shift opening reviews (migration 0129; docs/finance/SHIFT_OPENING_REVIEWS_0129.md §2.2 and §4).
 * Canonical only: a legacy session neither lists nor reviews here; the legacy shift screen shows the open
 * shift's differences and the pending count, and a review waits for the cutover. A canonical failure never
 * falls through to a legacy role.
 */
const LEGACY_REFUSAL = {
  code: "opening_review_requires_staff_runtime",
  message: "مراجعة فرق افتتاح الوردية متاحة بعد الانتقال إلى نظام صلاحيات الطاقم الجديد؛ يبقى الفرق معلّقًا وظاهرًا حتى ذلك الحين.",
};

async function admitted() {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return { response: NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE }) };
  if (selected.kind === "none") return { response: NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE }) };
  if (selected.kind === "legacy") {
    // A live legacy session is told why it cannot review here; an expired one signs in again.
    if (!(await requireSession())) return { response: NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE }) };
    return { response: NextResponse.json(LEGACY_REFUSAL, { status: 403, headers: NO_STORE }) };
  }
  return { handle: selected.handle };
}

export async function GET(request: Request) {
  const gate = await admitted();
  if (!gate.handle) return gate.response;
  try {
    const status = new URL(request.url).searchParams.get("status");
    return NextResponse.json(await readCanonicalOpeningReviews(gate.handle, { status }), { headers: NO_STORE });
  } catch (error) { return canonicalErrorResponse(error); }
}

export async function POST(request: Request) {
  const gate = await admitted();
  if (!gate.handle) return gate.response;
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const response = bodyErrorResponse(error) ?? NextResponse.json({ code: "invalid_opening_review", message: "طلب غير صالح." }, { status: 400 });
    response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return response;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ code: "invalid_opening_review", message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await commandCanonicalOpeningReview(gate.handle, body as Record<string, unknown>), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalOpeningReviewRefusal) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
    }
    return canonicalErrorResponse(error);
  }
}
