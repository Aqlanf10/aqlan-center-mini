import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  createPatientFamilyOn, familyIdOfPatientWith, familyMemberBalancesInSnapshot, familyMembersInDoctorScopeWith, findFamiliesByPhoneWith,
  getPatientFamilyRecordWith, getPool, linkPatientToFamilyOn, patientInDoctorScopeWith, searchPatientFamiliesWith, setFamilyGuarantorOn,
  unlinkPatientFromFamilyOn, updateFamilyDetailsOn, type DbClient, type FamilyWriteFailure, type PatientFamilyRecord,
} from "./db";
import { familyRoleLabel, familyTotals, parseFamilyName, parseFamilyNote, parseFamilyRole, parseGuarantor, validateFamilyDraft, type CurrencyBalance, type FamilyDraft, type GuarantorDraft } from "./patient-families";
import type { FamilyView, FamilyViewMember } from "./family-view";
import { runCanonicalReadSnapshot, type CanonicalSnapshotQuery, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import { readCanonicalPatientRecord } from "./canonical-patient-reads";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { selectRequestStaffEnvelope } from "./staff-session-admission";
import type { StaffRecordConstraint } from "./staff-capabilities";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
import { stableJson } from "./canonical-lab-create";

/**
 * Canonical patient families (M2 slice 72, group 3): GET/POST /api/families,
 * GET/PATCH /api/families/[id], PUT /api/families/[id]/guarantor,
 * POST /api/families/[id]/members, DELETE /api/families/[id]/members/[patientId] and
 * GET /api/patients/[id]/family.
 *
 * - Reads: one owning snapshot. A family is a set of patient records, so a member is
 *   shown only inside the actor's patient scope (`own` = DOCTOR_PATIENT_CONDITION, as the
 *   patient list and file). A family with no member in an `own` scope reads as missing
 *   (404) — its existence and size are never disclosed. A guarantor patient outside the
 *   scope is «a guarantor» with no name or number. An empty family is visible to an `all`
 *   scope only (as in the legacy reception view).
 * - Money (owner rule 6615124926): member balances, family totals and the guarantor's
 *   phone (the statement contact) only with `finance.patient-ledger.view`, computed in the
 *   same snapshot by the canonical ledger engine. Without it no figure and no zero.
 *   Write responses never carry money (the panel re-reads).
 * - Search and phone suggestions (for linking): `patients.edit` (the map's family write
 *   capability) inside the scope; an `own` scope matches, counts and names only members
 *   inside it.
 * - Writes: one admitted `patients.edit` transaction each (the legacy route allowed the
 *   admin and reception role labels), running the legacy writer bodies unchanged (same
 *   locks, refusals and same-transaction audit rows). Every patient a write names — a
 *   new member, a guarantor patient, a member to unlink — must be inside the scope, and
 *   an existing family must have a member inside it (`all`: any family). Outside the
 *   scope answers exactly like missing.
 * - Create is idempotent by a required `requestKey`: under a transaction advisory lock on
 *   (actor, key), the receipt (the `family.create` audit row of the same transaction) is
 *   looked up first; the same request returns the first family (`replayed`), another
 *   request with the same key is refused (409), nothing is written twice.
 * - The guarantor stays information and a statement only: nothing here writes money.
 */
export class CanonicalFamilyRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409, message: string, readonly field?: string) {
    super(message);
    this.name = "CanonicalFamilyRefusal";
  }
}
export const FAMILY_RECEIPT_WINDOW = "1 day";
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const FAMILY_MAX_BYTES = 512 * 1024;
const FAILURES: Record<FamilyWriteFailure, [string, 404 | 409]> = {
  family_not_found: ["لا توجد عائلة بهذا الرقم.", 404],
  patient_not_found: ["لا يوجد مريض بهذا الرقم ضمن مرضاك.", 404],
  guarantor_not_found: ["المريض الضامن غير موجود ضمن مرضاك.", 404],
  already_in_family: ["هذا المريض مربوطٌ بعائلةٍ أخرى — افكك ربطه منها أولًا.", 409],
  not_member: ["هذا المريض ليس من أفراد هذه العائلة.", 404],
};
const failure = (reason: FamilyWriteFailure) => new CanonicalFamilyRefusal(reason, FAILURES[reason][1], FAILURES[reason][0]);
const invalid = (message: string, field?: string) => new CanonicalFamilyRefusal("invalid_family", 400, message, field);

function positiveId(raw: unknown, message: string): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw invalid(message);
  return value;
}
const doctorOf = (scope: StaffRecordConstraint): number | null => scope.kind === "own" ? scope.clinicianPartyId : null;

