import { NextResponse } from "next/server";
import { ensureSchema, getPool, insertAuditRow } from "@/lib/db";
import { lockCollectionAssignment } from "@/lib/reception-collection-scope";
import { requireSession, revalidateSessionInTransaction } from "@/lib/session";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (session?.role !== "admin") return NextResponse.json({ message: "التكليف للإدارة." }, { status: session ? 403 : 401 });
  const patientId = Number((await context.params).id);
  let payload;
  try { payload = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); }
  catch (error) { return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 }); }
  const body = payload as { username?: unknown; action?: unknown } | null;
  if (!Number.isSafeInteger(patientId) || patientId < 1 || typeof body?.username !== "string" || !body.username.trim()
    || (body.action !== "grant" && body.action !== "revoke")) return NextResponse.json({ message: "تحقق من المريض وحساب الاستقبال والإجراء." }, { status: 400 });
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const actor = await revalidateSessionInTransaction(session, client);
    if (actor?.role !== "admin") {
      await client.query("ROLLBACK");
      return NextResponse.json({ message: "تغيّرت صلاحيات الحساب." }, { status: 403 });
    }
    await lockCollectionAssignment(client, patientId, "change");
    const { rows: [patient] } = await client.query("SELECT patient_number FROM patients WHERE id=$1 FOR UPDATE", [patientId]);
    const { rows: [user] } = await client.query("SELECT id FROM users WHERE lower(username)=lower($1) AND role='reception' AND is_active FOR SHARE", [body.username.trim()]);
    if (!patient || !user) {
      await client.query("ROLLBACK");
      return NextResponse.json({ message: "تعذّر العثور على المريض أو حساب الاستقبال النشط." }, { status: 404 });
    }
    await insertAuditRow(client, { action: body.action === "grant" ? "collection.assign" : "collection.revoke", entity: "patient", entityId: patientId,
      details: { collectorId: user.id, patientNumber: patient.patient_number }, actor: actor.username, actorRole: actor.role });
    await client.query("COMMIT");
    return NextResponse.json({ saved: true });
  } catch {
    await client.query("ROLLBACK");
    return NextResponse.json({ message: "تعذّر حفظ قرار التكليف." }, { status: 500 });
  } finally { client.release(); }
}
