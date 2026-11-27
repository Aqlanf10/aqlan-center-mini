import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { evaluateOrthoPermission, NO_STORE_HEADERS } from "@/lib/ortho-privacy-server";

export const dynamic = "force-dynamic";

const unauthorized = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });

function parseOptionalPositiveInt(raw: string | null): number | null {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= 2147483647 ? parsed : null;
}

/**
 * يعيد صلاحيات وحدة التقويم الفعّالة للمستخدم الحالي فقط (دون كشف سياسات بقية الموظفين).
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return unauthorized();

  const params = new URL(request.url).searchParams;
  const patientId = parseOptionalPositiveInt(params.get("patientId"));
  const orthoCaseId = parseOptionalPositiveInt(params.get("orthoCaseId"));
  const doctorPartyId = parseOptionalPositiveInt(params.get("doctorPartyId"));

  const evaluation = await evaluateOrthoPermission(
    session,
    {},
    { patientId, orthoCaseId, doctorPartyId },
  );

  if (!evaluation.access) {
    return NextResponse.json(
      {
        moduleVisible: false,
        isOwner: false,
        permissions: {},
        sections: {},
        fields: {},
      },
      { headers: NO_STORE_HEADERS },
    );
  }

  return NextResponse.json(
    {
      moduleVisible: evaluation.access.moduleVisible,
      isOwner: evaluation.access.isOwner,
      permissions: evaluation.access.permissions,
      sections: evaluation.access.sections,
      fields: evaluation.access.fields,
    },
    { headers: NO_STORE_HEADERS },
  );
}