/* ---------------------------------------------------------------- projection */

interface Projection { readonly scope: StaffRecordConstraint; readonly money: boolean; readonly canEdit: boolean }

/** The family as the actor may see it, or null when nothing of it is in the scope. */
async function projectFamily(q: CanonicalSnapshotQuery, record: PatientFamilyRecord, projection: Projection, balancesOf: ((ids: number[]) => Promise<Map<number, CurrencyBalance[]>>) | null): Promise<FamilyView | null> {
  const { scope } = projection;
  if (scope.kind === "none") return null;
  const inside = scope.kind === "all" ? null : await familyMembersInDoctorScopeWith(q, record.id, scope.clinicianPartyId);
  const shown = inside ? record.members.filter(member => inside.has(member.id)) : record.members;
  if (inside && shown.length === 0) return null;
  const money = projection.money && balancesOf !== null;
  const balances = money && shown.length ? await balancesOf(shown.map(member => member.id)) : new Map<number, CurrencyBalance[]>();
  const members: FamilyViewMember[] = shown.map(member => ({
    id: member.id, patientNumber: member.patientNumber, fullName: member.fullName, phone: member.phone,
    role: member.role, roleLabel: familyRoleLabel(member.role),
    ...(money ? { balances: balances.get(member.id) ?? [] } : {}),
  }));
  const guarantor = record.guarantor;
  const hidden = guarantor.kind === "patient" && guarantor.patientId !== null && scope.kind === "own"
    && !await patientInDoctorScopeWith(q, scope.clinicianPartyId, guarantor.patientId);
  return {
    id: record.id, name: record.name, note: record.note,
    guarantor: {
      kind: guarantor.kind,
      patientId: hidden ? null : guarantor.patientId,
      patientNumber: hidden ? null : guarantor.patientNumber,
      name: hidden ? null : guarantor.name,
      phone: hidden || !money ? null : guarantor.phone,
      hidden,
    },
    members,
    canSeeMoney: money,
    ...(money ? { totals: familyTotals(members.map(member => ({ balances: member.balances ?? [] }))) } : {}),
    canEdit: projection.canEdit,
  };
}

const readProjection = (scope: CanonicalSnapshotScope): Projection => ({
  scope: scope.patientScope, money: scope.granted("finance.patient-ledger.view"), canEdit: scope.granted("patients.edit"),
});
const snapshotBalances = (q: CanonicalSnapshotQuery) => (ids: number[]) => familyMemberBalancesInSnapshot(ids, q as DbClient);

/* ---------------------------------------------------------------- reads */

export async function readCanonicalFamily(session: VerifiedDurableSession, rawId: string) {
  const familyId = positiveId(rawId, "رقم العائلة غير صالح.");
  return runCanonicalReadSnapshot(session, "read:families.record", async (query, scope) => {
    const record = await getPatientFamilyRecordWith(query, familyId);
    const view = record ? await projectFamily(query, record, readProjection(scope), snapshotBalances(query)) : null;
    if (!view) throw failure("family_not_found");
    return view;
  }, { errorPrefix: "STAFF_READ", maxBytes: FAMILY_MAX_BYTES });
}

/** The patient file's family panel: the patient must be inside the scope (404 like missing). */
export async function readCanonicalPatientFamily(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:families.record", patientId, async (query, scope) => {
    const projection = readProjection(scope);
    const familyId = await familyIdOfPatientWith(query, patientId);
    const record = familyId ? await getPatientFamilyRecordWith(query, familyId) : null;
    const family = record ? await projectFamily(query, record, projection, snapshotBalances(query)) : null;
    return { family, canEdit: projection.canEdit };
  }, FAMILY_MAX_BYTES);
}

export async function readCanonicalFamilySearch(session: VerifiedDurableSession, params: URLSearchParams) {
  const phone = (params.get("phone") ?? "").trim().slice(0, 40);
  const term = (params.get("q") ?? "").trim().slice(0, 80);
  return runCanonicalReadSnapshot(session, "read:families.search", async (query, scope) => {
    const doctor = doctorOf(scope.patientScope);
    if (phone) return { suggestions: await findFamiliesByPhoneWith(query, phone, 5, doctor) };
    if (term) return { families: await searchPatientFamiliesWith(query, term, 8, doctor) };
    return { families: [] };
  }, { errorPrefix: "STAFF_READ", maxBytes: 64 * 1024 });
}

/* ---------------------------------------------------------------- writes */

interface Admitted { readonly scope: StaffRecordConstraint; readonly actor: { actor: string; actorRole: string }; readonly userId: number }

