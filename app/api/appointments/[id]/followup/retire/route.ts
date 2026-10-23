import { requireSession } from "@/lib/session";
import { retireAppointmentFollowup } from "@/lib/appointment-followup-db";
import { parseFollowupCommand } from "@/lib/appointment-followup-contract";
import { followupJson, followupError } from "@/lib/appointment-followup-http";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const validId = (id: string | null) => id !== null && /^[1-9]\d*$/.test(id) && Number(id) <= 2147483647;
export async function POST(request: Request, context: Context) {
  const session = await requireSession();
  if (!session) return followupJson({ message: "انتهت الجلسة." }, 401);
  if (!["admin", "reception"].includes(session.role)) return followupJson({ message: "غير مصرّح." }, 403);
  const { id } = await context.params;
  if (!validId(id) || new URL(request.url).search) return followupJson({ message: "سياق الموعد غير صالح." }, 400);
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); }
  catch (error) { return bodyErrorResponse(error) ?? followupJson({ message: "طلب غير صالح." }, 400); }
  const command = parseFollowupCommand(body);
  if (!command || command.appointmentId !== Number(id)) return followupJson({ message: "طلب متابعة غير صالح." }, 400);
  try {
    const result = await retireAppointmentFollowup(command, session);
    return followupJson(result);
  } catch (error) { return followupError(error); }
}
