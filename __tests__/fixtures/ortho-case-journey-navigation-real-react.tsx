import React from "react";
import { createRoot } from "react-dom/client";
import { OrthoCaseJourneyNavigation } from "../../components/OrthoCaseJourneyNavigation";
import {
  orthoJourneySelection, orthoJourneyTabId, sameOrthoJourneySelection,
  type OrthoJourneyLocale, type OrthoJourneyNavigationRequest, type OrthoJourneyStep,
} from "../../lib/ortho-case-journey-navigation";

// A synthetic caller, not the clinical owner or persistence implementation.
const root = createRoot(document.getElementById("root")!);
let selection = orthoJourneySelection("visits"), scope = {}, active = true, mounted = true;
let dirty = false, pending = false, uncertain = false, allowDirty = false, latest = 0;
let mode: "accept" | "refuse" | "hold" = "accept", locale: OrthoJourneyLocale = "ar";
const requested: Array<{ from: string; to: string; pillar: string; source: string }> = [];
const held: Array<() => void> = [];
let guardCount = 0;
function canNavigate(request: OrthoJourneyNavigationRequest) {
  guardCount++;
  return mode !== "refuse" && active && request.scope === scope && sameOrthoJourneySelection(selection, request.from)
    && !pending && !uncertain && (!dirty || allowDirty);
}
async function onNavigate(request: OrthoJourneyNavigationRequest) {
  const ticket = ++latest;
  requested.push({ from: request.from.step, to: request.to.step, pillar: request.route.pillar, source: request.source });
  if (mode === "hold") await new Promise<void>(resolve => held.push(resolve));
  if (ticket !== latest || !active || request.scope !== scope || !sameOrthoJourneySelection(selection, request.from)) return;
  selection = request.to; render();
}
function render() {
  root.render(<React.StrictMode><main className="mx-auto max-w-5xl p-3">
    {mounted && <OrthoCaseJourneyNavigation id="synthetic-navigation" panelId="synthetic-panel" selection={selection}
      navigationScope={scope} isCurrent={() => active} canNavigate={canNavigate} onNavigate={onNavigate} locale={locale}
      evidence={{ interview: { status: "inputs_complete" }, ceph: { note: "Synthetic unavailable image" } }} />}
    <div id="synthetic-panel" role="tabpanel" aria-labelledby={orthoJourneyTabId("synthetic-navigation", selection.section)}>
      <p data-testid="selected-step">{selection.step}</p>
      <label htmlFor="retained-draft">Synthetic retained draft</label>
      <textarea id="retained-draft" className="min-h-11 w-full border" defaultValue="" onChange={() => { dirty = true; }} />
    </div>
  </main></React.StrictMode>);
}
const api = {
  snapshot: () => ({ selection, requested: [...requested], guardCount, held: held.length, active, dirty, pending, uncertain }),
  mode(value: typeof mode) { mode = value; },
  permission(value: boolean) { active = value; render(); },
  lock(value: "dirty" | "pending" | "uncertain" | "clear") {
    dirty = value === "dirty"; pending = value === "pending"; uncertain = value === "uncertain"; render();
  },
  allowDirty(value: boolean) { allowDirty = value; },
  release(index: number) { held[index]?.(); },
  replaceScope(step: OrthoJourneyStep) { scope = {}; latest++; selection = orthoJourneySelection(step); render(); },
  selection(step: OrthoJourneyStep) { selection = orthoJourneySelection(step); latest++; render(); },
  locale(value: OrthoJourneyLocale) { locale = value; render(); },
  mounted(value: boolean) { mounted = value; render(); },
};
declare global { interface Window { __orthoJourneyNavigationFixture: typeof api } }
window.__orthoJourneyNavigationFixture = api;
render();
