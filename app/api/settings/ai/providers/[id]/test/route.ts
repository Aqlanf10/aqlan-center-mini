import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { testAiProviderConnection } from "@/lib/ai-providers/registry";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "اختبار الاتصال للمدير وحده." }, { status: 403 });
  }

  const { id } = await params;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const apiKey = typeof source.apiKey === "string" ? source.apiKey : undefined;

  try {
    const outcome = await testAiProviderConnection(
      id,
      apiKey,
      session.username,
      session.role,
    );
    return NextResponse.json(outcome);
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: `تعذّر فحص الاتصال: ${(err as Error).message}`, latencyMs: 0 },
      { status: 500 },
    );
  }
}
