import { ADULT_FDI_TEETH, PRIMARY_FDI_TEETH } from "./lab";
import { validateLabPrescription, type LabPrescriptionInput } from "./lab-prescription-input";

export type LabWorkGroupKind = "single" | "bridge";
export interface LabWorkDraft {
  intentId: string;
  memberId: string;
  expectedRevision: number;
  groupKind: LabWorkGroupKind;
  prescription: LabPrescriptionInput;
}
/** These source fields must be resolved/validated by the source writer, not trusted from lab JSON. */
export interface LabWorkSourceRow {
  serviceId: number;
  toothCode: number | null;
  quantity: number;
  planItemId: number | null;
  doctorId: number | null;
  category: string | null;
  labWork?: unknown;
}
export interface LabWorkMember {
  memberId: string;
  serviceId: number;
  toothCode: number;
  quantity: number;
  planItemId: number | null;
  doctorId: number | null;
  category: "crown" | "bridge" | "veneer";
}
export interface LabWorkGroup {
  intentId: string;
  expectedRevision: number;
  groupKind: LabWorkGroupKind;
  prescription: LabPrescriptionInput;
  members: LabWorkMember[];
}
export interface LabWorkRetirement {
  intentId: string;
  expectedRevision: number;
  memberIds: string[];
}
export interface LabWorkCommand {
  groups: LabWorkGroup[];
  retirements: LabWorkRetirement[];
}

export class LabWorkContractError extends Error {
  constructor(readonly code: "invalid" | "unsupported_scope" | "conflicting_group" | "duplicate_member" | "source_mismatch") {
    super("بيانات عمل المختبر غير متوافقة؛ راجع هوية المجموعة والأعضاء ونطاق العمل صراحةً.");
  }
}
const fail = (code: LabWorkContractError["code"] = "invalid"): never => { throw new LabWorkContractError(code); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = (value: unknown): string => typeof value === "string" && UUID.test(value) ? value.toLowerCase() : fail();
const validTeeth = new Set<number>([...Object.values(ADULT_FDI_TEETH).flat(), ...Object.values(PRIMARY_FDI_TEETH).flat()]);
const keysOnly = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) fail();
};

/** Absence is preserved, never upgraded into an implicit prescription. */
export function parseLabWorkDraft(value: unknown): LabWorkDraft | null {
  if (value === undefined || value === null) return null;
  if (!record(value)) return fail();
  keysOnly(value, ["intentId", "memberId", "expectedRevision", "groupKind", "prescription"]);
  if (!revision(value.expectedRevision) || !["single", "bridge"].includes(String(value.groupKind))) return fail();
  let prescription: LabPrescriptionInput;
  try { prescription = validateLabPrescription(value.prescription, false); }
  catch { return fail(); }
  // Stable property order; arbitrary JSON object key order must not alter replay identity.
  prescription = {
    partyId: prescription.partyId, shade: prescription.shade, stumpShade: prescription.stumpShade,
    toothNumbers: prescription.toothNumbers, dueDate: prescription.dueDate,
    impressionType: prescription.impressionType, priority: prescription.priority,
  };
  return { intentId: uuid(value.intentId), memberId: uuid(value.memberId), expectedRevision: value.expectedRevision,
    groupKind: value.groupKind as LabWorkGroupKind, prescription };
}

/** Explicit retirements only. The writer must lock/revalidate their ownership and revision. */
export function parseLabWorkRetirements(value: unknown = []): LabWorkRetirement[] {
  if (!Array.isArray(value) || value.length > 128) return fail();
  const seenIntents = new Set<string>(), seenMembers = new Set<string>();
  return value.map(raw => {
    if (!record(raw)) return fail();
    keysOnly(raw, ["intentId", "expectedRevision", "memberIds"]);
    const intentId = uuid(raw.intentId);
    if (seenIntents.has(intentId) || !revision(raw.expectedRevision) || !Array.isArray(raw.memberIds)
      || !raw.memberIds.length || raw.memberIds.length > 64) return fail();
    seenIntents.add(intentId);
    const memberIds = raw.memberIds.map(member => {
      const id = uuid(member);
      if (seenMembers.has(id)) return fail("duplicate_member");
      seenMembers.add(id); return id;
    }).sort();
    return { intentId, expectedRevision: raw.expectedRevision, memberIds };
  }).sort((a, b) => a.intentId.localeCompare(b.intentId));
}

