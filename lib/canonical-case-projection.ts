import { CASE_STATUSES, PROBLEM_STATUSES, isDependencyMet, type CaseStatus, type ProblemStatus, type DependencyRequirement } from "./cases";

export const CASE_READ_LIMITS = { cases: 1000, problems: 1000, items: 2000, dependencies: 4000 } as const;
export interface CanonicalCaseRow {
  id: number | null; kind: "specialty" | "ortho"; orthoCaseId: number | null; specialty: string;
  title: string; site: string | null; problem: string | null; responsibleName: string | null;
  status: CaseStatus; startedOn: string; completedAt: string | null; outcome: string | null; version: string | null;
}
export interface CanonicalProblemRow {
  id: number; label: string; site: string | null; specialty: string | null; status: ProblemStatus;
  caseId: number | null; notedBy: string; notedAt: string; resolvedBy: string | null; resolvedAt: string | null;
}
export interface CanonicalCaseItem {
  id: number; planId: number; planTitle: string; planStatus: string; serviceName: string; category: string | null;
  toothCode: number | null; surfaces: string | null; status: string; doctorName: string | null;
  caseId: number | null; priority: number | null; sortOrder: number;
}
export interface CanonicalCaseDependency {
  itemId: number; requiresItemId: number; requirement: DependencyRequirement; note: string | null; met: boolean; createdBy: string; version: string;
}
export interface CanonicalPatientCases {
  projection: "patient-cases-clinical"; patientId: number; planVisible: boolean; orthoVisible: boolean;
  cases: CanonicalCaseRow[]; problems: CanonicalProblemRow[]; items: CanonicalCaseItem[]; dependencies: CanonicalCaseDependency[];
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: unknown, expected: string) => record(v) && Object.keys(v).sort().join(",") === expected.split(" ").sort().join(",");
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const nullableId = (v: unknown) => v === null || id(v);
const text = (v: unknown): v is string => typeof v === "string";
const nullableText = (v: unknown) => v === null || text(v);
const time = (v: unknown) => text(v) && /^\d{4}-\d{2}-\d{2}[T ]/.test(v) && Number.isFinite(Date.parse(v));
const date = (v: unknown) => text(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

/** Exact clinical allowlist; a partial or malformed graph is never presented as complete. */
export function isCanonicalPatientCases(value: unknown, patientId: number): value is CanonicalPatientCases {
  if (!keys(value, "projection patientId planVisible orthoVisible cases problems items dependencies")) return false;
  const b = value as CanonicalPatientCases;
  if (b.projection !== "patient-cases-clinical" || b.patientId !== patientId || !id(patientId) || typeof b.planVisible !== "boolean" || typeof b.orthoVisible !== "boolean") return false;
  for (const group of ["cases", "problems", "items", "dependencies"] as const) if (!Array.isArray(b[group]) || b[group].length > CASE_READ_LIMITS[group]) return false;
  const cases = new Set<number>(), native = new Set<number>(), problems = new Set<number>(), items = new Set<number>(), edges = new Set<string>();
  for (const c of b.cases) {
    if (!keys(c, "id kind orthoCaseId specialty title site problem responsibleName status startedOn completedAt outcome version")
      || !nullableId(c.id) || !nullableId(c.orthoCaseId) || !text(c.specialty) || !text(c.title) || !nullableText(c.site)
      || !nullableText(c.problem) || !nullableText(c.responsibleName) || !CASE_STATUSES.includes(c.status) || !date(c.startedOn)
      || c.completedAt !== null && !time(c.completedAt) || !nullableText(c.outcome)
      || (c.kind === "specialty" && c.orthoCaseId === null ? typeof c.version !== "string" || !/^[a-f0-9]{64}$/.test(c.version) : c.version !== null)) return false;
    if (c.kind === "specialty") { if (!id(c.id) || cases.has(c.id)) return false; cases.add(c.id); }
    else if (c.kind !== "ortho" || c.id !== null || !id(c.orthoCaseId)) return false;
    if (c.orthoCaseId !== null) { if (native.has(c.orthoCaseId) || !b.orthoVisible || c.specialty !== "orthodontics") return false; native.add(c.orthoCaseId); }
    if (!b.orthoVisible && c.specialty === "orthodontics") return false;
  }
  for (const p of b.problems) {
    if (!keys(p, "id label site specialty status caseId notedBy notedAt resolvedBy resolvedAt") || !id(p.id) || problems.has(p.id)
      || !text(p.label) || !nullableText(p.site) || !nullableText(p.specialty) || !PROBLEM_STATUSES.includes(p.status)
      || p.caseId !== null && !cases.has(p.caseId) || !text(p.notedBy) || !time(p.notedAt) || !nullableText(p.resolvedBy)
      || p.resolvedAt !== null && !time(p.resolvedAt)) return false;
    problems.add(p.id);
  }
  if (!b.planVisible && (b.items.length || b.dependencies.length)) return false;
  for (const i of b.items) {
    if (!keys(i, "id planId planTitle planStatus serviceName category toothCode surfaces status doctorName caseId priority sortOrder")
      || !id(i.id) || items.has(i.id) || !id(i.planId) || !text(i.planTitle) || !["active", "completed", "cancelled"].includes(i.planStatus)
      || !text(i.serviceName) || !nullableText(i.category) || !nullableText(i.surfaces) || i.toothCode !== null && (!Number.isSafeInteger(i.toothCode) || i.toothCode < 0)
      || !["planned", "in_progress", "done", "cancelled"].includes(i.status) || !nullableText(i.doctorName)
      || i.caseId !== null && !cases.has(i.caseId) || i.priority !== null && (!id(i.priority) || i.priority > 999)
      || !Number.isSafeInteger(i.sortOrder)) return false;
    items.add(i.id);
  }
  const statusByItem = new Map(b.items.map(i => [i.id, i.status]));
  const children = new Map<number, number[]>(), incoming = new Map(b.items.map(i => [i.id, 0]));
  for (const d of b.dependencies) {
    const key = `${d.itemId}:${d.requiresItemId}`;
    if (!keys(d, "itemId requiresItemId requirement note met createdBy version") || !items.has(d.itemId) || !items.has(d.requiresItemId)
      || d.itemId === d.requiresItemId || edges.has(key) || !["completed", "clearance"].includes(d.requirement)
      || !nullableText(d.note) || typeof d.met !== "boolean" || !text(d.createdBy) || typeof d.version !== "string" || !/^[a-f0-9]{64}$/.test(d.version)
      || d.met !== isDependencyMet(d.requirement, statusByItem.get(d.requiresItemId)!)) return false;
    edges.add(key);
    incoming.set(d.itemId, incoming.get(d.itemId)! + 1);
    children.set(d.requiresItemId, [...(children.get(d.requiresItemId) ?? []), d.itemId]);
  }
  const queue = [...incoming].filter(([, degree]) => degree === 0).map(([key]) => key);
  for (let n = 0; n < queue.length; n++) for (const child of children.get(queue[n]) ?? []) {
    const remaining = incoming.get(child)! - 1; incoming.set(child, remaining); if (remaining === 0) queue.push(child);
  }
  return queue.length === items.size;
}
