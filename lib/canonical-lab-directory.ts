import "server-only";
import {
  createLaboratoryWith, deleteLaboratoryWith, getLabServiceWith, getLaboratoryWith, getPool, insertAuditRow, listLabServicesWith,
  listLaboratoriesWith, updateLaboratoryWith, type Laboratory,
} from "./db";
import { labWorkIntentSupported } from "./lab-work-intent-db";
import { toWhatsAppNumber } from "./reminders";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationIdentity, withStaffOperation } from "./staff-operation-runtime";

/**
 * Canonical laboratory directory (M2 slice 70a): GET/POST /api/laboratories,
 * GET/PATCH/DELETE /api/laboratories/[id], GET /api/lab/services(/[id]) and
 * GET /api/lab/work-intents/capability.
 *
 * - Reads: one owning snapshot under clinical.lab.view (services and labs are
 *   directories, not patient records). The lab's accounting group — billing currency,
 *   expense and payable accounts, automatic journal posting, custom account name — is
 *   added only with finance.payables.record (the map's capability for lab accounting);
 *   the legacy route showed it to every role.
 * - Writes: one admitted clinical.laboratories.manage transaction (the legacy route
 *   allowed the admin role label). Contact and clinical fields only; the accounting
 *   group is REFUSED (409 lab_money_not_canonical) until a reviewed finance slice — a new
 *   lab gets the legacy defaults (YER, 5101/2101, automatic posting). The party row is
 *   locked before a change; the settings.update audit row commits with the write.
 * - Delete keeps the legacy rule: a lab with orders is deactivated, never erased.
 * - Capability: the lab work-intent schema check under clinical.lab.order (the legacy
 *   route allowed admin/doctor labels).
 * Services and pricing WRITES (finance.lab-prices.edit) are slice 70b.
 */
export class CanonicalLabDirectoryRefusal extends Error {
  constructor(readonly code: "invalid_laboratory" | "laboratory_not_found" | "lab_money_not_canonical", readonly status: 400 | 404 | 409, message: string, readonly field?: string) {
    super(message);
    this.name = "CanonicalLabDirectoryRefusal";
  }
}
const ACCOUNTING = ["currency", "expenseAccountCode", "payableAccountCode", "autoPostJournal", "customAccountName"] as const;
type ClinicalLaboratory = Omit<Laboratory, typeof ACCOUNTING[number]>;
const invalid = (message: string, field?: string) => new CanonicalLabDirectoryRefusal("invalid_laboratory", 400, message, field);
const notFound = () => new CanonicalLabDirectoryRefusal("laboratory_not_found", 404, "المختبر غير موجود.");

function project(lab: Laboratory, accounting: boolean): Laboratory | ClinicalLaboratory {
  if (accounting) return lab;
  const out: Record<string, unknown> = { ...lab };
  for (const key of ACCOUNTING) delete out[key];
  return out as ClinicalLaboratory;
}
function positiveId(raw: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) throw invalid("معرّف غير صالح.");
  return Number(raw);
}
function refuseAccounting(body: Record<string, unknown>) {
  for (const field of ACCOUNTING) {
    if (body[field] !== undefined) {
      throw new CanonicalLabDirectoryRefusal("lab_money_not_canonical", 409,
        "عملة المختبر وحساباته وترحيله الآلي لم تُنقل بعد إلى الهوية الموحّدة؛ عدّلها من شاشة الحسابات.", field);
    }
  }
}
const optionalText = (raw: unknown, max: number) => typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : null;

/** The contact and clinical fields of a create or a change (absent = unchanged on a change). */
function parseFields(body: Record<string, unknown>, creating: boolean) {
  refuseAccounting(body);
  const input: { name?: string; phone?: string | null; whatsapp?: string | null; address?: string | null; contactPerson?: string | null;
    deliveryDays?: number; note?: string | null; isActive?: boolean } = {};
  if (creating || body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) throw invalid("يرجى كتابة اسم المختبر (أقل من 120 حرف).", "name");
    input.name = name;
  }
  if (body.phone !== undefined) input.phone = optionalText(body.phone, 40);
  if (body.whatsapp !== undefined) {
    const raw = optionalText(body.whatsapp, 40);
    input.whatsapp = raw ? toWhatsAppNumber(raw) ?? raw : null;
  }
  if (body.address !== undefined) input.address = optionalText(body.address, 200);
  if (body.contactPerson !== undefined) input.contactPerson = optionalText(body.contactPerson, 100);
  if (body.deliveryDays !== undefined) {
    const days = Number(body.deliveryDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw invalid("مدة التسليم بين يوم و365 يومًا.", "deliveryDays");
    input.deliveryDays = days;
  }
  if (body.note !== undefined) input.note = optionalText(body.note, 300);
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") throw invalid("حالة التفعيل غير صالحة.", "isActive");
    input.isActive = body.isActive;
  }
  return input;
}

