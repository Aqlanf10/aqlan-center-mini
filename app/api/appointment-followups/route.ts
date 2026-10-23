import { requireSession } from "@/lib/session";
import { readAppointmentFollowupQueue } from "@/lib/appointment-followup-db";
import { parseFollowupPage } from "@/lib/appointment-followup-page";
import { followupJson, followupError } from "@/lib/appointment-followup-http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return followupJson({ message: "انتهت الجلسة." }, 401);
  if (!["admin", "reception"].includes(session.role)) return followupJson({ message: "غير مصرّح." }, 403);
  const options = parseFollowupPage(new URL(request.url).searchParams);
  if (!options) return followupJson({ message: "صفحة متابعة غير صالحة." }, 400);
  try { return followupJson(await readAppointmentFollowupQueue(session, options)); }
  catch (error) { return followupError(error); }
}
