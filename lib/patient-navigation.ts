import { SPECIALTIES, type ServiceSpecialty } from "./appointment-services";

/** Views over the existing patient record. These destinations never create clinical work. */
export type PatientTab = "summary" | "treatment" | "today" | "account" | "files";
export type TreatmentSubTab = "chart" | "plans" | "cases" | "endo" | "ortho" | "lab" | "referrals" | "materials";
export type OrthoPillar = "wires" | "diagnostics" | "prescription" | "retention";
/** Navigation references only; none of these values authorize or create clinical work. */
export interface ClinicalNavigationContext {
  patientId?: number;
  planId?: number;
  planItemId?: number;
  clinicalCaseId?: number;
  orthoCaseId?: number;
  endoTreatmentId?: number;
  visitId?: number;
  pillar?: OrthoPillar;
}
export interface PatientLocation {
  tab: PatientTab; sub: TreatmentSubTab;
  context?: ClinicalNavigationContext;
  contextError?: "invalid_context";
}
/** Persisted IDs in this graph use PostgreSQL INTEGER / serial, not unbounded JS numbers. */
export const CLINICAL_ID_MAX = 2_147_483_647;
export const isClinicalId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= CLINICAL_ID_MAX;
export function parseClinicalId(raw: string): number | null {
  return /^[1-9]\d*$/.test(raw) && isClinicalId(Number(raw)) ? Number(raw) : null;
}
export const CLINICAL_CONTEXT_IDS = ["patientId", "planId", "planItemId", "clinicalCaseId", "orthoCaseId", "endoTreatmentId", "visitId"] as const;
export const ORTHO_PILLARS: readonly OrthoPillar[] = ["wires", "diagnostics", "prescription", "retention"];
export function readClinicalContext(params: URLSearchParams): Pick<PatientLocation, "context" | "contextError"> {
  const context: ClinicalNavigationContext = {};
  for (const key of CLINICAL_CONTEXT_IDS) {
    if (!params.has(key)) continue;
    const values = params.getAll(key);
    if (values.length !== 1 || parseClinicalId(values[0]) === null) return { contextError: "invalid_context" };
    context[key] = Number(values[0]);
  }
  if (params.has("pillar")) {
    const pillars = params.getAll("pillar");
    if (pillars.length !== 1 || !ORTHO_PILLARS.includes(pillars[0] as OrthoPillar)) return { contextError: "invalid_context" };
    context.pillar = pillars[0] as OrthoPillar;
  }
  return Object.keys(context).length ? { context } : {};
}
export function clinicalContextSearch(context: ClinicalNavigationContext): string {
  const params = new URLSearchParams();
  for (const key of CLINICAL_CONTEXT_IDS) if (context[key] !== undefined) params.set(key, String(context[key]));
  if (context.pillar) params.set("pillar", context.pillar);
  return params.toString();
}
export function clinicalContextHref(patientId: number, context: ClinicalNavigationContext, sub: TreatmentSubTab = "cases"): string {
  return patientLocationHref(`/patients/${patientId}`, { tab: "treatment", sub, context: { ...context, patientId } });
}

const TABS: readonly string[] = ["summary", "treatment", "today", "account", "files"];
const SUBTABS: Record<string, TreatmentSubTab> = {
  chart: "chart", plans: "plans", cases: "cases", endo: "endo", ortho: "ortho", ceph: "ortho",
  lab: "lab", referrals: "referrals", materials: "materials",
};
const LEGACY_TABS: Record<string, PatientTab> = {
  overview: "summary", appointments: "summary", ledger: "account", documents: "files", visits: "today",
};
const own = <T>(values: Record<string, T>, key: string | null): T | undefined =>
  key !== null && Object.hasOwn(values, key) ? values[key] : undefined;

export function readPatientLocation(search: string | URLSearchParams): PatientLocation {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const requested = params.get("tab");
  return {
    ...readClinicalContext(params),
    tab: requested && TABS.includes(requested) ? requested as PatientTab
      : own(SUBTABS, requested) ? "treatment" : own(LEGACY_TABS, requested) ?? "summary",
    sub: own(SUBTABS, params.get("sub")) ?? own(SUBTABS, requested) ?? "chart",
  };
}

export function patientDestination(target: string, current: PatientLocation, context = current.context): PatientLocation {
  const sub = own(SUBTABS, target);
  if (sub) return { tab: "treatment", sub, ...(context ? { context } : {}), ...(current.contextError ? { contextError: current.contextError } : {}) };
  return { tab: TABS.includes(target) ? target as PatientTab : own(LEGACY_TABS, target) ?? "summary", sub: current.sub, ...(context ? { context } : {}), ...(current.contextError ? { contextError: current.contextError } : {}) };
}

export function patientLocationHref(href: string, target: PatientLocation): string {
  const url = new URL(href, "https://patient.invalid");
  for (const key of [...CLINICAL_CONTEXT_IDS, "pillar"]) url.searchParams.delete(key);
  if (target.context) new URLSearchParams(clinicalContextSearch(target.context)).forEach((value, key) => url.searchParams.set(key, value));
  // Malformed context must remain visibly invalid until the user explicitly clears it.
  if (target.contextError) url.searchParams.set("patientId", "invalid");
  url.searchParams.set("tab", target.tab);
  // Keep the last treatment workspace when viewing the account/summary as well.
  // Existing unrelated query parameters and fragment are deliberately retained.
  if (target.tab === "treatment" || target.sub !== "chart") url.searchParams.set("sub", target.sub);
  else url.searchParams.delete("sub");
  return `${url.pathname}${url.search}${url.hash}`;
}