export async function readCanonicalLaboratories(session: VerifiedDurableSession, rawId?: string) {
  const id = rawId === undefined ? null : positiveId(rawId);
  return runCanonicalReadSnapshot(session, "clinical.lab.view", async (query, scope) => {
    const accounting = scope.granted("finance.payables.record");
    if (id !== null) {
      const lab = await getLaboratoryWith(query, id);
      if (!lab) throw notFound();
      return { laboratory: project(lab, accounting), projection: { accounting } };
    }
    return { laboratories: (await listLaboratoriesWith(query)).map(lab => project(lab, accounting)), projection: { accounting } };
  }, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 });
}

export async function readCanonicalLabServices(session: VerifiedDurableSession, params: { includeInactive: boolean; rawId?: string }) {
  const id = params.rawId === undefined ? null : positiveId(params.rawId);
  return runCanonicalReadSnapshot(session, "clinical.lab.view", async query => {
    if (id !== null) {
      const service = await getLabServiceWith(query, id);
      if (!service) throw new CanonicalLabDirectoryRefusal("laboratory_not_found", 404, "خدمة المختبر غير موجودة.");
      return { service };
    }
    return { services: await listLabServicesWith(query, params.includeInactive) };
  }, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 });
}

export async function readCanonicalLabWorkIntentCapability(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(session, "clinical.lab.order", async query => ({ supported: await labWorkIntentSupported(query) }),
    { errorPrefix: "STAFF_READ", maxBytes: 4096 });
}

export async function commandCanonicalLaboratoryCreate(session: VerifiedDurableSession, body: Record<string, unknown>, pool = getPool()) {
  const input = parseFields(body, true);
  return withStaffOperation(pool, session, "clinical.laboratories.manage", async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, "clinical.laboratories.manage");
    const lab = await createLaboratoryWith(client, { ...input, name: input.name! });
    await insertAuditRow(client, {
      action: "settings.update", entity: "laboratory", entityId: lab.id, entityLabel: lab.name,
      details: { entity: "laboratory", operation: "create", name: lab.name, deliveryDays: lab.deliveryDays, message: `إضافة مختبر جديد: ${lab.name}` },
      actor: identity.username, actorRole: identity.role,
    });
    return { laboratory: project(lab, false) };
  });
}

export async function commandCanonicalLaboratoryUpdate(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const id = positiveId(rawId);
  const input = parseFields(body, false);
  return withStaffOperation(pool, session, "clinical.laboratories.manage", async (client, handle) => {
    const { rows: [before] } = await client.query<{ id: number }>("SELECT id FROM parties WHERE id = $1 AND kind = 'lab' FOR UPDATE", [id]);
    if (!before) throw notFound();
    const previous = await getLaboratoryWith(client, id);
    const identity = await staffOperationIdentity(client, handle, "clinical.laboratories.manage");
    const lab = await updateLaboratoryWith(client, id, input);
    if (!lab || !previous) throw notFound();
    const changed = Object.fromEntries(Object.keys(input).map(key => [key, { from: previous[key as keyof Laboratory] ?? null, to: lab[key as keyof Laboratory] ?? null }]));
    await insertAuditRow(client, {
      action: "settings.update", entity: "laboratory", entityId: id, entityLabel: lab.name,
      details: { entity: "laboratory", operation: "update", changed, message: `تعديل بيانات المختبر: ${lab.name}` },
      actor: identity.username, actorRole: identity.role,
    });
    return { laboratory: project(lab, false) };
  });
}

export async function commandCanonicalLaboratoryDelete(session: VerifiedDurableSession, rawId: string, pool = getPool()) {
  const id = positiveId(rawId);
  return withStaffOperation(pool, session, "clinical.laboratories.manage", async (client, handle) => {
    const { rows: [party] } = await client.query<{ name: string }>("SELECT name FROM parties WHERE id = $1 AND kind = 'lab' FOR UPDATE", [id]);
    if (!party) throw notFound();
    const identity = await staffOperationIdentity(client, handle, "clinical.laboratories.manage");
    const result = await deleteLaboratoryWith(client, id);
    if (!result.ok) throw notFound();
    const deactivated = result.reason === "deactivated";
    await insertAuditRow(client, {
      action: "settings.update", entity: "laboratory", entityId: id, entityLabel: party.name,
      details: { entity: "laboratory", operation: deactivated ? "deactivate" : "delete", name: party.name,
        message: deactivated ? `تعطيل المختبر ${party.name} (له طلبات مسجّلة)` : `حذف المختبر ${party.name}` },
      actor: identity.username, actorRole: identity.role,
    });
    return { ok: true as const, deactivated };
  });
}
