import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { APPLIANCE_LABEL, ARCHES_LABEL, SLOT_LABEL, usesArchwires, type Appliance, type Arches, type SlotSize } from "./ortho";
export interface OpenAssessmentCommand {
    schemaVersion: 1;
    clientRequestId: string;
    reason: string;
}
export interface StartTreatmentCommand extends OpenAssessmentCommand {
    confirmed: true;
    appliance: Appliance;
    arches: Arches;
    slot: SlotSize | null;
    startDate: string;
    plannedMonths: number;
    bracketSystem: string;
}
export interface IntakeReceipt {
    ok: true;
    patientId: number;
    orthoCaseId: number;
    clinicalCaseId: number;
    actorId: number;
    commandId: string;
    requestFingerprint: string;
    mode: "created" | "existing" | "started" | "replayed";
}
function plain(raw: unknown): raw is Record<string, unknown> { return !!raw && typeof raw === "object" && !Array.isArray(raw); }
const fail = (): never => { throw Error("invalid_intake_command"); };
function base(r: Record<string, unknown>) { if (r.schemaVersion !== 1 || typeof r.clientRequestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(r.clientRequestId) || typeof r.reason !== "string" || !r.reason.trim() || r.reason.length > 500)
    return fail(); }
export function readOpenAssessmentCommand(raw: unknown): OpenAssessmentCommand {
    if (!plain(raw) || Object.keys(raw).sort().join(',') !== "clientRequestId,reason,schemaVersion")
        return fail();
    base(raw);
    return raw as unknown as OpenAssessmentCommand;
}
export function readStartTreatmentCommand(raw: unknown): StartTreatmentCommand {
    if (!plain(raw) || Object.keys(raw).sort().join(',') !== "appliance,arches,bracketSystem,clientRequestId,confirmed,plannedMonths,reason,schemaVersion,slot,startDate")
        return fail();
    base(raw);
    if (raw.confirmed !== true || typeof raw.appliance !== "string" || !Object.hasOwn(APPLIANCE_LABEL, raw.appliance) || typeof raw.arches !== "string" || !Object.hasOwn(ARCHES_LABEL, raw.arches) || (usesArchwires(raw.appliance as Appliance) ? typeof raw.slot !== "string" || !Object.hasOwn(SLOT_LABEL, raw.slot) : raw.slot !== null || raw.bracketSystem !== "")
        || typeof raw.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.startDate) || !Number.isFinite(Date.parse(raw.startDate)) || new Date(raw.startDate).toISOString().slice(0, 10) !== raw.startDate || typeof raw.plannedMonths !== "number" || !Number.isInteger(raw.plannedMonths) || raw.plannedMonths < 1 || raw.plannedMonths > 120 || typeof raw.bracketSystem !== "string" || raw.bracketSystem.length > 80)
        return fail();
    return raw as unknown as StartTreatmentCommand;
}
export async function verifyIntakeReceipt(raw: unknown, expected: {
    patientId: number;
    actorId: number;
    command: OpenAssessmentCommand | StartTreatmentCommand;
    orthoCaseId?: number;
}, status: number): Promise<IntakeReceipt> {
    if (!plain(raw) || Object.keys(raw).sort().join(',') !== "actorId,clinicalCaseId,commandId,mode,ok,orthoCaseId,patientId,requestFingerprint" || raw.ok !== true || raw.patientId !== expected.patientId || raw.actorId !== expected.actorId || raw.commandId !== expected.command.clientRequestId
        || ![raw.orthoCaseId, raw.clinicalCaseId].every(x => typeof x === "number" && Number.isSafeInteger(x) && x > 0) || expected.orthoCaseId !== undefined && raw.orthoCaseId !== expected.orthoCaseId
        || !("confirmed" in expected.command ? ["started", "replayed"] : ["created", "existing", "replayed"]).includes(String(raw.mode)) || status !== (raw.mode === "created" || raw.mode === "started" ? 201 : 200))
        return fail();
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJourneyJSON(expected.command))))].map(v => v.toString(16).padStart(2, "0")).join("");
    if (raw.requestFingerprint !== digest)
        return fail();
    return raw as unknown as IntakeReceipt;
}