const sameView = (a: PatientLocation, b: PatientLocation) => a.tab === b.tab && a.sub === b.sub
  && a.contextError === b.contextError && clinicalContextSearch(a.context ?? {}) === clinicalContextSearch(b.context ?? {});

/**
 * Guarded URL updates for the current patient page, not a history/router engine.
 * Replacing only the active entry preserves the released app's page Back/Forward
 * behavior; tab changes do not create history entries that would need reversing.
 */
export function createPatientNavigation(host: Window, options: {
  canLeave: (from: PatientLocation, to: PatientLocation) => boolean;
  onChange: (location: PatientLocation) => void;
}) {
  const pathname = host.location.pathname;
  // Next can commit its URL after the component renders, before this mount effect.
  // Publish that committed URL even when the next click would be a same-view no-op.
  let accepted = readPatientLocation(host.location.search);
  options.onChange(accepted);
  const restore = () => {
    if (host.location.pathname !== pathname) return;
    const next = readPatientLocation(host.location.search);
    if (!sameView(accepted, next) && !options.canLeave(accepted, next)) {
      host.history.replaceState(null, "", patientLocationHref(host.location.href, accepted));
      return;
    }
    accepted = next;
    options.onChange(next);
  };
  host.addEventListener("popstate", restore);

  return {
    dispose() { host.removeEventListener("popstate", restore); },
    navigate(target: PatientLocation): boolean {
      if (host.location.pathname !== pathname) return false;
      if (sameView(readPatientLocation(host.location.search), target)) {
        accepted = target;
        options.onChange(target);
        return true;
      }
      if (!options.canLeave(readPatientLocation(host.location.search), target)) return false;
      const href = patientLocationHref(host.location.href, target);
      // This documented Next API copies its own private routing state. No other
      // history entry is changed, and no delayed traversal/correction is queued.
      host.history.replaceState(null, "", href);
      accepted = target;
      options.onChange(target);
      return true;
    },
  };
}


/** Ceph navigation preserves the originating work without changing the study's ownership. */
export function cephStudyHref(analysisId: number, context: ClinicalNavigationContext): string {
  return `/ceph/${analysisId}?${clinicalContextSearch({ ...context, pillar: "diagnostics" })}`;
}
export function cephReturnHref(analysis: { patientId: number; orthoCaseId: number | null }, search = ""): string {
  const parsed = readClinicalContext(new URLSearchParams(search));
  const source = parsed.context;
  const samePatient = source?.patientId === analysis.patientId;
  const sameCase = analysis.orthoCaseId !== null && source?.orthoCaseId === analysis.orthoCaseId;
  const retained = samePatient && sameCase ? source : {};
  return clinicalContextHref(analysis.patientId, { ...retained,
    ...(analysis.orthoCaseId !== null ? { orthoCaseId: analysis.orthoCaseId } : {}), pillar: "diagnostics" }, "ortho");
}
export interface VerifiedClinicalContext {
  context: ClinicalNavigationContext;
  specialty: ServiceSpecialty | null;
  sub: "cases" | "ortho" | "endo";
}
/** Strict transport boundary: never coerce a derived identity or truthy success flag. */
export function decodeClinicalContext(value: unknown, patientId: number, requested: ClinicalNavigationContext): VerifiedClinicalContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isClinicalId(patientId)) return null;
  const dto = value as Record<string, unknown>;
  if (dto.ok !== true || !dto.context || typeof dto.context !== "object" || Array.isArray(dto.context)) return null;
  const raw = dto.context as Record<string, unknown>;
  if (Object.keys(raw).some((key) => ![...CLINICAL_CONTEXT_IDS, "pillar"].includes(key as typeof CLINICAL_CONTEXT_IDS[number] | "pillar"))) return null;
  for (const key of CLINICAL_CONTEXT_IDS) if (Object.hasOwn(raw, key) && !isClinicalId(raw[key])) return null;
  if (raw.patientId !== patientId) return null;
  if (Object.hasOwn(raw, "pillar") && !ORTHO_PILLARS.includes(raw.pillar as OrthoPillar)) return null;
  if (!(dto.specialty === null || typeof dto.specialty === "string" && (SPECIALTIES as readonly string[]).includes(dto.specialty))) return null;
  const context = raw as ClinicalNavigationContext;
  for (const [key, expected] of Object.entries(requested)) if (expected !== undefined && raw[key] !== expected) return null;
  if (context.planItemId !== undefined && context.planId === undefined) return null;
  if (context.clinicalCaseId !== undefined && dto.specialty === null) return null;
  if (context.orthoCaseId !== undefined && (dto.specialty !== "orthodontics" || context.endoTreatmentId !== undefined)) return null;
  if (context.endoTreatmentId !== undefined && (dto.specialty !== "endodontics" || context.clinicalCaseId === undefined)) return null;
  if (dto.specialty !== null && context.clinicalCaseId === undefined && context.orthoCaseId === undefined) return null;
  if (context.pillar !== undefined && dto.specialty !== null && dto.specialty !== "orthodontics") return null;
  const sub = context.orthoCaseId !== undefined ? "ortho" : dto.specialty === "endodontics" ? "endo" : "cases";
  if (dto.sub !== sub) return null;
  return { context, specialty: dto.specialty as ServiceSpecialty | null, sub };
}
