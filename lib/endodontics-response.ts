import { crownState, endoNextAction } from "./endodontics";
import type { EndoTreatmentView } from "./endodontics-db";

/** Do not expose a plan item or derive plan progress for a caller without plan access. */
export function visibleEndoTreatment(view: EndoTreatmentView, canViewPlans: boolean): EndoTreatmentView {
  if (canViewPlans) return view;
  const crown = crownState({ status: view.status, crownRequired: view.crownRequired,
    restorative: view.restorativeStatus, crownItemDone: false });
  return { ...view, crownPlanItem: null, crown,
    nextAction: endoNextAction({ status: view.status, summary: view.summary, restorative: view.restorativeStatus, crown }) };
}
