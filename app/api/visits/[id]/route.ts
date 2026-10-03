import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { callVisitAgain, callVisitGated, clearVisit, deferVisitPayment, deleteVisit, finishVisit, linkVisitToPatient, openVisitPatientFile, recordAudit, returnVisitToWaiting, seatVisitGated, type GatedMoveResult } from "@/lib/db";
import { normalizeEmergencyReason } from "@/lib/chair-readiness";
import { authorizeVisit, authorizeVisitLink } from "@/lib/operational-access";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { VISIT_DELETE_MESSAGE } from "@/lib/visit-record-identity";

export const dynamic = "force-dynamic";

/**
 * (CHAIR-1 Slice 3) ردّ حركة الطابور عبر بوابة الجاهزية: النجاح يعيد الزيارة كما كان (ومعها `warning`
 * نصًّا عربيًّا إن لم تُقَرّ الجاهزية — بلا نقرة إضافية)، والمنع 409 برسالة ورمزٍ ثابت تفهمه الشاشة.
 */
function gatedResponse(result: GatedMoveResult, conflictMessage: string) {
  if (result.ok) {
    return NextResponse.json(result.warning ? { ...result.visit, warning: result.warning } : result.visit);
  }
  if (result.reason === "gate") {
    return NextResponse.json({ message: result.message, code: result.code }, { status: 409 });
  }
  return NextResponse.json({ message: conflictMessage }, { status: 409 });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
  }

  /* حارسُ المورد قبل قراءة الجسد: الجلسةُ وحدها ليست تفويضًا على زيارةِ مريضٍ
     بعينه. وزيارةُ الطابور غير المربوطة تمرّ — الصالة مشتركة. */
  const allowed = await authorizeVisit(session, id);
  if (!allowed.ok) {
    return NextResponse.json({ message: allowed.message }, { status: allowed.status });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const source = (body ?? {}) as Record<string, unknown>;
  const action = typeof source.action === "string" ? source.action : "";
  /* (LIVE-3) الفاعل يصل إلى القاعدة: كل حركة طابور تُسجَّل في التدقيق باسمه ودوره. */
  const actor = { actor: session.username, actorRole: session.role };
  /* (CHAIR-1) دخول طوارئ قبل إقرار الجاهزية: لا يُستعمل إلا حين يمنع الإعدادُ النداء، وسببه يُدقَّق. */
  const emergency = {
    requested: source.emergency === true,
    reason: normalizeEmergencyReason(source.emergencyReason),
  };

  try {
    if (action === "call") {
      const chair = Number(source.chair);
      if (!Number.isInteger(chair) || chair <= 0) {
        return NextResponse.json({ message: "رقم الكرسي غير صالح." }, { status: 400 });
      }
      return gatedResponse(
        await callVisitGated(id, chair, actor, emergency),
        "الكرسي محجوز لمريض آخر أو تغيّرت حالة المريض. حدّثت اللوحة — راجعها.",
      );
    }

    // إعادة النداء: المريض لم ينتبه للشاشة — يُحدَّث ختمة النداء فيصدر الوميض
    // والنغمة والنطق من جديد على التلفاز، والكرسي يبقى محجوزًا له.
    if (action === "call_again") {
      const again = await callVisitAgain(id, actor);
      if (!again) {
        return NextResponse.json(
          { message: "لا يوجد نداء قائم لإعادته — ربما دخل المريض الكرسي أو عاد للانتظار." },
          { status: 409 },
        );
      }
      return NextResponse.json(again);
    }

    if (action === "seat") {
      const chair = Number(source.chair);
      if (!Number.isInteger(chair) || chair <= 0) {
        return NextResponse.json({ message: "رقم الكرسي غير صالح." }, { status: 400 });
      }
      // فشل الإجلاس يعني أن جهازًا آخر سبقنا إلى الكرسي، أو أن المريض لم يعد منتظرًا.
      // الرسالة تقول ذلك بدل «حدث خطأ»، لأن الإجراء الصحيح مختلف تمامًا: انظر اللوحة.
      return gatedResponse(
        await seatVisitGated(id, chair, actor, emergency),
        "الكرسي شُغل للتو أو تغيّرت حالة المريض. حدّثت اللوحة — راجعها.",
      );
    }

    /* (CHAIR-1 Slice 1) «أقِرّ الجاهزية»: من اطّلع على قائمة المريض قبل الكرسي — الطاقم السريري
       والاستقبال. لا يغيّر حالة الزيارة؛ والإقرار الثاني يعيد الأول بلا أثرٍ ثانٍ. */
    if (action === "clear") {
      if (!isAdmin(session.role) && session.role !== "reception" && session.role !== "doctor") {
        return NextResponse.json({ message: "إقرار الجاهزية للاستقبال أو الطبيب أو المدير." }, { status: 403 });
      }
      const cleared = await clearVisit(id, actor);
      if (!cleared.ok) {
        return NextResponse.json(
          { message: cleared.reason === "closed" ? "الزيارة منتهية — لا جاهزية تُقَرّ بعدها." : "الزيارة غير موجودة." },
          { status: cleared.reason === "closed" ? 409 : 404 },
        );
      }
      return NextResponse.json({ ok: true, clearedAt: cleared.clearedAt, clearedBy: cleared.clearedBy, already: cleared.already });
    }

    /* (CHAIR-1 Slice 5) «تأجيل الدفع» عند الشبّاك: قرارٌ يُدقَّق لا حركةٌ مالية — لا سند ولا فاتورة،
       والرصيد يبقى على المريض كما هو. لمن يلمس المال وحده. */
    if (action === "defer") {
      if (!canHandleMoney(session.role)) {
        return NextResponse.json({ message: "تأجيل الدفع للاستقبال أو المدير." }, { status: 403 });
      }
      const deferReason = typeof source.reason === "string" && source.reason.trim() ? source.reason.trim().slice(0, 300) : null;
      const deferred = await deferVisitPayment(id, actor, deferReason);
      if (!deferred.ok) {
        return NextResponse.json(
          { message: deferred.reason === "not_signed" ? "وقّع الزيارة أولًا — التأجيل يكون عند الشبّاك بعد التوقيع." : "الزيارة غير موجودة." },
          { status: deferred.reason === "not_signed" ? 409 : 404 },
        );
      }
      return NextResponse.json({ ok: true, already: deferred.already, message: "أُجِّل الدفع — الرصيد باقٍ على المريض." });
    }

    if (action === "return") {
      const returned = await returnVisitToWaiting(id, actor);
      if (!returned) {
        return NextResponse.json({ message: "المريض لم يعد في حالة نداء." }, { status: 409 });
      }
      return NextResponse.json(returned);
    }

    if (action === "finish") {
      const finished = await finishVisit(id, actor);
      if (!finished) {
        return NextResponse.json({ message: "الزيارة منتهية بالفعل." }, { status: 409 });
      }
      return NextResponse.json(finished);
    }

    // ربط الزيارة بملفٍّ قائم — قرارٌ بشري لا مطابقةٌ صامتة بالاسم.
    if (action === "link") {
      const patientId = Number(source.patientId);
      if (!Number.isInteger(patientId) || patientId <= 0) {
        return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
      }
      /* والملفُّ الهدف يُحرس مستقلًّا: زيارةٌ حرّة لا تفتح بابًا لملفٍّ محروس. */
      const target = await authorizeVisitLink(session, id, patientId);
      if (!target.ok) {
        return NextResponse.json({ message: target.message }, { status: target.status });
      }
      const linked = await linkVisitToPatient(id, patientId);
      if (!linked.ok) return NextResponse.json({ message: linked.message, code: linked.reason }, { status: 409 });
      return NextResponse.json({ ok: true, patientName: linked.patientName });
    }

    /* (VISIT-2) فتح ملفٍّ للمريض الجديد من زيارته — الطبيب/المدير، قبل التوقيع؛ بالقاعدة نفسها
       التي يستعملها التوقيع: الهاتف المطابق يُربط بملفّه، وإلا يُنشأ ملفٌّ جديد. */
    if (action === "open_file") {
      if (!isAdmin(session.role) && session.role !== "doctor" && session.role !== "reception") {
        return NextResponse.json({ message: "فتح الملف للطبيب أو المدير أو الاستقبال." }, { status: 403 });
      }
      const opened = await openVisitPatientFile(id);
      if (!opened.ok) {
        return NextResponse.json(
          { message: opened.reason === "signed" ? "الزيارة موقَّعة — ملفّها فُتح عند توقيعها." : "الزيارة غير موجودة." },
          { status: opened.reason === "signed" ? 409 : 404 },
        );
      }
      if (opened.created) {
        await recordAudit({
          action: "patient.create", entity: "patient", entityId: opened.patientId,
          details: { المصدر: "زيارة سريرية", الزيارة: id },
          actor: session.username, actorRole: session.role,
        });
      }
      return NextResponse.json({ ok: true, patientId: opened.patientId, created: opened.created });
    }

    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}

/* حذف زيارة — المدير وحده، وللتشغيلية غير الموقّعة وغير المفوترة فقط. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "حذف الزيارات للمدير وحده." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
  }
  const deletable = await authorizeVisit(session, id);
  if (!deletable.ok) {
    return NextResponse.json({ message: deletable.message }, { status: deletable.status });
  }

  let reason: string | null = null;
  try {
    const body = (await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES));
    if (typeof body?.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 300);
    }
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; /* لا سبب — ليس شرطًا */ }

  try {
    const result = await deleteVisit(id, { actor: session.username, actorRole: session.role, reason });
    if (!result.ok) {
      if (result.reason === "has_clinical_history" || result.reason === "has_linked_workflow" || result.reason === "has_financial_history") {
        return NextResponse.json({ message: VISIT_DELETE_MESSAGE[result.reason], code: result.reason }, { status: 409 });
      }
      if (result.reason === "signed") {
        return NextResponse.json(
          { message: "الزيارة موقّعة سريريًا — وثّقت عمل الطبيب ولا تُمحى." },
          { status: 409 },
        );
      }
      if (result.reason === "invoiced") {
        return NextResponse.json(
          { message: "الزيارة مفوترة — دخلت الدفاتر ولا تُمحى. ألغِ الفاتورة أولًا إن كان ذلك الصحيح." },
          { status: 409 },
        );
      }
      return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    }
    return NextResponse.json({ message: "حُذفت الزيارة وسُجِّل الحذف في التدقيق." });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف الزيارة. أعد المحاولة." }, { status: 500 });
  }
}
