import { NextResponse } from "next/server";
import { readCanonicalStaffDirectory } from "@/lib/canonical-staff-directory";
import { NO_STORE, canonicalEnvelopeOrResponse, canonicalErrorResponse } from "@/lib/canonical-route";

export const dynamic = "force-dynamic";

/** دليل الطاقم الموحّد (staff.view) — صفحة مفتاحية بلقطة قراءة مملوكة لكل صفحة. */
export async function GET(request: Request) {
  const handle = await canonicalEnvelopeOrResponse();
  if (handle instanceof NextResponse) return handle;
  const params = new URL(request.url).searchParams;
  const page: { afterUserId?: number; limit?: number } = {};
  for (const [key, name] of [["after", "afterUserId"], ["limit", "limit"]] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    if (!/^[0-9]{1,10}$/.test(raw)) return NextResponse.json({ message: "معاملات الصفحة غير صالحة." }, { status: 400, headers: NO_STORE });
    page[name] = Number(raw);
  }
  try {
    const result = await readCanonicalStaffDirectory(handle, page);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof Error && error.message === "STAFF_DIRECTORY_PAGE_INVALID") {
      return NextResponse.json({ message: "معاملات الصفحة غير صالحة." }, { status: 400, headers: NO_STORE });
    }
    return canonicalErrorResponse(error);
  }
}
