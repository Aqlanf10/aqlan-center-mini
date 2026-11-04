import type { SpaceLedgerRead } from "./ortho-space-store";
import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { readSpaceSavedContent } from "./ortho-space-saved";
import { readSpaceCommand, type SpaceCommand } from "./ortho-space-ledger";
export async function spaceHash(value: unknown) {
  const bytes = new TextEncoder().encode(canonicalJourneyJSON(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
export function readSpaceDraft(value: string): SpaceCommand | null {
  try { const p = readSpaceCommand(JSON.parse(value)); return p.ok ? p.value : null; } catch { return null; }
}
export async function verifySpaceRead(raw: unknown, patientId: number, caseId: number): Promise<SpaceLedgerRead | null> {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as SpaceLedgerRead;
  if (r.ok !== true || r.patientId !== patientId || r.orthoCaseId !== caseId || !Number.isSafeInteger(r.clinicalCaseId)
    || typeof r.writable !== "boolean" || !Array.isArray(r.history) || r.history.length > 5000 || !Array.isArray(r.plans)
    || !r.choices || !Array.isArray(r.choices.baselines) || !Array.isArray(r.choices.adjustments) || !r.ipr || !Array.isArray(r.ipr.current) || !Array.isArray(r.ipr.totals)) return null;
  if (r.headId !== (r.history[0]?.id ?? null)) return null;
  for (const [i, h] of r.history.entries()) {
    const p = readSpaceSavedContent(h.content);
    if (!p.ok || h.patientId !== patientId || h.orthoCaseId !== caseId || h.clinicalCaseId !== r.clinicalCaseId || h.schemaVersion !== 1
      || !Number.isSafeInteger(h.id) || h.id <= 0 || h.version !== r.history.length - i || h.predecessorId !== (r.history[i + 1]?.id ?? null)
      || await spaceHash(p.value) !== h.contentHash) return null;
  }
  return r;
}
export async function confirmsSpaceWrite(raw: unknown, command: SpaceCommand, patientId: number, caseId: number, clinicalCaseId: number, status: number): Promise<boolean> {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as { ok?: boolean; replayed?: boolean; commandId?: string; requestFingerprint?: string; revision?: SpaceLedgerRead["history"][number] };
  const h = r.revision; if (!h) return false;
  const p = readSpaceSavedContent(h.content);
  return r.ok === true && typeof r.replayed === "boolean" && status === (r.replayed ? 200 : 201) && r.commandId === command.clientRequestId
    && r.requestFingerprint === await spaceHash(command) && p.ok && canonicalJourneyJSON(p.value.authored) === canonicalJourneyJSON(command.content)
    && h.patientId === patientId && h.orthoCaseId === caseId && h.clinicalCaseId === clinicalCaseId && h.predecessorId === command.expectedHeadId
    && Number.isSafeInteger(h.id) && h.id > 0 && h.contentHash === await spaceHash(h.content);
}
