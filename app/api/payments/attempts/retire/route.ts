import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { canHandleMoney } from "@/lib/roles";
import { CollectionAttemptError, retireCollectionAttempt } from "@/lib/collection-attempts";

export const dynamic = "force-dynamic";

/** Prove a collection attempt key's outcome: "committed" (replay it) or "retired" (it can never land). */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!canHandleMoney(session.role)) return NextResponse.json({ message: "التحقق من محاولة التحصيل للإدارة والاستقبال والصندوق." }, { status: 403 });
  try {
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    const fields = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const state = await retireCollectionAttempt({ idempotencyKey: fields.idempotencyKey, patientId: fields.patientId,
      operation: fields.operation, requestBody: fields.requestBody, originalActor: fields.originalActor }, session);
    return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    if (error instanceof CollectionAttemptError) return NextResponse.json({ message: error.message }, { status: error.status });
    return NextResponse.json({ message: "تعذّر التحقق من المحاولة الآن؛ بقيت محفوظة. أعد المحاولة." }, { status: 500 });
  }
}
