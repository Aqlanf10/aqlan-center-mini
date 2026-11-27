import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getPool } from "@/lib/db";
import { requireSession, revalidateSessionInTransaction } from "@/lib/session";
import { withIsolation } from "@/lib/transactions";
import { canPerformOwnerOperation } from "@/lib/staff-capabilities";
import { loadPatientNumberingOwnerAccess } from "@/lib/patient-numbering-owner-provider";
import { configurePatientNumbering, PatientNumberingError } from "@/lib/patient-numbering";

export const dynamic = "force-dynamic";

class UnauthenticatedNumberingError extends Error {}
class ForbiddenOwnerNumberingError extends Error {}

const unauthorized = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const forbidden = () =>
  NextResponse.json(
    { message: "تعديل ترقيم الملفات مقفل حتى تثبت صلاحية المالك المستقلة." },
    { status: 403 },
  );

export async function PATCH(request: Request) {
  const session = await requireSession();
  if (!session) return unauthorized();

  const initialAccess = await loadPatientNumberingOwnerAccess(session);
  if (!initialAccess || !canPerformOwnerOperation(initialAccess, "settings.security.change")) {
    return forbidden();
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const raw = body as Record<string, unknown>;

  try {
    const snapshot = await withIsolation(getPool(), "READ COMMITTED", async (client) => {
      const current = await revalidateSessionInTransaction(session, client);
      if (!current) throw new UnauthenticatedNumberingError();
      const txAccess = await loadPatientNumberingOwnerAccess(current, client);
      if (!txAccess || !canPerformOwnerOperation(txAccess, "settings.security.change")) {
        throw new ForbiddenOwnerNumberingError();
      }
      return configurePatientNumbering(
        client,
        {
          prefix: raw.prefix as string,
          firstNumber: raw.firstNumber as string,
          requestId: raw.requestId as string,
        },
        {
          userId: current.userId,
          username: current.username,
          role: current.role,
        },
      );
    });
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof UnauthenticatedNumberingError) return unauthorized();
    if (error instanceof ForbiddenOwnerNumberingError) return forbidden();
    if (error instanceof PatientNumberingError) {
      if (error.code === "invalid_input") {
        return NextResponse.json(
          { message: "تحقق من البادئة وأدخل رقم البداية ضمن النطاق المسموح.", code: error.code },
          { status: 400 },
        );
      }
      if (error.code === "number_consumed") {
        return NextResponse.json(
          { message: "الرقم المطلوب مستخدم أو دون الحد الأدنى المتاح لهذه البادئة.", code: error.code },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { message: "استُخدم معرّف الطلب سابقًا لقيمة مختلفة.", code: error.code },
        { status: 409 },
      );
    }
    return NextResponse.json({ message: "تعذّر حفظ ترقيم الملفات." }, { status: 500 });
  }
}
