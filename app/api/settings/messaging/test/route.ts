import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { messagingChannelWithSecret, recordChannelTest, recordMessageDelivery } from "@/lib/db";
import { isChannel } from "@/lib/messaging-channels";
import { sendOutbound } from "@/lib/messaging-send";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** (MSG-1) إرسال رسالة اختبار عبر قناة — ولو قبل تفعيلها — وتسجيل نتيجته في القناة. للمدير وحده. */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!isAdmin(session.role)) return NextResponse.json({ message: "اختبار القنوات للمدير وحده." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  if (!isChannel(body.channel)) return NextResponse.json({ message: "قناة غير معروفة." }, { status: 400 });
  const channel = body.channel;
  const to = typeof body.to === "string" ? body.to.trim().slice(0, 200) : "";
  if (!to) return NextResponse.json({ message: "أدخل رقمًا أو بريدًا لرسالة الاختبار." }, { status: 400 });
  try {
    const result = await sendOutbound(
      { channel, to, subject: "رسالة اختبار", body: "رسالة اختبار من نظام المركز — القناة تعمل.", patientId: null, purpose: "test", actor: session.username },
      { channel: messagingChannelWithSecret, record: recordMessageDelivery },
    );
    await recordChannelTest(channel, result.ok, result.ok ? "نجح الاختبار" : result.message);
    return result.ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, message: result.message }, { status: result.status });
  } catch {
    return NextResponse.json({ message: "تعذّر اختبار القناة." }, { status: 500 });
  }
}