async function admit(client: DbClient, handle: StaffOperationHandle): Promise<Admitted> {
  const scope = await staffOperationPatientScope(client, handle, "patients.edit");
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const identity = await staffOperationIdentity(client, handle, "patients.edit");
  return { scope, actor: { actor: identity.username, actorRole: identity.role }, userId: identity.userId };
}
async function requireInScope(client: DbClient, admitted: Admitted, patientId: number, reason: "patient_not_found" | "guarantor_not_found" = "patient_not_found") {
  if (admitted.scope.kind === "own" && !await patientInDoctorScopeWith(client, admitted.scope.clinicianPartyId, patientId)) throw failure(reason);
}
/** Lock the family row (the legacy writers' first lock, re-taken by them) and require a
 * member inside an `own` scope. */
async function lockVisibleFamily(client: DbClient, admitted: Admitted, familyId: number) {
  const { rows } = await client.query("SELECT id FROM patient_families WHERE id = $1 FOR UPDATE", [familyId]);
  if (rows.length !== 1) throw failure("family_not_found");
  if (admitted.scope.kind === "own" && (await familyMembersInDoctorScopeWith(client, familyId, admitted.scope.clinicianPartyId)).size === 0) {
    throw failure("family_not_found");
  }
}
/** The family after a write, as the writer may see it — never money (the panel re-reads
 * the family in one snapshot). After unlinking an `own` actor's last visible member the
 * family is named without members. */
async function writeView(client: DbClient, admitted: Admitted, record: PatientFamilyRecord): Promise<FamilyView> {
  const view = await projectFamily(client, record, { scope: admitted.scope, money: false, canEdit: true }, null);
  return view ?? { id: record.id, name: record.name, note: record.note,
    guarantor: { kind: record.guarantor.kind, patientId: null, patientNumber: null, name: null, phone: null, hidden: record.guarantor.kind !== "none" },
    members: [], canSeeMoney: false, canEdit: true };
}

export interface CanonicalFamilyCreate { readonly requestKey: string; readonly fingerprint: string; readonly draft: FamilyDraft }
export function parseCanonicalFamilyCreate(body: Record<string, unknown>): CanonicalFamilyCreate {
  const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
  if (!KEY_PATTERN.test(requestKey)) throw invalid("مفتاح الطلب مفقود أو غير صالح؛ أعد فتح النموذج.", "requestKey");
  const draft = validateFamilyDraft(body);
  if (!draft.ok) throw invalid(draft.message, draft.field);
  const fingerprint = createHash("sha256").update(stableJson(draft.value)).digest("hex");
  return { requestKey, fingerprint, draft: draft.value };
}

export async function commandCanonicalFamilyCreate(session: VerifiedDurableSession, body: Record<string, unknown>, pool = getPool()) {
  const request = parseCanonicalFamilyCreate(body);
  return withStaffOperation(pool, session, "patients.edit", async (client, handle) => {
    const admitted = await admit(client, handle);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('family-create:' || $1::text || ':' || $2::text))", [admitted.userId, request.requestKey]);
    const { rows: [receipt] } = await client.query<{ entity_id: string; fingerprint: string | null }>(
      `SELECT entity_id, details->>'requestFingerprint' AS fingerprint FROM audit_log
        WHERE action = 'family.create' AND created_at > NOW() - $3::interval
          AND details->>'requestKey' = $1 AND details->>'requestActorId' = $2::text
        ORDER BY id DESC LIMIT 1`,
      [request.requestKey, admitted.userId, FAMILY_RECEIPT_WINDOW]);
    if (receipt) {
      if (receipt.fingerprint !== request.fingerprint) {
        throw new CanonicalFamilyRefusal("family_request_key_reused", 409, "مفتاح الطلب استُعمل لطلب مختلف؛ أعد فتح النموذج وأرسل من جديد.");
      }
      const existing = await getPatientFamilyRecordWith(client, Number(receipt.entity_id));
      if (!existing) throw failure("family_not_found");
      // A replay is projected with the actor's CURRENT scope.
      const view = await projectFamily(client, existing, { scope: admitted.scope, money: false, canEdit: true }, null);
      if (!view) throw failure("family_not_found");
      return { ...view, replayed: true as const };
    }
    for (const member of request.draft.members) await requireInScope(client, admitted, member.patientId);
    if (request.draft.guarantor.kind === "patient") await requireInScope(client, admitted, request.draft.guarantor.patientId, "guarantor_not_found");
    const result = await createPatientFamilyOn(client, request.draft, admitted.actor, {
      requestKey: request.requestKey, requestFingerprint: request.fingerprint, requestActorId: String(admitted.userId),
    });
    if (!result.ok) throw failure(result.reason);
    return { ...await writeView(client, admitted, result.family), replayed: false as const };
  });
}

