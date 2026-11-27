import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getPrescription, recordAudit, recordPrint } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { canHandleMoney, isAdmin } from "@/lib/roles";
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

  /* الوصفات وثائق سريرية: طباعتها وإعادة طباعتها للطبيب والمدير — والسندات
     المالية للإدارة والاستقبال. فحص النوع قبل فحص الدور. */
  // Reception may print patient receipts, not clinic disbursements.
  // Deny before touching the print counter or append-only audit.
  if (docType === "voucher" && session.role === "reception") {
    return NextResponse.json({ message: "المصروفات غير متاحة للاستقبال." }, { status: 403 });
  }
  if (docType === "prescription") {
    if (!isAdmin(session.role) && session.role !== "doctor") {
      return NextResponse.json({ message: "طباعة الوصفات للطبيب والمدير." }, { status: 403 });
    }
    // The log must be scoped to the same saved patient document as the print
    // page. Logging is neither issuance nor a record of dispensing medication.
    const rxId = Number(docId);
    if (!/^\d+$/.test(docId) || !Number.isSafeInteger(rxId) || rxId <= 0) {
      return NextResponse.json({ message: "رقم الوصفة غير صالح." }, { status: 400 });
    }
    const saved = await getPrescription(rxId).catch(() => null);
    if (!saved || !await canAccessPatient(session, saved.patientId).catch(() => false)) {
      return NextResponse.json({ message: "الوصفة غير موجودة." }, { status: 404 });
    }
    docId = String(saved.id);
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
    // الطباعة لا تُمنع لتعذّر التسجيل: ورقةٌ بلا علامة أهون من مريض بلا سند.
    return NextResponse.json({ reprint: false, previous: 0 });
  }
}
