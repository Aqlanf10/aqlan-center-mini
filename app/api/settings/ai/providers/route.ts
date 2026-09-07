import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import {
  listAiProviders,
  saveAiProvider,
  toAiProviderView,
  validateProviderInput,
} from "@/lib/ai-providers/registry";
import { AI_PROVIDER_PRESETS } from "@/lib/ai-providers/presets";
import type { AiProviderInput } from "@/lib/ai-providers/types";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إعدادات مزودي الذكاء الاصطناعي للمدير وحده." }, { status: 403 });
  }

  try {
    const configs = await listAiProviders();
    const providers = configs.map(toAiProviderView);

    return NextResponse.json({
      providers,
      presets: AI_PROVIDER_PRESETS,
    });
  } catch (err) {
    return NextResponse.json(
      { message: `تعذّر تحميل مزودي الذكاء الاصطناعي: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إضافة مزود ذكاء اصطناعي للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح (JSON غير صحيح)." }, { status: 400 });
  }

  const input = (body ?? {}) as AiProviderInput;
  const validationProblem = validateProviderInput(input);
  if (validationProblem) {
    return NextResponse.json({ message: validationProblem }, { status: 400 });
  }

  try {
    const saved = await saveAiProvider(input, session.username, session.role);
    return NextResponse.json({
      ok: true,
      provider: toAiProviderView(saved),
    });
  } catch (err) {
    return NextResponse.json(
      { message: `تعذّر حفظ المزود: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
