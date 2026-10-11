"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  ORTHO_JOURNEY_COPY, ORTHO_JOURNEY_SECTIONS, ORTHO_JOURNEY_STEPS,
  adjacentOrthoJourneyStep, isOrthoJourneySection, isOrthoJourneySelection, isOrthoJourneyStep,
  orthoJourneyRouteHint, orthoJourneySectionEntry, orthoJourneySelection, orthoJourneyStepsForSection,
  orthoJourneyTabFocus, orthoJourneyTabId, sameOrthoJourneySelection,
  type OrthoJourneyDirection, type OrthoJourneyLocale, type OrthoJourneyNavigationRequest,
  type OrthoJourneyNavigationSource, type OrthoJourneySection, type OrthoJourneySelection,
  type OrthoJourneyStep, type OrthoJourneyStepEvidence,
} from "../lib/ortho-case-journey-navigation";

export interface OrthoCaseJourneyNavigationProps {
  /** Unique DOM namespace per mounted case. The caller owns the stable content panel. */
  id: string;
  panelId: string;
  selection: OrthoJourneySelection;
  /** Replace on patient, case, actor/permission or read-generation lifetime change. */
  navigationScope: object;
  /** Check the actual owner at invocation time, not a captured permission boolean. */
  isCurrent: () => boolean;
  /** Required even for same-pillar substeps. No callback is sent when this refuses. */
  canNavigate: (request: OrthoJourneyNavigationRequest) => boolean;
  /**
   * The parent owns all asynchronous admission, URL changes and error reporting.
   * Recheck the scope/current selection after awaiting. Only then update selection.
   * Keep draft/pending/uncertain owners alive; this component never disposes them.
   */
  onNavigate: (request: OrthoJourneyNavigationRequest) => void | Promise<void>;
  /** Only caller-supplied evidence is displayed. Navigation never derives progress. */
  evidence?: OrthoJourneyStepEvidence;
  /** A temporary navigation lock; unrelated missing records should not set this. */
  blockedReason?: string | null;
  locale?: OrthoJourneyLocale;
  direction?: OrthoJourneyDirection;
}

