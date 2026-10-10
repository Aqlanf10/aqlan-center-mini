import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const visit = readFileSync("components/ClinicalVisit.tsx", "utf8");
const ortho = readFileSync("components/PatientOrtho.tsx", "utf8");
const boundaries = [
  ["visit load", visit, "  const load = useCallback(", "  useEffect(() => { void load(); }", "4e6e0ebbf2630871c822df5a72ef321dde0ee540bdb55bff87098cddc96ff982"],
  ["visit send", visit, "  const send = useCallback(", "  /** التوقيع", "a6afc51765da78bf0631a43360ffed82c272328606f6202ef35d287b5ed0b22d"],
  ["visit sign", visit, "  const sign = useCallback(", "  /** (VISIT-2) فتح ملف", "ef28cfac2060d5b9e80e2e17a947a49287c3daf8c0c6efe5a6798504c45a698e"],
  ["visit payload", visit, "  const payload = () => (", "  /*\n   * «مخطَّط لليوم»", "e311cf68c9ceb5fb0305c20c5c07bc401ce06505dbb4515c5e84d3fa3e98afda"],
  ["visit planned callback", visit, "  const addPlannedItem = (", "  /* ملاحظة جلسةٍ", "28ab4c344ef3a0bdb893778e4b0fe50405235e514251c0e8440d014a19905156"],
  ["Ortho owner", ortho, "function makeOwner(", "function sameDraftValue", "b8ae3da315cde570ccc2a3b4c463dfb644692725f781501bcecdd922664c157e"],
  ["Ortho retirement", ortho, "function retireOwner(", "function sessionScope", "256983951910e914e0084b53d4b1fd25a9b9efd006d5d0c8d209e97a4f3f12d1"],
  ["Ortho mutation admission", ortho, "function beginMutation(", "function endMutation", "15c0f2e29b6a017dc3f0b40c03398011f7ddad2f28fbbbf763f3758720d5b056"],
  ["Ortho tab navigation", ortho, "export function PatientOrtho(", "function PatientOrthoWorkspace(", "f1440e87bd7b03908ce5d7718517c54682281e9b2d142b2d46768af4d37103c4"],
] as const;
describe("strategy integration preserves released5ae authority boundaries", () => {
  it.each(boundaries)("keeps %s byte-identical", (_label, source, start, end, hash) => {
    expect(source.split(start)).toHaveLength(2);
    const from = source.indexOf(start), to = source.indexOf(end, from);
    expect(to).toBeGreaterThan(from);
    expect(createHash("sha256").update(source.slice(from, to)).digest("hex")).toBe(hash);
  });
  it("uses the current prescription pillar and Ortho lifetime without a new top-level tab", () => {
    expect(ortho.match(/<OrthoStrategyPanel /g)).toHaveLength(1);
    expect(ortho.indexOf("<OrthoStrategyPanel")).toBeGreaterThan(ortho.indexOf('currentPillar === "prescription"'));
    expect(ortho.indexOf("<OrthoStrategyPanel")).toBeLessThan(ortho.indexOf('currentPillar === "retention"'));
    expect(ortho).toContain('useOrthoDraft(`strategy:${caseRow.id}`, patientId, caseRow.id)');
    expect(ortho).toContain("const operation = life.begin(");
    expect(ortho).toContain("markUncertain: () => { life.uncertain(); notifyStrategy(); }");
    expect(ortho).toContain("finish: () => { life.finish(operation); notifyStrategy(); }");
    expect(ortho).toContain("return life.draft.strategyView.subscribe(notify)");
    expect(ortho).toContain("life.draft.strategyView.notify(refresh)");
    expect(ortho).toContain("draft.edits.delete(name); draft.dirty = draft.edits.size > 0");
  });
  it("keeps mutable strategy transitions inside the draft owner rather than hook-exposed values", () => {
    const factory = ortho.slice(ortho.indexOf("function makeDraft("), ortho.indexOf("function makeViewLease("));
    const hook = ortho.slice(ortho.indexOf("function useOrthoDraft("), ortho.indexOf("function UncertainWrite("));
    const panel = ortho.slice(ortho.indexOf("function OrthoStrategyPanel("));
    expect(factory).toContain("const strategyListeners = new Set<() => void>()");
    expect(factory).toContain("get readVersion() { return strategyReadVersion; }");
    expect(factory).toContain("strategyListeners.add(listener); return () => { strategyListeners.delete(listener); }");
    expect(factory).toContain("if (refresh) strategyReadVersion++;");
    expect(factory.indexOf("if (refresh) strategyReadVersion++;")).toBeLessThan(factory.indexOf("for (const listener of [...strategyListeners]) listener();"));
    expect(factory).toContain("draft.values.set(name, value); draft.edits.delete(name); draft.dirty = draft.edits.size > 0;");
    expect(ortho).toContain("draft.strategyView.clear()");
    expect(factory).toContain("clear: () => { strategyListeners.clear(); }");
    expect(hook).toContain("if (!caseGranted() || !draft.active || draft.busy || draft.uncertain) return;\n      draft.settleField(name, value); redraw();");
    expect(hook).not.toMatch(/draft\.dirty\s*=/);
    expect(panel).toContain("if (!life.caseGranted() || !life.draft.active) return;\n    life.draft.strategyView.notify(refresh);");
    expect(panel).not.toMatch(/life\.draft\.strategyView\.readVersion\s*(?:\+\+|=)/);
    expect(ortho).not.toContain("strategyView.listeners");
  });
  it("mounts the exact-case Visit reference without any editable lifetime", () => {
    const start = visit.indexOf("<OrthoTreatmentStrategy");
    expect(start).toBeGreaterThan(-1); expect(visit.match(/<OrthoTreatmentStrategy/g)).toHaveLength(1);
    const instance = visit.slice(start, visit.indexOf("/>", start) + 2);
    expect(instance).toContain("referenceOwner.key}:${referenceOwner.generation}");
    expect(instance).toContain("patientId={visit.patientId} orthoCaseId={visit.ortho.caseId} referenceVisitId={visitId}");
    expect(instance).not.toContain("lifetime");
  });
  it("adds only a read capability while retaining the reviewed append writer", () => {
    const store = readFileSync("lib/ortho-treatment-strategy-store.ts", "utf8");
    const marker = "export async function appendOrthoTreatmentStrategy(";
    expect(store.split(marker)).toHaveLength(2);
    expect(createHash("sha256").update(store.slice(store.indexOf(marker))).digest("hex"))
      .toBe("95ae24d781ce88f5f22cd55812837229df13c51f2f2930056fb1e9034b608327");
  });
});
