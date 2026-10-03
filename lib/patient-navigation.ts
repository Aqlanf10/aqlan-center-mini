/** Views over the existing patient record. These destinations never create clinical work. */
export type PatientTab = "summary" | "treatment" | "today" | "account" | "files";
export type TreatmentSubTab = "chart" | "plans" | "cases" | "endo" | "ortho" | "lab" | "referrals" | "materials";
export interface PatientLocation { tab: PatientTab; sub: TreatmentSubTab }

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
    tab: requested && TABS.includes(requested) ? requested as PatientTab
      : own(SUBTABS, requested) ? "treatment" : own(LEGACY_TABS, requested) ?? "summary",
    sub: own(SUBTABS, params.get("sub")) ?? own(SUBTABS, requested) ?? "chart",
  };
}

export function patientDestination(target: string, current: PatientLocation): PatientLocation {
  const sub = own(SUBTABS, target);
  if (sub) return { tab: "treatment", sub };
  return { tab: TABS.includes(target) ? target as PatientTab : own(LEGACY_TABS, target) ?? "summary", sub: current.sub };
}

export function patientLocationHref(href: string, target: PatientLocation): string {
  const url = new URL(href, "https://patient.invalid");
  url.searchParams.set("tab", target.tab);
  // Keep the last treatment workspace when viewing the account/summary as well.
  // Existing unrelated query parameters and fragment are deliberately retained.
  if (target.tab === "treatment" || target.sub !== "chart") url.searchParams.set("sub", target.sub);
  else url.searchParams.delete("sub");
  return `${url.pathname}${url.search}${url.hash}`;
}

const sameView = (a: PatientLocation, b: PatientLocation) => a.tab === b.tab && a.sub === b.sub;

/**
 * Guarded URL updates for the current patient page, not a history/router engine.
 * Replacing only the active entry preserves the released app's page Back/Forward
 * behavior; tab changes do not create history entries that would need reversing.
 */
export function createPatientNavigation(host: Window, options: {
  canLeave: () => boolean;
  onChange: (location: PatientLocation) => void;
}) {
  const pathname = host.location.pathname;
  // Next can commit its URL after the component renders, before this mount effect.
  // Publish that committed URL even when the next click would be a same-view no-op.
  options.onChange(readPatientLocation(host.location.search));

  return {
    navigate(target: PatientLocation): boolean {
      if (host.location.pathname !== pathname) return false;
      if (sameView(readPatientLocation(host.location.search), target)) {
        options.onChange(target);
        return true;
      }
      if (!options.canLeave()) return false;
      const href = patientLocationHref(host.location.href, target);
      // This documented Next API copies its own private routing state. No other
      // history entry is changed, and no delayed traversal/correction is queued.
      host.history.replaceState(null, "", href);
      options.onChange(target);
      return true;
    },
  };
}
