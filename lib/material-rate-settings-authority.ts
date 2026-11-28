import "server-only";

import { NextResponse } from "next/server";
import { ensureSchema, getPool, type DbClient } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { staffAdmissionRefusal } from "@/lib/staff-capability-editor";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { staffOperationCapabilities, staffOperationIdentity, withStaffOperation } from "@/lib/staff-operation-runtime";
import { withTransaction } from "@/lib/transactions";

const headers = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { headers, status });

type Actor = { username: string; role: string };
type Result = { body: unknown; status?: number };

export async function withMaterialRateSettingsAuthority(work: (db: DbClient, actor: Actor) => Promise<Result>) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return json({ message: "سجّل الدخول من جديد." }, 401);
  try {
    if (selected.kind === "canonical") {
      const action = "settings.view";
      const result = await withStaffOperation(getPool(), selected.handle, action, async (db, handle) => {
        const capabilities = await staffOperationCapabilities(db, handle, action, ["settings.finance.edit"]);
        if (!capabilities.has("settings.finance.edit")) return { body: { message: "لا تملك صلاحية إعدادات المالية." }, status: 403 };
        return work(db, await staffOperationIdentity(db, handle, action));
      });
      return json(result.body, result.status);
    }
    const session = await requireSession();
    if (!session) return json({ message: "سجّل الدخول من جديد." }, 401);
    if (!isAdmin(session.role)) return json({ message: "لا تملك صلاحية إعدادات المالية." }, 403);
    await ensureSchema();
    const result = await withTransaction(getPool(), db => work(db, session));
    return json(result.body, result.status);
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) return json({ code: refusal.code, message: refusal.message }, refusal.status);
    return json({ message: "تعذّر التحقق من نسب إهلاك الخدمات." }, 500);
  }
}
