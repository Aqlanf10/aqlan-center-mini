import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { canPrintSavedPrescription } from "@/lib/prescription-print-access";
import { canAccessPatient } from "@/lib/patient-access";
import { getPrescription, recordAudit, recordPrint } from "@/lib/db";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DOC_TYPES = ["receipt", "invoice", "voucher", "statement", "prescription"] as const;

/**
 * يسجّل طبعة مستند ويقول إن كانت إعادة.
 *
 * يُستدعى عند الضغط على «اطبع» لا عند فتح الصفحة: فتحُ الصفحة للمراجعة ليس طباعة،
 * وعدّه طباعةً يجعل كل سند يُراجَع مرةً يظهر «معاد طبعه» زورًا — فتفقد العلامة معناها.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const docType = String(source.docType ?? "");
  let docId = String(source.docId ?? "");
  if (!(DOC_TYPES as readonly string[]).includes(docType) || !docId) {
    return NextResponse.json({ message: "مستند غير معروف." }, { status: 400 });
  }

  /* Prescription logging needs an actual active record and patient scope;
     reception additionally requires its dedicated stored-print grant. */
  if (docType === "prescription") {
    if (!await canPrintSavedPrescription(session)) {
      return NextResponse.json({ message: "لا تملك صلاحية طباعة الوصفات المحفوظة." }, { status: 403 });
    }
    const id = Number(docId), patientId = Number(source.patientId);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(patientId) || patientId <= 0)
      return NextResponse.json({ message: "حدد الوصفة والمريض الصحيحين." }, { status: 400 });
    const rx = await getPrescription(id).catch(() => null);
    if (!rx || rx.patientId !== patientId || rx.status !== "active")
      return NextResponse.json({ message: "الوصفة غير متاحة للطباعة أو ملغاة." }, { status: 404 });
    if (!await canAccessPatient(session, rx.patientId).catch(() => false))
      return NextResponse.json({ message: "غير مصرح بالوصول إلى المريض." }, { status: 403 });
    docId = String(rx.id);
  } else if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "المستندات المالية للإدارة والاستقبال." }, { status: 403 });
  }

  try {
    const previous = await recordPrint({ docType, docId, printedBy: session.username });
    if (previous > 0) {
      await recordAudit({
        action: "document.reprint", entity: docType, entityId: docId,
        details: { الطبعة_رقم: previous + 1 },
        actor: session.username, actorRole: session.role,
      });
    }
    return NextResponse.json({ reprint: previous > 0, previous });
  } catch {
    if (docType === "prescription") return NextResponse.json({ message: "تعذر تسجيل طباعة الوصفة؛ لم تُفتح نافذة الطباعة." }, { status: 500 });
    // الطباعة لا تُمنع لتعذّر التسجيل: ورقةٌ بلا علامة أهون من مريض بلا سند.
    return NextResponse.json({ reprint: false, previous: 0 });
  }
}
