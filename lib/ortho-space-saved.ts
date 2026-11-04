import { readSpaceContent, type SpaceContent } from "./ortho-space-ledger";
import type { Checked } from "./ortho-case-journey-records";
export interface SpaceSavedContent {
  authored: SpaceContent;
  baseline: { discrepancyMm: number; estimated: boolean } | null;
  adjustment: { visitId: number; occurredOn: string; recordedBy: string } | null;
}
export function readSpaceSavedContent(raw: unknown): Checked<SpaceSavedContent> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "space_saved" };
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join("|") !== "adjustment|authored|baseline") return { ok: false, code: "space_saved_fields" };
  const authored = readSpaceContent(r.authored); if (!authored.ok) return authored;
  if (authored.value.kind === "plan") {
    const b = r.baseline as SpaceSavedContent["baseline"];
    if (!b || Object.keys(b).sort().join("|") !== "discrepancyMm|estimated" || !Number.isFinite(b.discrepancyMm) || typeof b.estimated !== "boolean" || r.adjustment !== null) return { ok: false, code: "space_saved_baseline" };
    return { ok: true, value: { authored: authored.value, baseline: { discrepancyMm: b.discrepancyMm, estimated: b.estimated }, adjustment: null } };
  }
  const a = r.adjustment as SpaceSavedContent["adjustment"];
  if (r.baseline !== null || !a || Object.keys(a).sort().join("|") !== "occurredOn|recordedBy|visitId" || !Number.isSafeInteger(a.visitId) || a.visitId <= 0
    || typeof a.occurredOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.occurredOn) || typeof a.recordedBy !== "string" || !a.recordedBy.trim()) return { ok: false, code: "space_saved_adjustment" };
  return { ok: true, value: { authored: authored.value, baseline: null, adjustment: { ...a } } };
}
