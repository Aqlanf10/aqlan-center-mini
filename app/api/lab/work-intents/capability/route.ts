import { NextResponse } from "next/server";
import { getPool, type DbClient } from "@/lib/db";
import { requireSession, revalidateSessionInTransaction } from "@/lib/session";
import { labWorkIntentSupported } from "@/lib/lab-work-intent-db";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { CanonicalLabDirectoryRefusal, readCanonicalLabWorkIntentCapability } from "@/lib/canonical-lab-directory";
export const dynamic = "force-dynamic";

const SESSION_ENDED = "انتهت الجلسة. سجّل الدخول من جديد.";
/** M2 slice 70a: the canonical branch of a lab-directory request — never the legacy session. */
async function canonicalDirectory(run: (handle: import("@/lib/staff-durable-session").VerifiedDurableSession) => Promise<unknown>, fallback: string, status = 200): Promise<NextResponse | null> {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: SESSION_ENDED }, { status: 401, headers: NO_STORE });
  if (selected.kind !== "canonical") return null;
  try {
    return NextResponse.json(await run(selected.handle), { status, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalLabDirectoryRefusal) return NextResponse.json({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }, { status: error.status, headers: NO_STORE });
    return canonicalPatientReadFailure(error, fallback);
  }
}
const json = (body: { supported: boolean; message?: string }, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const unauthenticated = () => json({ supported: false, message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
/** Read only feature detection. A missing proposal never triggers schema installation. */
export async function GET() {
  {
    const canonical = await canonicalDirectory(handle => readCanonicalLabWorkIntentCapability(handle), "تعذّر التحقق من إتاحة أعمال المختبر. أعد المحاولة.");
    if (canonical) return canonical;
  }
  let client: DbClient | undefined;
  let discardClient = false;
  const rollback = async () => {
    if (!client) return;
    try { await client.query("ROLLBACK"); }
    catch (error) {
      // A failed rollback leaves transaction state unproven. pg release(true)
      // removes this connection instead of returning it to the reusable pool.
      discardClient = true;
      throw error;
    }
  };
  try {
    const session = await requireSession();
    if (!session) return unauthenticated();
    client = await getPool().connect();
    await client.query("BEGIN");
    const active = await revalidateSessionInTransaction(session, client);
    // Capability detection has the same explicit role boundary as its commands.
    // Revalidation still precedes admission; revoked authority is never a 200.
    const response = !active ? unauthenticated()
      : !["admin", "doctor"].includes(active.role)
        ? json({ supported: false, message: "هذه العملية للطبيب أو المدير." }, 403)
        : json({ supported: await labWorkIntentSupported(client) });
    await rollback();
    return response;
  } catch {
    if (!discardClient) await rollback().catch(() => {});
    return json({ supported: false, message: "تعذّر التحقق من إتاحة أعمال المختبر. أعد المحاولة." }, 503);
  } finally {
    if (discardClient) client?.release(true);
    else client?.release();
  }
}
