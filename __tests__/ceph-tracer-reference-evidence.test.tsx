import { completionProvenance } from "./fixtures/ceph-completion-evidence";
import { createElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CephTracer } from "../components/CephTracer";
import { cephSourceIdentity } from "../lib/ceph-completion-provenance";
import { computeAll } from "../lib/ceph";
import { cephDraftReferenceContext, describeCephMeasurements, enrichPresentedCephMeasurements, presentCephMeasurements } from "../lib/cephPresentation";
import type { CephCompletionSources } from "../lib/ceph-source-review";

// Execute real component handlers; only hook scheduling and transport are
// synthetic. This is not browser acceptance; no browser suite was run for this repair.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return i; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined), before = hooks.memos.get(index); if (before && same(before.deps, deps)) return before.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => { const index = slot({ current: initial }); return hooks.values[index]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    // Layout setup activates the real edit owner before synthetic user actions;
    // preserve dependency cleanup so source changes retire the previous queue.
    useLayoutEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = run(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = run(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
let props: ComponentProps<typeof CephTracer>;
const fetchMock = vi.fn();
function render(): ReactNode {
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false; hooks.pending = [];
    const tree = CephTracer(props); if (hooks.changed) continue;
    hooks.pending.splice(0).forEach((run) => run()); if (!hooks.changed) return tree;
  }
  throw new Error("Ceph render did not settle");
}

vi.mock("next/link", () => ({default: ({children,...rest}: {children:ReactNode}) => createElement("a",rest,children)}));
vi.mock("../components/CephViewport", () => ({CephViewport: () => null}));
const button = (name:string) => { const b=nodes(render()).find(n=>n.type==="button"&&text(n).trim()===name); if(!b) throw new Error("Missing button: "+name); return b; };
const click = (name:string) => (button(name).props.onClick as ()=>void)();
const html = () => renderToStaticMarkup(render());
const row = (output:string,code:string) => output.match(new RegExp(`<tr[^>]*>(?:(?!<\\/tr>)[\\s\\S])*?<span[^>]*>${code}<\\/span>(?:(?!<\\/tr>)[\\s\\S])*?<\\/tr>`))?.[0] ?? "";
const selected = (mean=110, active=true):CephCompletionSources => {
  const referenceSet={key:"synthetic-selected",name:"Viewed selected source",version:"synthetic-v1",population:"Synthetic cohort",ageMin:9,ageMax:12,sex:"female",active,values:[{code:"SNA",mean,sd:3}]};
  return {state:"available",referenceSet,identity:cephSourceIdentity({documentId:51,sha256:"a".repeat(64),width:null,height:null},referenceSet)};
};
beforeEach(()=>{
  hooks.values=[]; hooks.cursor=0; hooks.changed=false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending=[];
  fetchMock.mockReset(); vi.stubGlobal("fetch",fetchMock);
  vi.stubGlobal("window",{location:{href:"/ceph/71"},addEventListener(){},removeEventListener(){}});
  vi.stubGlobal("document",{addEventListener(){},removeEventListener(){}});
  props={patientName:"Synthetic",patientBirthYear:null,analysis:{id:71,patientId:11,documentId:51,status:"draft",orthoCaseId:null,phase:"pretreatment",xrayDate:null,device:null,refSet:"synthetic-selected",calibration:null,mmPerPixel:1,note:null,createdBy:"Synthetic",createdAt:"2026-11-05",completedBy:null,completedAt:null,findings:null},
    initialLandmarks:[{code:"S",x:0,y:0,source:"manual"},{code:"N",x:10,y:0,source:"manual"},{code:"A",x:10,y:10,source:"manual"},{code:"B",x:10,y:20,source:"manual"}],stamped:null,refValues:{SNA:{mean:999,sd:9}},refSetName:"STALE PROP NAME",diagnosis:null,completionSources:selected()};
});
afterEach(()=>{hooks.effects.forEach(e=>e.cleanup?.());vi.unstubAllGlobals();});
const unsupported=/Prognathic maxilla|Maxillary Prognathism|Class II|Class III|Class I|Normodivergent|Hyperdivergent|Hypodivergent|التفسير السريري|المجال الطبيعي ±1 SD|Z-Score|>\*\*\*</;
describe("reachable draft tracer selected-reference evidence",()=>{
  it("exposes the baseline mixed-reference mismatch without clinical claims in the repaired row",()=>{
    const raw=computeAll({S:{x:0,y:0},N:{x:10,y:0},A:{x:10,y:10}},1);
    expect(raw.find(r=>r.code==="SNA")).toMatchObject({value:90,status:"above",severityStars:"***"});
    const presented=enrichPresentedCephMeasurements(presentCephMeasurements(raw,null),{SNA:{mean:110,sd:3}},false);
    expect(presented.find(r=>r.code==="SNA")).toMatchObject({value:90,refMean:110,refSd:3,status:null,severityStars:"",interpretationAr:"",interpretationEn:"",z:null,refSeverity:null,refLabel:null});
    expect(presented.find(r=>r.code==="SNB")).toMatchObject({refMean:null,refSd:null});
  });
  it("uses the viewed source for grouped table and footer, never stale props or built-in grade",()=>{
    const output=html(), sna=row(output,"SNA");
    expect(sna).toContain("110±3"); expect(sna).toContain("synthetic-selected@synthetic-v1");
    expect(sna).not.toMatch(unsupported); expect(output).not.toContain("STALE PROP NAME");
    expect(output).toContain("ملاءمة هذه المراجع لهذا المريض غير متحققة");
    expect(row(output,"SNB")).not.toContain("80±2"); expect(row(output,"SNB")).toContain("غير متاح");
    expect(output).not.toMatch(unsupported);
  });
  it("keeps the same neutral evidence in the school table and chart",()=>{
    const school=nodes(render()).find(n=>n.type==="button"&&text(n).startsWith("شتاينر"))!;
    (school.props.onClick as ()=>void)(); expect(row(html(),"SNA")).toContain("110±3"); expect(html()).not.toMatch(unsupported);
    click("مخطط"); const chart=html(); expect(chart).toContain("110±3"); expect(chart).not.toMatch(unsupported);
    expect(chart).toContain("synthetic-selected@synthetic-v1");
  });
  it.each([undefined,{state:"unavailable",reason:"missing"} as const,selected(110,false)])("does not restore defaults with unavailable/inactive sources (%j)",(sources)=>{
    props.completionSources=sources; const output=html();
    expect(row(output,"SNA")).not.toContain("82±2"); expect(row(output,"SNA")).not.toContain("110±3");
    expect(row(output,"SNA")).toContain("غير متاح"); expect(output).not.toContain("STALE PROP NAME");
  });
  it("retains a mounted source through same-key content refresh and requires reopening",()=>{
    const original=html(); expect(row(original,"SNA")).toContain("110±3");
    props.completionSources=selected(70); props.refSetName="REFRESHED PROP NAME"; const refreshed=html();
    expect(row(refreshed,"SNA")).toContain("110±3"); expect(row(refreshed,"SNA")).not.toContain("70±3");
    expect(refreshed).not.toContain("REFRESHED PROP NAME"); expect(refreshed).toContain("أعد فتح الدراسة");
    expect(button("اعتماد التحليل").props.disabled).toBe(true);
  });
  it("detects incoming content mutation even when its key/version/hash fields do not change",()=>{
    render(); const mutated=selected(); if(mutated.state!=="available") throw new Error("fixture");
    mutated.referenceSet.values[0].mean=70; mutated.referenceSet.name="MUTATED SAME IDENTITY";
    props.completionSources=mutated; const output=html();
    expect(row(output,"SNA")).toContain("110±3"); expect(row(output,"SNA")).not.toContain("70±3");
    expect(output).not.toContain("MUTATED SAME IDENTITY"); expect(output).toContain("وليست تحديثًا للمصدر الحالي");
    expect(button("اعتماد التحليل").props.disabled).toBe(true);
  });
  it("keeps report cards raw and does not insert auto classifications into physician diagnosis",()=>{
    const report=nodes(render()).find(n=>n.type==="button"&&text(n).includes("المتابعة للمطابقة والتقرير"))!;
    (report.props.onClick as ()=>void)(); const output=html();
    expect(output).not.toMatch(unsupported); expect(output).toContain("Viewed selected source");
    expect(output).not.toContain("STALE PROP NAME"); expect(output).toContain("مسودة التشخيص وملاحظات الطبيب");
  });
  it("keeps finite extreme reference numbers finite in both table and chart",()=>{
    const source=selected(1e308); if(source.state!=="available") throw new Error("fixture"); source.referenceSet.values[0].sd=1e308;
    props.completionSources=source; expect(row(html(),"SNA")).toContain("1e+308±1e+308");
    expect(html()).not.toContain("Infinity"); click("مخطط"); expect(html()).not.toContain("Infinity");
  });
  it.each(["تعبئة قراءة وصفية", "تعبئة أساسية"])("only fills raw descriptive numbers via %s, preserving text and separate save",(label)=>{
    props.diagnosis={skeletal:"Clinician exact text",dental:null,softTissue:null,note:"Clinician plan",finalDx:"",createdBy:"Synthetic",updatedAt:"2026-11-05"};
    const tree=render(); const fill=nodes(tree).find(n=>n.type==="button"&&text(n).includes(label))!;
    (fill.props.onClick as ()=>void)(); const fields=nodes(render()).filter(n=>n.type==="textarea").map(n=>n.props.value);
    expect(fields).toContain("Clinician exact text"); expect(fields).toContain("Clinician plan");
    expect(fields.join(" ")).not.toMatch(unsupported); expect(fields.join(" ")).not.toContain("المرجع المدمج"); expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("source-bound presentation helper boundaries",()=>{
  it.each(["document","key","engine","engineHash","malformedHash","inactive","missingValues","duplicateCode","invalidSd"])("fails closed on %s",kind=>{
    const source=selected(); if(source.state!=="available") throw new Error("fixture");
    if(kind==="document")source.identity.documentId=99;
    if(kind==="key")source.referenceSet.key="other";
    if(kind==="engine")source.identity.engineVersion="other";
    if(kind==="engineHash")source.identity.engineSourceSha256="f".repeat(64);
    if(kind==="malformedHash")source.identity.referenceSetSha256="bad";
    if(kind==="inactive")source.referenceSet.active=false;
    if(kind==="missingValues")delete (source.referenceSet as Partial<typeof source.referenceSet>).values;
    if(kind==="duplicateCode")source.referenceSet.values.push({...source.referenceSet.values[0]});
    if(kind==="invalidSd")source.referenceSet.values[0].sd=0;
    expect(cephDraftReferenceContext(source,props.analysis)).toMatchObject({refs:null,referenceSet:null,identity:null,patientSpecificSuitability:"not_validated"});
    props.completionSources=source; expect(row(html(),"SNA")).toContain("غير متاح");
  });
  it("never mutates input or manufactures norms for partial or empty catalogs, EI, or quarantined legacy rows",()=>{
    const raw=computeAll({S:{x:0,y:0},N:{x:10,y:0},A:{x:10,y:10}},1);
    const before=JSON.stringify(raw); const source=selected(); const sourceBefore=JSON.stringify(source);
    const context=cephDraftReferenceContext(source,props.analysis);
    const rows=enrichPresentedCephMeasurements(presentCephMeasurements(raw,null),context.refs,false,context.source);
    expect(rows.find(r=>r.code==="SNB")?.refMean).toBeNull();
    expect(rows.find(r=>r.code==="EI_KIM_1996")).toMatchObject({refMean:null,z:null});
    expect(JSON.stringify(raw)).toBe(before); expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(JSON.stringify(describeCephMeasurements(rows))).not.toMatch(unsupported);
    const empty=selected(); if(empty.state!=="available")throw new Error("fixture"); empty.referenceSet.values=[];
    expect(cephDraftReferenceContext(empty,props.analysis).refs).toEqual({});
  });
});


describe("saved completion evidence in tracer", () => {
  it.each([1, 2] as const)("shows the saved ruler and seal rather than current draft values (v%s)", version => {
    props.analysis = { ...props.analysis, status: "completed", completedAt: "2026-11-05T12:34:56.000Z", completedBy: "SAVED_SEAL_ACTOR", calibration: { x1: 999, y1: 999, x2: 999, y2: 999, mm: 999 }, mmPerPixel: 999 };
    props.provenance = completionProvenance(version);
    const output = html();
    expect(output.includes('data-testid="ceph-saved-completion-evidence"')).toBe(true);
    expect(output).toContain("0.125 mm/px"); expect(output).toContain("SAVED_SEAL_ACTOR");
  });
  it.each([undefined, { state: "not_completed" as const }, { state: "unversioned" as const, reason: "historical_completion_without_witness" as const }, { state: "integrity_unavailable" as const, reason: "invalid_completion_witness" }])("does not fabricate evidence for unavailable historical state %j", provenance => {
    props.analysis = { ...props.analysis, status: "completed", completedAt: "2026-11-05T12:34:56.000Z" };
    props.provenance = provenance;
    expect(html()).not.toContain('data-testid="ceph-saved-completion-evidence"'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("never mounts saved evidence on a draft even if a witness prop is supplied", () => {
    props.provenance = completionProvenance();
    expect(html()).not.toContain('data-testid="ceph-saved-completion-evidence"');
  });

});