export async function commandCanonicalFamilyUpdate(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const familyId = positiveId(rawId, "رقم العائلة غير صالح.");
  const update: { name?: string; note?: string | null } = {};
  if (body.name !== undefined) {
    const name = parseFamilyName(body.name);
    if (!name.ok) throw invalid(name.message, "name");
    update.name = name.value;
  }
  if (body.note !== undefined) {
    const note = parseFamilyNote(body.note);
    if (!note.ok) throw invalid(note.message, "note");
    update.note = note.value;
  }
  if (update.name === undefined && update.note === undefined) throw invalid("لا تعديل في الطلب.");
  return withStaffOperation(pool, session, "patients.edit", async (client, handle) => {
    const admitted = await admit(client, handle);
    await lockVisibleFamily(client, admitted, familyId);
    const result = await updateFamilyDetailsOn(client, { familyId, ...update }, admitted.actor);
    if (!result.ok) throw failure(result.reason);
    return writeView(client, admitted, result.family);
  });
}

export async function commandCanonicalFamilyGuarantor(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const familyId = positiveId(rawId, "رقم العائلة غير صالح.");
  const parsed = parseGuarantor(body.guarantor ?? body);
  if (!parsed.ok) throw invalid(parsed.message, "guarantor");
  const guarantor: GuarantorDraft = parsed.value;
  return withStaffOperation(pool, session, "patients.edit", async (client, handle) => {
    const admitted = await admit(client, handle);
    await lockVisibleFamily(client, admitted, familyId);
    if (guarantor.kind === "patient") await requireInScope(client, admitted, guarantor.patientId, "guarantor_not_found");
    const result = await setFamilyGuarantorOn(client, { familyId, guarantor }, admitted.actor);
    if (!result.ok) throw failure(result.reason);
    return writeView(client, admitted, result.family);
  });
}

export async function commandCanonicalFamilyLink(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const familyId = positiveId(rawId, "رقم العائلة غير صالح.");
  const patientId = positiveId(typeof body.patientId === "number" ? body.patientId : String(body.patientId ?? ""), "اختر المريض الذي يُربط بالعائلة.");
  const role = parseFamilyRole(body.role);
  if (!role.ok) throw invalid(role.message, "role");
  return withStaffOperation(pool, session, "patients.edit", async (client, handle) => {
    const admitted = await admit(client, handle);
    await requireInScope(client, admitted, patientId);
    // An `own` actor may link its own patient into a family it can already see only.
    await lockVisibleFamily(client, admitted, familyId);
    const result = await linkPatientToFamilyOn(client, { familyId, patientId, role: role.value }, admitted.actor);
    if (!result.ok) throw failure(result.reason);
    return writeView(client, admitted, result.family);
  });
}

export async function commandCanonicalFamilyUnlink(session: VerifiedDurableSession, rawId: string, rawPatientId: string, pool = getPool()) {
  const familyId = positiveId(rawId, "رقم العائلة أو المريض غير صالح.");
  const patientId = positiveId(rawPatientId, "رقم العائلة أو المريض غير صالح.");
  return withStaffOperation(pool, session, "patients.edit", async (client, handle) => {
    const admitted = await admit(client, handle);
    await lockVisibleFamily(client, admitted, familyId);
    await requireInScope(client, admitted, patientId);
    const result = await unlinkPatientFromFamilyOn(client, { familyId, patientId }, admitted.actor);
    if (!result.ok) throw failure(result.reason);
    return writeView(client, admitted, result.family);
  });
}

/* ---------------------------------------------------------------- HTTP */

/**
 * The canonical branch of a family request: the envelope selected once; a canonical
 * cookie never falls back to the legacy session; bounded codes and Arabic messages; never
 * cached. Returns null for a legacy (or absent) envelope.
 */
export async function canonicalFamilyRoute(
  request: Request | null,
  run: (handle: VerifiedDurableSession, body: Record<string, unknown>) => Promise<unknown>,
  fallback: string,
  status = 200,
): Promise<NextResponse | null> {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind !== "canonical") return null;
  let body: Record<string, unknown> = {};
  if (request) {
    try {
      const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    } catch (error) {
      return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
  }
  try {
    return NextResponse.json(await run(selected.handle, body), { status, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalFamilyRefusal) {
      return NextResponse.json({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }, { status: error.status, headers: NO_STORE });
    }
    return canonicalPatientReadFailure(error, fallback);
  }
}
