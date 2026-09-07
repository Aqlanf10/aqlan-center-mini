import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import {
  getAiProvider,
  saveAiProvider,
  deleteAiProvider,
  toAiProviderView,
  validateProviderInput,
} from "@/lib/ai-providers/registry";
import type { AiProviderInput } from "@/lib/ai-providers/types";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "تعديل مزود الذكاء الاصطناعي للمدير وحده." }, { status: 403 });
  }

  const { id } = await params;
  const existing = await getAiProvider(id);
  if (!existing) {
    return NextResponse.json({ message: "المزود غير موجود." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح (JSON غير صحيح)." }, { status: 400 });
  }

  const input = (body ?? {}) as AiProviderInput;
  input.id = id; // تثبيت الـ id الأصلي
  const validationProblem = validateProviderInput(input);
  if (validationProblem) {
    return NextResponse.json({ message: validationProblem }, { status: 400 });
  }

  try {
    const updated = await saveAiProvider(input, session.username, session.role);
    return NextResponse.json({
      ok: true,
      provider: toAiProviderView(updated),
    });
  } catch (err) {
    return NextResponse.json(
      { message: `تعذّر تحديث المزود: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "حذف مزود الذكاء الاصطناعي للمدير وحده." }, { status: 403 });
  }

  const { id } = await params;
  const result = await deleteAiProvider(id, session.username, session.role);
  if (!result.ok) {
    return NextResponse.json({ message: result.message || "تعذر الحذف." }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
