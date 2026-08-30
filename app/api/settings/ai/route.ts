import { NextResponse } from "next/server";
import { getAiSettings, saveAiSettings, toAiSettingsView, validateAiInput, isAiProvider } from "@/lib/ai";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/**
 * إعدادات خدمة الذكاء الاصطناعي — مسار المدير وحده.
 *
 * المفتاح لا يخرج من هنا أبدًا: القراءة تعيد بصمة مُقنَّعة، والحفظ يشفّر قبل
 * القاعدة. حتى رسائل الخطأ لا تعيد ما أُرسل.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إعدادات الذكاء الاصطناعي للمدير وحده." }, { status: 403 });
  }
  try {
    return NextResponse.json(toAiSettingsView(await getAiSettings()));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل إعدادات الذكاء الاصطناعي." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إعدادات الذكاء الاصطناعي للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const enabled = source.enabled === true;
  const provider = source.provider;
  if (!isAiProvider(provider)) {
    return NextResponse.json({ message: "المزوّد غير معروف." }, { status: 400 });
  }
  if (typeof source.baseUrl !== "string" || typeof source.model !== "string") {
    return NextResponse.json({ message: "قيم ناقصة أو غير صالحة." }, { status: 400 });
  }
  if (source.apiKey !== undefined && source.apiKey !== null && typeof source.apiKey !== "string") {
    return NextResponse.json({ message: "المفتاح نصّ فقط." }, { status: 400 });
  }

  const apiKey = typeof source.apiKey === "string" ? source.apiKey : undefined;
  const input = { enabled, provider, baseUrl: source.baseUrl, model: source.model, apiKey };

  const problem = validateAiInput(input);
  if (problem) {
    return NextResponse.json({ message: problem }, { status: 400 });
  }

  // تمكين بلا مفتاح: لا مفتاح جديد أُرسل ولا مفتاح محفوظ من قبل — خدمة مفعّلة
  // لا تعرف ماذا تستدعي. تُرفض هنا حيث يُعرف وجود المفتاح المحفوظ.
  if (enabled && !apiKey?.trim()) {
    const existing = await getAiSettings();
    if (!existing.hasKey) {
      return NextResponse.json(
        { message: "لا يمكن تمكين الخدمة قبل إدخال مفتاح." },
        { status: 400 },
      );
    }
  }

  try {
    await saveAiSettings(input, session.username, session.role);
    return NextResponse.json(toAiSettingsView(await getAiSettings()));
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ إعدادات الذكاء الاصطناعي." }, { status: 500 });
  }
}