/** Navigation only: no clinical children, router, persistence, saves or completion actions. */
export function OrthoCaseJourneyNavigation(props: OrthoCaseJourneyNavigationProps) {
  const {
    id, panelId, selection, navigationScope, isCurrent, canNavigate, onNavigate,
    evidence = {}, blockedReason, locale = "ar", direction = locale === "ar" ? "rtl" : "ltr",
  } = props;
  const copy = ORTHO_JOURNEY_COPY[locale];
  const committed = useRef<object | null>(null);
  // A render may be abandoned. Only the committed render can issue requests.
  const snapshot = {};
  useLayoutEffect(() => {
    committed.current = snapshot;
    return () => { if (committed.current === snapshot) committed.current = null; };
  }, [snapshot]);
  const tabs = useRef<Partial<Record<OrthoJourneySection, HTMLButtonElement | null>>>({});
  const [focus, setFocus] = useState({ scope: navigationScope, selected: selection.step, section: selection.section });
  const focusedSection = focus.scope === navigationScope && focus.selected === selection.step ? focus.section : selection.section;
  const current = () => committed.current === snapshot && isCurrent();
  const valid = isOrthoJourneySelection(selection);
  const locked = !valid || !!blockedReason;
  const sectionSteps = valid ? orthoJourneyStepsForSection(selection.section) : [];
  const activeStep = ORTHO_JOURNEY_STEPS.find(step => step.id === selection.step);
  const previous = adjacentOrthoJourneyStep(selection, "previous");
  const next = adjacentOrthoJourneyStep(selection, "next");
  const status = (step: OrthoJourneyStep) => {
    const state = evidence[step]?.status;
    return state ? copy.statuses[state] : copy.unknown;
  };

  function requestNavigation(to: OrthoJourneySelection | null, source: OrthoJourneyNavigationSource) {
    if (!to || locked || !current() || !isOrthoJourneySelection(to) || sameOrthoJourneySelection(selection, to)) return;
    const request: OrthoJourneyNavigationRequest = {
      scope: navigationScope, from: { ...selection }, to: { ...to }, source, route: orthoJourneyRouteHint(to),
    };
    if (!canNavigate(request) || !current()) return;
    // Never await-and-commit here. Parent refusal, delayed acceptance and rejection
    // leave the controlled selection unchanged. The parent reports its own errors.
    void onNavigate(request);
  }
  const selectSection = (section: OrthoJourneySection) => {
    // Re-selecting a primary section must not reset a deeper substep.
    if (section !== selection.section) requestNavigation(orthoJourneySectionEntry(section), "section");
  };

  return (
    <nav aria-label={copy.navigation} dir={direction} data-testid="ortho-case-journey-navigation"
      className="min-w-0 border-b border-slate-200 bg-white">
      <p id={`${id}-keyboard`} className="sr-only">{copy.keyboard}</p>
      <div className="space-y-2 p-3 lg:hidden">
        <label htmlFor={`${id}-section`} className="block text-xs font-bold text-slate-700">{copy.section}</label>
        <select id={`${id}-section`} value={selection.section} disabled={locked}
          aria-controls={panelId} aria-describedby={blockedReason ? `${id}-blocked` : undefined}
          className="min-h-11 w-full min-w-0 max-w-full rounded-lg border border-slate-300 bg-white p-2 text-sm font-bold text-navy-900"
          onChange={event => {
            const target = event.currentTarget.value;
            // Restore immediately if admission is denied or asynchronous.
            event.currentTarget.value = selection.section;
            if (isOrthoJourneySection(target)) selectSection(target);
          }}>
          {ORTHO_JOURNEY_SECTIONS.map(section => <option key={section} value={section}>{copy.sections[section]}</option>)}
        </select>
      </div>

      <div role="tablist" aria-label={copy.navigation} aria-orientation="horizontal" aria-describedby={`${id}-keyboard`}
        className="hidden min-w-0 border-b border-slate-200 lg:flex">
        {ORTHO_JOURNEY_SECTIONS.map(section => {
          const selected = selection.section === section;
          return <button key={section} ref={node => { tabs.current[section] = node; }} type="button" role="tab"
            id={orthoJourneyTabId(id, section)} aria-selected={selected} aria-controls={panelId}
            aria-disabled={locked} aria-describedby={blockedReason ? `${id}-blocked` : undefined}
            tabIndex={focusedSection === section ? 0 : -1}
            className={`min-h-11 min-w-0 flex-1 whitespace-normal break-words border-b-2 px-2 py-2.5 text-xs font-black transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-navy-800 ${
              selected ? "border-navy-800 bg-navy-50/40 text-navy-900" : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-800"
            }`}
            onFocus={() => { if (current()) setFocus({ scope: navigationScope, selected: selection.step, section }); }}
            onKeyDown={event => {
              if (event.altKey || event.ctrlKey || event.metaKey || !current()) return;
              const target = orthoJourneyTabFocus(section, event.key, direction);
              if (target) { event.preventDefault(); tabs.current[target]?.focus(); }
            }}
            onClick={() => selectSection(section)}>{copy.sections[section]}</button>;
        })}
      </div>

      {blockedReason ? <p id={`${id}-blocked`} role="status" className="px-3 pt-3 text-xs text-amber-900">{blockedReason}</p> : null}
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
          <span className="font-bold text-slate-700">{copy.journey}</span>
          {valid && activeStep ? <span>{copy.stepNumber} <bdi>{activeStep.order}</bdi> {copy.of} <bdi>{ORTHO_JOURNEY_STEPS.length}</bdi></span> : null}
        </div>
        <div className="space-y-2 lg:hidden">
          <label htmlFor={`${id}-step`} className="block text-xs font-bold text-slate-700">{copy.step}</label>
          <select id={`${id}-step`} value={selection.step} disabled={locked} aria-controls={panelId}
            aria-describedby={blockedReason ? `${id}-blocked` : undefined}
            className="min-h-11 w-full min-w-0 max-w-full rounded-lg border border-slate-300 bg-white p-2 text-sm"
            onChange={event => {
              const target = event.currentTarget.value;
              event.currentTarget.value = selection.step;
              if (isOrthoJourneyStep(target) && sectionSteps.some(step => step.id === target)) requestNavigation(orthoJourneySelection(target), "step");
            }}>
            {sectionSteps.map(step => <option key={step.id} value={step.id}>{step.order}. {copy.steps[step.id]} — {status(step.id)}</option>)}
          </select>
        </div>
        <ol aria-label={copy.step} className="hidden flex-wrap gap-2 lg:flex">
          {sectionSteps.map(step => <li key={step.id} value={step.order} className="min-w-0 max-w-full">
            <button type="button" aria-current={selection.step === step.id ? "step" : undefined} aria-controls={panelId}
              disabled={locked} onClick={() => requestNavigation(orthoJourneySelection(step.id), "step")}
              className={`min-h-11 max-w-full rounded-xl border px-3 py-2 text-start text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy-800 disabled:opacity-60 ${
                selection.step === step.id ? "border-navy-800 bg-navy-50 text-navy-900" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}>
              <span className="block break-words font-bold"><bdi>{step.order}</bdi>. {copy.steps[step.id]}</span>
              <span className="mt-1 block text-[11px]">{status(step.id)}</span>
            </button>
          </li>)}
        </ol>
        {valid ? <p role="status" aria-live="polite" aria-atomic="true" className="break-words text-xs text-slate-600">
          {copy.steps[selection.step]}: {status(selection.step)}
          {evidence[selection.step]?.note ? <span className="mt-1 block">{evidence[selection.step]?.note}</span> : null}
        </p> : null}
        <div className="flex flex-wrap justify-between gap-2">
          <button type="button" disabled={locked || !previous} onClick={() => requestNavigation(previous, "previous")}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50">{copy.previous}</button>
          <button type="button" disabled={locked || !next} onClick={() => requestNavigation(next, "next")}
            className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50">{copy.next}</button>
        </div>
      </div>
    </nav>
  );
}
