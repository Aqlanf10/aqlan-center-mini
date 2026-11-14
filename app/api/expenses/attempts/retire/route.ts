import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getSettings, ratesFromSettings, retireExpenseRequest, type ExpenseRequestRetirement } from "@/lib/db";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotency-key";
import { legacyExpenseFingerprint } from "@/lib/legacy-expense-fingerprint";
import { requestsOwnerPrivatePart } from "@/lib/expense-payment-split";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalErrorResponse, NO_STORE } from "@/lib/canonical-route";
import { CanonicalExpenseRefusal, commandCanonicalRetireExpenseRequest } from "@/lib/canonical-expense-create";

export const dynamic = "force-dynamic";

/**
 * 0133 (docs/finance/EXPENSE_REQUEST_RETIREMENTS_0133.md §2.1): the sender ends an unknown expense request for
 * good. Body `{ key, body }`: the request key and the exact request body that was sent. The server
 * fingerprints that body for the current actor exactly as the create does and, under the key lock, either
 * retires that request (no later send of it can write), returns the voucher already saved under the key, or
 * refuses. Nothing is written on a refusal; a canonical session never falls through to the legacy role.
 */
const UNPROVEN = { code: "expense_retirement_unproven",
  message: "تعذّر ربط هذا الطلب ببياناته الحالية، فلم يُنهَ. يبقى معلّقًا؛ تحقّق منه أو راجع سجل الصرف قبل أي تسجيل جديد." };
const CONFLICT = { code: "expense_retirement_conflict",
  message: "هذا المفتاح يخص طلبًا آخر أو سندًا بمحتوى مختلف؛ لم يُنهَ شيء. راجع سجل الصرف قبل أي تسجيل جديد." };

function answer(result: ExpenseRequestRetirement, headers?: HeadersInit) {
  if (result.state === "retired") return NextResponse.json({ requestKeyState: "retired" }, { headers });
  if (result.state === "saved") return NextResponse.json({ ...result.expense, existing: true, replayed: true }, { headers });
  return NextResponse.json(CONFLICT, { status: 409, headers });
}

async function read(request: Request): Promise<{ key: string; source: Record<string, unknown> } | NextResponse> {
  let raw: unknown;
  try { raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const value = raw as { key?: unknown; body?: unknown } | null;
  if (!value || typeof value.key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value.key) || typeof value.body !== "string") {
    return NextResponse.json({ code: "invalid_retirement", message: "طلب الإنهاء ناقص؛ لم يُنهَ شيء." }, { status: 400 });
  }
  let source: unknown;
  try { source = JSON.parse(value.body); } catch { return NextResponse.json(UNPROVEN, { status: 409 }); }
  if (!source || typeof source !== "object" || Array.isArray(source)) return NextResponse.json(UNPROVEN, { status: 409 });
  return { key: value.key, source: source as Record<string, unknown> };
}

export async function POST(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    const input = await read(request);
    if (input instanceof NextResponse) { input.headers.set("Cache-Control", NO_STORE["Cache-Control"]); return input; }
    try {
      return answer(await commandCanonicalRetireExpenseRequest(selected.handle, { requestKey: input.key, source: input.source }), NO_STORE);
    } catch (error) {
      if (error instanceof CanonicalExpenseRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
      return canonicalErrorResponse(error);
    }
  }
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!canHandleMoney(session.role) || (session.role === "cashier" && !session.financeAccess?.createExpenses)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const input = await read(request);
  if (input instanceof NextResponse) return input;
  // A legacy session never records a private part, so such a request can never be bound here.
  if (requestsOwnerPrivatePart(input.source)) return NextResponse.json(UNPROVEN, { status: 409 });
  try {
    const fingerprint = legacyExpenseFingerprint(session.username, isAdmin(session.role), input.source, ratesFromSettings(await getSettings()));
    if (!fingerprint.ok) return NextResponse.json(UNPROVEN, { status: 409 });
    return answer(await retireExpenseRequest({ key: input.key, hash: fingerprint.hash, actor: session.username }));
  } catch {
    return NextResponse.json({ message: "تعذّر تأكيد إنهاء الطلب؛ يبقى معلّقًا. أعد المحاولة." }, { status: 500 });
  }
}