/** No DB reads, grouping heuristics, UUID generation, legacy backfill or money fields. */
export function normalizeLabWorkGroups(rows: readonly LabWorkSourceRow[], retirementInput: unknown = []): LabWorkCommand {
  if (!Array.isArray(rows) || rows.length > 128) return fail();
  const groups = new Map<string, LabWorkGroup>(), seenMembers = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return fail();
    const draft = parseLabWorkDraft(row.labWork);
    if (!draft) continue;
    if (!positive(row.serviceId) || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 64
      || (row.planItemId !== null && !positive(row.planItemId)) || (row.doctorId !== null && !positive(row.doctorId))) return fail();
    if (row.toothCode === null || !validTeeth.has(row.toothCode)) return fail("unsupported_scope");
    if (!["crown", "bridge", "veneer"].includes(row.category ?? "")) return fail("source_mismatch");
    if ((draft.groupKind === "bridge") !== (row.category === "bridge")) return fail("source_mismatch");
    if (draft.groupKind === "single" && row.quantity !== 1) return fail("unsupported_scope");
    if (seenMembers.has(draft.memberId)) return fail("duplicate_member");
    seenMembers.add(draft.memberId);
    const member: LabWorkMember = { memberId: draft.memberId, serviceId: row.serviceId, toothCode: row.toothCode,
      quantity: row.quantity, planItemId: row.planItemId, doctorId: row.doctorId, category: row.category as LabWorkMember["category"] };
    const existing = groups.get(draft.intentId);
    if (existing) {
      if (existing.expectedRevision !== draft.expectedRevision || existing.groupKind !== draft.groupKind
        || JSON.stringify(existing.prescription) !== JSON.stringify(draft.prescription)) return fail("conflicting_group");
      existing.members.push(member);
    } else groups.set(draft.intentId, { intentId: draft.intentId, expectedRevision: draft.expectedRevision,
      groupKind: draft.groupKind, prescription: draft.prescription, members: [member] });
  }
  const retirements = parseLabWorkRetirements(retirementInput);
  for (const retired of retirements) {
    if (retired.memberIds.some(id => seenMembers.has(id))) return fail("conflicting_group");
    const group = groups.get(retired.intentId);
    if (group && group.expectedRevision !== retired.expectedRevision) return fail("conflicting_group");
  }
  const result = [...groups.values()].sort((a, b) => a.intentId.localeCompare(b.intentId));
  for (const group of result) {
    group.members.sort((a, b) => a.memberId.localeCompare(b.memberId));
    if (group.members.length > 64) return fail("unsupported_scope");
    if (group.groupKind === "single" && group.members.length !== 1) return fail("conflicting_group");
    if (group.prescription.toothNumbers) {
      const tokens = group.prescription.toothNumbers.split(",").map(token => token.trim());
      const selected = tokens.map(token => Number(token.slice(0, 2)));
      const allowedRoles = group.groupKind === "bridge" ? ["Abutment", "Pontic"]
        : group.members[0].category === "veneer" ? ["Veneer"] : ["Crown", "Implant Crown"];
      if (tokens.some(token => !allowedRoles.includes(token.match(/\(([^)]+)\)/)?.[1] ?? ""))) return fail("source_mismatch");
      if (group.members.some(member => !selected.includes(member.toothCode))) return fail("source_mismatch");
      if (group.groupKind === "single" && selected.length !== 1) return fail("source_mismatch");
    }
  }
  return { groups: result, retirements };
}

/** Canonical lab portion only. The outer source-command hash MUST also include all invoice/visit fields and actor/source scope. */
export function labWorkFingerprint(command: LabWorkCommand): string {
  return JSON.stringify(command);
}
