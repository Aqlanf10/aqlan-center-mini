import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { cephReportLabels, cephReportLayout, cephReportReference, cephReportValue, type CephReportRow } from "../lib/ceph-report-layout";
const row = (overrides: Partial<CephReportRow> = {}): CephReportRow => ({ code: "SYNTHETIC", ar: "قياس اصطناعي", en: "Synthetic", group: "sagittal", unit: "°", value: 0, refMean: 0, refSd: 2, source: "Synthetic reference", ...overrides });
describe("clinical report layout preserves evidence without diagnostic guesses", () => {
  it("orders groups and never drops an unknown historical group", () => {
    const input = [row({group:"dental",code:"D"}),row({group:"retired",code:"X"}),row({group:"sagittal",code:"S"})];
    const result = cephReportLayout(input);
    assert.deepEqual(result.groups.map(group=>group.id),["sagittal","dental","other"]);
    assert.equal(result.groups.flatMap(group=>group.rows).length,3);
    assert.equal(result.groups[2].rows[0],input[1]);
  });
  it("keeps original values, rows and sources untouched", () => {
    const input = Object.freeze([Object.freeze(row()), Object.freeze(row({code:"B",source:"Other source"}))]);
    const before = JSON.stringify(input); const result=cephReportLayout(input);
    assert.equal(JSON.stringify(input),before); assert.equal(result.groups[0].rows[0],input[0]);
    assert.deepEqual(result.sources,["Synthetic reference","Other source"]);
  });
  it("deduplicates source labels without inventing a replacement", () => {
    assert.deepEqual(cephReportLayout([row(),row({code:"B"}),row({code:"C",source:""})]).sources,["Synthetic reference",""]);
  });
  it("counts zero as available and does not count null or nonfinite values", () => {
    const result=cephReportLayout([row(),row({code:"B",value:null}),row({code:"C",value:NaN})]);
    assert.deepEqual([result.available,result.unavailable,result.total],[1,2,3]);
  });
  for(const value of [null,NaN,Infinity,-Infinity]) it(`renders unavailable ${value} without a numeric fiction`,()=>assert.equal(cephReportValue(row({value})),"—"));
  it("preserves negative values and recorded units",()=>assert.equal(cephReportValue(row({value:-2.5,unit:"mm"})),"-2.5mm"));
  it("never converts an undocumented historical unit to degrees",()=>assert.equal(cephReportValue(row({value:12,unit:" (الوحدة غير موثقة)"})),"12 (الوحدة غير موثقة)"));
  it("supports a reference mean of zero",()=>assert.equal(cephReportReference(row()),"0±2"));
  for(const refSd of [null,0,-1,NaN,Infinity]) it(`withholds invalid reference dispersion ${refSd}`,()=>assert.equal(cephReportReference(row({refSd})),"غير متاح"));
  it("does not classify descriptive rows using an injected norm",()=>assert.equal(cephReportReference(row({descriptiveOnly:true,refMean:999})),"وصفي · بلا تصنيف"));
  it("reports an empty snapshot honestly",()=>assert.deepEqual(cephReportLayout([]),{groups:[],sources:[],available:0,unavailable:0,total:0}));
});

describe("label rails do not alter clinical geometry",()=>{
  it("separates clustered labels and retains every source point",()=>{
    const points=Array.from({length:24},(_,i)=>Object.freeze({code:`SYN${i}`,x:i<4?0:100,y:i<4?i*50:75+i/10}));
    const original=JSON.stringify(points),layout=cephReportLabels(points);assert.ok(layout);
    assert.equal(layout.labels.length,points.length);assert.equal(JSON.stringify(points),original);
    for(const label of layout.labels){const source=points.find(p=>p.code===label.code)!;assert.equal(label.pointX,source.x);assert.equal(label.pointY,source.y);}
    for(const anchor of ["start","end"]){const labels=layout.labels.filter(p=>p.anchor===anchor).sort((a,b)=>a.y-b.y);for(let i=1;i<labels.length;i++)assert.ok(labels[i].y-labels[i-1].y>=layout.gap-1e-10);}
  });
  it("returns no invented diagram for an empty or degenerate source",()=>{
    assert.equal(cephReportLabels([]),null);assert.equal(cephReportLabels([{code:"S",x:1,y:1},{code:"N",x:1,y:1}]),null);
  });
  it("rejects nonfinite coordinates",()=>assert.equal(cephReportLabels([{code:"S",x:NaN,y:1}]),null));
  it("keeps negative coordinates valid without taking absolute values",()=>{
    const layout=cephReportLabels([{code:"S",x:-20,y:-30},{code:"N",x:-5,y:-10}]);assert.ok(layout);assert.equal(layout.labels.find(p=>p.code==="S")?.pointX,-20);
  });
});
