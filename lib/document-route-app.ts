// Request-context adapter kept for existing route-level security tests.
// Production Pages API and this adapter call the same authorization/body core.
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { requireSession } from "@/lib/session";
import { documentGet, documentDelete } from "@/lib/document-route-core";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return documentGet(request, context, await selectRequestStaffEnvelope(), requireSession);
}
export async function DELETE(request: Request, context: Context) {
  return documentDelete(request, context, await selectRequestStaffEnvelope(), requireSession);
}
