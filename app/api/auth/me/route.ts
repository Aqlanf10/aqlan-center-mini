import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { findUserByUsername } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "غير مسجل الدخول." }, { status: 401 });
  }

  const user = await findUserByUsername(session.username).catch(() => null);

  return NextResponse.json({
    username: session.username,
    displayName: user?.displayName ?? session.username,
    role: session.role,
  });
}
