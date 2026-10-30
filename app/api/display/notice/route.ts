import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getSettings, recordAudit, saveSettings } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { staffAdmissionRefusal } from "@/lib/staff-capability-editor";
import { CanonicalSettingsRefusal } from "@/lib/canonical-settings";
import { commandCanonicalDisplayNotice, readCanonicalDisplayNotice } from "@/lib/canonical-display-notice";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const denied = () => NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
function canonicalFailure(error: unknown) {
  if (error instanceof CanonicalSettingsRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
  const refusal = staffAdmissionRefusal(error);
  if (refusal) return NextResponse.json({ code: refusal.code, message: refusal.message }, { status: refusal.status, headers: NO_STORE });
  return NextResponse.json({ message: "تعذّر تحديث حالة رسالة التأخير." }, { status: 500, headers: NO_STORE });
}

/**
 * رسالة الاعتذار عن التأخير — مفتاح بضغطة واحدة للاستقبال.
 *
 * المرضى يصبرون على التأخير أكثر مما يصبرون على تجاهله. الشريط على التلفاز
 * («نعتذر لوجود تأخير بسيط…») يشغّله موظف الاستقبال من لوحة اليوم بضغطة، فلا
 * يحتاج أن يفتح شاشة الإعدادات ولا أن يستأذن المدير — وهو لا يغيّر شيئًا في
 * الإعدادات الحرجة: المفتاح واحد ولا يلمس المال ولا الصلاحيات.
 *
 * المسار القديم محفوظ. الهوية الموحّدة: القراءة settings.view، والتغيير
 * settings.operational.edit مع نسخة CAS وتدقيق ذري عبر كاتب الإعدادات المركزي.
 */
export async function PATCH(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return denied();
  if (selected.kind === "canonical") {
    let body: unknown;
    try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); }
    catch (error) {
      const bounded = bodyErrorResponse(error); if (bounded) return bounded;
      return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    try { return NextResponse.json(await commandCanonicalDisplayNotice(selected.handle, body), { headers: NO_STORE }); }
    catch (error) { return canonicalFailure(error); }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const raw = (body as Record<string, unknown> | null)?.on;
  if (typeof raw !== "boolean") {
    return NextResponse.json({ message: "القيمة المطلوبة: on صحيح أو خطأ." }, { status: 400 });
  }
  try {
    await saveSettings({ "display.delay_notice": raw ? "true" : "false" });
    // القيمة لا اسم الموظف: السجل يفسر «متى شُغّل» لا «من يلوم» — رسالة اعتذار
    // ليست إجراءً يحتاج محاسبة، لكن تاريخها يفيد الإدارة في فهم أيام التأخير.
    await recordAudit({
      action: "display.delay_notice",
      actor: session.username,
      details: { القيمة: raw ? "مفعّلة" : "متوقفة" },
    });
    return NextResponse.json({ ok: true, on: raw });
  } catch {
    return NextResponse.json({ message: "تعذّر الحفظ. أعد المحاولة." }, { status: 500 });
  }
}

export async function GET() {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return denied();
  if (selected.kind === "canonical") {
    try { return NextResponse.json(await readCanonicalDisplayNotice(selected.handle), { headers: NO_STORE }); }
    catch (error) { return canonicalFailure(error); }
  }
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  try {
    const settings = await getSettings();
    return NextResponse.json({ on: settings["display.delay_notice"] === "true" });
  } catch {
    return NextResponse.json({ message: "تعذّر التحميل." }, { status: 500 });
  }
}
