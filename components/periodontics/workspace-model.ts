import { ALL_TEETH } from "@/lib/dental";
import { checkPerioDraft, samePerioDraft, summarizePerio, type Check, type PerioDraft, type PerioObservation, type PerioSite } from "@/lib/periodontics";
import type { PerioExamView } from "@/lib/periodontics-db";

export interface PerioVisitContext {
  id: number;
  patientId: number;
  date: string;
  signedAt: string | null;
  caseId: number | null;
}
export interface PerioCaseOption { id: number; patientId: number; title: string; specialty: string; status: string }
export interface PerioInputSite {
  toothCode: number;
  site: PerioSite;
  depthText: string;
  bleedingOnProbing: boolean | null;
}
export interface PerioEditorDraft {
  doctorId: number | null;
  /** undefined means the user has not yet chosen an optional case/no-case context. */
  caseId: number | null | undefined;
  expectedRevision: number | null;
  sites: PerioInputSite[];
}
export function editorDraft(exam: PerioExamView | null, visitCaseId: number | null): PerioEditorDraft {
  return { doctorId: exam?.doctorId ?? null, caseId: exam ? exam.caseId : visitCaseId ?? undefined,
    expectedRevision: exam?.revision ?? null,
    sites: (exam?.sites ?? []).map((row) => ({ toothCode: row.toothCode, site: row.site,
      depthText: row.probingDepthMm === null ? "" : String(row.probingDepthMm), bleedingOnProbing: row.bleedingOnProbing })) };
}
/** Glyph-only input boundary: unlike money.parseAmount, never remove grouping or round. */
export function normalizeDepthInput(text: string): string {
  return text.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0)).replace(/٫/g, ".");
}
export function parseDepthText(text: string): Check<number | null> {
  if (text === "") return { ok: true, value: null };
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || Number(text) > 99.99) {
    return { ok: false, message: "أدخل 0–99.99 بمنزلتين عشريتين كحد أقصى؛ اتركه فارغًا لغير مسجّل." };
  }
  return { ok: true, value: Number(text) };
}
export function serializeEditor(draft: PerioEditorDraft): Check<PerioDraft & { expectedRevision: number | null }> {
  const sites: PerioObservation[] = [];
  for (const row of draft.sites) {
    const depth = parseDepthText(row.depthText);
    if (!depth.ok) return { ok: false, message: `السن ${row.toothCode} / ${row.site}: ${depth.message}` };
    sites.push({ toothCode: row.toothCode, site: row.site, probingDepthMm: depth.value, bleedingOnProbing: row.bleedingOnProbing });
  }
  const checked = checkPerioDraft({ doctorId: draft.doctorId, caseId: draft.caseId, sites });
  return checked.ok ? { ok: true, value: { ...checked.value, expectedRevision: draft.expectedRevision } } : checked;
}
/** A visible cell edit never filters the full persisted snapshot, even for hidden/missing teeth. */
export function editSite(draft: PerioEditorDraft, toothCode: number, site: PerioSite, patch: Partial<Pick<PerioInputSite, "depthText" | "bleedingOnProbing">>): PerioEditorDraft {
  const key = (row: PerioInputSite) => row.toothCode === toothCode && row.site === site;
  const existing = draft.sites.find(key);
  const normalized = patch.depthText === undefined ? patch : { ...patch, depthText: normalizeDepthInput(patch.depthText) };
  const row = { ...(existing ?? { toothCode, site, depthText: "", bleedingOnProbing: null }), ...normalized };
  return { ...draft, sites: existing ? draft.sites.map((item) => key(item) ? row : item) : [...draft.sites, row] };
}
export function editorIsDirty(draft: PerioEditorDraft, baseline: PerioEditorDraft): boolean {
  const fingerprint = (value: PerioEditorDraft) => JSON.stringify({ ...value, sites: [...value.sites].sort((a, b) => a.toothCode - b.toothCode || a.site.localeCompare(b.site)) });
  return fingerprint(draft) !== fingerprint(baseline);
}
export function draftMatchesExam(draft: PerioEditorDraft, exam: PerioExamView): boolean {
  const serialized = serializeEditor(draft);
  return serialized.ok && samePerioDraft(serialized.value, exam);
}
export function draftCoverage(draft: PerioEditorDraft) {
  return summarizePerio(draft.sites.map((row) => {
    const depth = parseDepthText(row.depthText);
    return { toothCode: row.toothCode, site: row.site, probingDepthMm: depth.ok ? depth.value : null, bleedingOnProbing: row.bleedingOnProbing };
  }));
}
export function eligibleCases(cases: readonly PerioCaseOption[], patientId: number): PerioCaseOption[] {
  return cases.filter((item) => item.patientId === patientId && item.specialty === "periodontics" && ["active", "waiting"].includes(item.status));
}
export function displayedTeeth(visibleToothCodes: readonly number[] | undefined, draft: PerioEditorDraft, showRetained: boolean): number[] {
  const visible = visibleToothCodes ?? ALL_TEETH;
  const retained = showRetained ? draft.sites.map((row) => row.toothCode) : [];
  const requested = new Set([...visible, ...retained]);
  return ALL_TEETH.filter((tooth) => requested.has(tooth));
}
export function changedDraftCells(draft: PerioEditorDraft, exam: PerioExamView | null) {
  const canonical = editorDraft(exam, null);
  const key = (row: PerioInputSite) => `${row.toothCode}:${row.site}`;
  const saved = new Map(canonical.sites.map((row) => [key(row), row]));
  const local = new Map(draft.sites.map((row) => [key(row), row]));
  return [...new Set([...saved.keys(), ...local.keys()])].flatMap((identity) => {
    const prior = saved.get(identity); const next = local.get(identity);
    return JSON.stringify(prior) === JSON.stringify(next) ? [] : [{ identity, saved: prior ?? null, draft: next ?? null }];
  });
}
