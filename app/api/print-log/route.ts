import { NextResponse } from "next/server";
import { recordAudit, recordPrint } from "@/lib/db";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DOC_TYPES = ["receipt", "invoice", "voucher", "statement"] as const;

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
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "المستندات المالية للإدارة والاستقبال." }, { status: 403 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const docType = String(source.docType ?? "");
  const docId = String(source.docId ?? "");
  if (!(DOC_TYPES as readonly string[]).includes(docType) || !docId) {
    return NextResponse.json({ message: "مستند غير معروف." }, { status: 400 });
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
