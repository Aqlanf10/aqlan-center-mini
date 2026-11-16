import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ cursor: 0, owner: null as unknown, generation: null as unknown, values: [] as unknown[] }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined, useLayoutEffect: () => undefined, useRef: () => ({ current: null }),
  useMemo: (factory: () => unknown) => { const value = factory(); if (value && typeof value === "object") { if ("owner" in value) hooks.generation = value; else hooks.owner = value; } return value; },
  useState: () => { const value = hooks.values[hooks.cursor++]; return [typeof value === "function" ? value() : value, () => undefined]; },
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "SYN", role: "doctor" }) }));
import { OrthoCaseAssessmentV2 } from "../components/OrthoCaseAssessmentV2";
import { OrthoTreatmentStrategy } from "../components/OrthoTreatmentStrategy";
const createdAt = "2026-10-31T22:30:00.000Z";
const zones = [ ["Asia/Aden", "الأحد 01/11/2026"], ["America/New_York", "السبت 31/10/2026"], [undefined, "2026-10-31"] ] as const;
const props = { patientId: 1, orthoCaseId: 2, readOnly: true };
it.each(zones)("assessment history respects clinic zone %s, preserving legacy callers without a zone", (clinicTimeZone, label) => {
  const revision = { id: 3, version: 1, schemaVersion: 2, createdAt, createdBy: "SYN", reason: "SYN", contentHash: "a".repeat(64), content: {} };
  const data = { state: "ready", clinicalCaseId: 4, clinicalWritable: false, revision, history: [revision], sourceStates: [], sources: { items: [], imaging: "restricted", truncated: false } };
  hooks.cursor = 0; hooks.values = [undefined, 0, null, () => ({ generation: hooks.generation, data, error: null })];
  expect(renderToStaticMarkup(<OrthoCaseAssessmentV2 {...props} clinicTimeZone={clinicTimeZone} />)).toContain(`نسخة 1 · ${label} · SYN`);
});
it.each(zones)("strategy history and selected revision respect clinic zone %s", (clinicTimeZone, label) => {
  const revision = { revisionId: 3, version: 1, createdAt, createdBy: "SYN", reason: "SYN", recordingContext: "current", recordedPatientId: 1, patientId: 1, rows: [] };
  const data = { state: "ready", clinicalCaseId: 4, clinicalWritable: false, canRevise: false, revision, history: [revision], choices: { problems: [], planItems: [] } };
  hooks.cursor = 0; hooks.values = [undefined, 0, () => ({ owner: hooks.owner, data, error: null, loading: false }), null, "", ""];
  const html = renderToStaticMarkup(<OrthoTreatmentStrategy {...props} clinicTimeZone={clinicTimeZone} />);
  expect(html).toContain(`نسخة 1 · ${label} · SYN`);
  expect(html).toContain(`<time dateTime="${createdAt}">${label}</time>`);
});
