import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { findPatientIdByNumber, getPatient, mergeDuplicatePatient } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P2-7) دمج ملفٍّ مكرَّر في هذا الملف — المدير وحده.
 *
 * التأكيد برقم الملف المكرَّر نفسه مرتين (يُكتب ثم يُطابَق)، لأن الدمج يحذف ذلك الملف
 * بعد نقل كل ما فيه. والخادم يرفض المصدر ذا الأثر المالي، ويتراجع بالدمج كله عند أي
 * تعارض — لا دمج نصفيّ.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "دمج الملفات للمدير وحده." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const targetId = Number(rawId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const duplicateNumber = typeof source.duplicatePatientNumber === "string" ? source.duplicatePatientNumber.trim() : "";
  const confirmNumber = typeof source.confirmDuplicateNumber === "string" ? source.confirmDuplicateNumber.trim() : "";
  const reason = typeof source.reason === "string" && source.reason.trim() ? source.reason.trim().slice(0, 300) : null;
  if (!duplicateNumber) {
    return NextResponse.json({ message: "اكتب رقم الملف المكرر." }, { status: 400 });
  }
  if (confirmNumber.toUpperCase() !== duplicateNumber.toUpperCase()) {
    return NextResponse.json({ message: "أعد كتابة رقم الملف المكرر نفسه للتأكيد." }, { status: 400 });
  }

  try {
    const [sourceId, target] = await Promise.all([findPatientIdByNumber(duplicateNumber), getPatient(targetId)]);
    if (!target) return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
    if (!sourceId) return NextResponse.json({ message: "لا يوجد ملف بهذا الرقم." }, { status: 404 });

    const result = await mergeDuplicatePatient(sourceId, targetId, {
      actor: session.username, actorRole: session.role, reason,
    });
    if (!result.ok) {
      const messages: Record<typeof result.reason, [string, number]> = {
        same_patient: ["لا يُدمج الملف في نفسه.", 400],
        not_found: ["لا يوجد ملف بهذا الرقم.", 404],
        source_has_financial_history: [
          "الملف المكرر له أثر مالي (دفعات أو حركات مخزون أو رصيد افتتاحي) — لا يُعاد نسبها بصمت. صحّحها بقيودٍ معاكسة أولًا أو ادمج في الاتجاه المعاكس.",
          409,
        ],
        conflict: ["تعارضٌ يمنع الدمج (سجلٌّ لا يتكرر لكل مريض موجودٌ في الملفين). لم يُغيَّر شيء.", 409],
      };
      const [message, status] = messages[result.reason];
      return NextResponse.json({ message, counts: result.counts ?? {} }, { status });
    }
    return NextResponse.json({
      message: `دُمج الملف ${duplicateNumber} في ملف «${target.fullName}» وحُذف المكرر.`,
      moved: result.moved,
      patient: result.target,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر دمج الملفين. أعد المحاولة." }, { status: 500 });
  }
}
