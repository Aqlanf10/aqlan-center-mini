import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { OrthoPlanLinkRefusal, parseOrthoPlanLinkId, readOrthoPlanLink } from "@/lib/ortho-plan-link-command";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة." }, { status: 401, headers });
  try {
    const id = parseOrthoPlanLinkId((await context.params).id);
    return NextResponse.json(await readOrthoPlanLink(session, id), { headers });
  } catch (error) {
    if (error instanceof OrthoPlanLinkRefusal) return NextResponse.json({ message: error.message, code: error.code }, { status: error.status, headers });
    return NextResponse.json({ message: "تعذّر التحقق من ارتباط الحالة. أعد القراءة قبل أي تغيير." }, { status: 500, headers });
  }
}
