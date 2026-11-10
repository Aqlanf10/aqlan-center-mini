import { CEPH_ENGINE_VERSION } from "../lib/ceph-engine-identity";
import { cephComparisonProjectionSha256 } from "../lib/ceph-comparison-projection";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { computeAll, enrichWithRefs, isCephLandmarkCode, isDescriptiveCephMeasurement, EI_KIM_1996_CODE, MEASUREMENTS } from "../lib/ceph";
import { parseCephCompletionSnapshot } from "../lib/ceph-completion-snapshot";
import { buildCephCompletionWitness, cephProvenanceHash, type CephProvenanceRead } from "../lib/ceph-completion-provenance";
import { CEPH_LEGACY_NOTICE, CEPH_INTEGRITY_NOTICE, enrichPresentedCephMeasurements, CEPH_UNAVAILABLE_NOTICE, displayableCephSnapshot, isQuarantinedCephMeasurement, presentCephMeasurements } from "../lib/cephPresentation";

const { study } = vi.hoisted(() => ({ study: {
  analysis: { id: 909, patientId: 1, documentId: 2, status: "completed" as const, orthoCaseId: null,
    phase: "pretreatment" as const, xrayDate: null, device: null, refSet: "", calibration: null,
    mmPerPixel: 0.1, note: null, createdBy: "Synthetic", createdAt: "2026-11-05", completedBy: "Synthetic", completedAt: "2026-11-05", findings: null },
  landmarks: ["A", "B", "OcclA", "OcclP"].map(code => ({ code, x: 30, y: 40, source: "manual" as const })),
  provenance: undefined as CephProvenanceRead | undefined,
  measurements: [{ code: "EXT_INDEX", value: 9999 }, { code: "SNA", value: 77.7 }], diagnosis: null,
} }));
vi.mock("../lib/db", () => ({ getCephStudy: async () => study, getSettingsSafe: async () => ({}), getPatient: async () => ({ fullName: "Synthetic only" }), getCephReferenceSet: async () => null }));
vi.mock("../lib/session", () => ({ requireSession: async () => ({ username: "synthetic" }) }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children) }));
vi.mock("../components/PrintDocument", () => ({ PrintMetadata: ({ children }: { children: ReactNode }) => children, PrintTableFrame: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("../components/PrintButton", () => ({ PrintButton: () => null }));
import { CephTracer } from "../components/CephTracer";
import PrintPage from "../app/print/ceph/[id]/page";

function versioned(measurements: {code:string;value:number}[]): CephProvenanceRead {
  const witness = buildCephCompletionWitness({ analysisId:909, actor:{userId:1,username:"saved-actor"}, sealedAt:"2026-11-05T00:00:00.000Z",
    snapshot:{patientId:1,documentId:2,refSet:"saved-reference", calibration:{x1:0,y1:0,x2:100,y2:0,mm:10},mmPerPixel:0.1,
      landmarks:[],diagnosis:{skeletal:null,dental:null,softTissue:null,note:null,finalDx:"Saved clinician diagnosis"}},
    image:{documentId:2,sha256:"a".repeat(64),width:null,height:null},landmarkReviews:[],
    referenceSet:{key:"saved-reference",name:"Saved reference name",population:"Synthetic",ageMin:null,ageMax:null,sex:null,version:"saved-v1",active:true,
      values:[{code:"SNA",mean:91,sd:7}]},measurements });
  return {state:"versioned",witness,witnessSha256:cephProvenanceHash(witness)};
}

function extractionRow(html: string) {
  return html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?<b>EI_KIM_1996<\/b>(?:(?!<\/tr>)[\s\S])*?<\/tr>/)?.[0]
    ?? html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?<span[^>]*>EI_KIM_1996<\/span>(?:(?!<\/tr>)[\s\S])*?<\/tr>/)?.[0];
}
describe("quarantined historical cephalometric output", () => {
  it.each(["FMA", "YAXIS_FH"])("keeps frozen %s growth notes out of live and historical presentation", (code) => {
    const raw = computeAll({}, NaN).filter(row => row.code === code).map(row => ({ ...row, value: 35 }));
    const original = JSON.stringify(raw);
    const legacyNote = raw[0].note;
    expect(legacyNote).toBeTruthy();
    const live = presentCephMeasurements(raw, null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ code, value: 35, note: undefined });
    const enriched = enrichPresentedCephMeasurements(live, { [code]: { mean: 25, sd: 3 } }, false);
    expect(enriched[0].note).toBeUndefined();
    const saved = [{ code, value: 27 }];
    for (const provenance of [undefined, versioned(saved)]) {
      const before = JSON.stringify(provenance);
      const historical = presentCephMeasurements(raw, saved, provenance);
      expect(historical).toHaveLength(1);
      expect(historical[0]).toMatchObject({ code, value: 27, interpretationAr: "", status: null });
      expect(historical[0].note).not.toContain(legacyNote!);
      expect(historical[0].note).toContain(provenance ? "إصدار الحساب" : CEPH_LEGACY_NOTICE);
      expect(JSON.stringify(provenance)).toBe(before);
    }
    expect(JSON.stringify(raw)).toBe(original);
    expect(saved).toEqual([{ code, value: 27 }]);
  });
  it("never restores or grades a saved extraction number and preserves other sealed values", () => {
    const archive = Object.freeze(study.measurements.map(row => Object.freeze({ ...row })));
    const display = presentCephMeasurements(computeAll({}, 0.1), archive);
    expect(display.find(row => row.code === "SNA")?.value).toBe(77.7);
    expect(display.find(row => row.code === "EXT_INDEX")).toBeUndefined();
    expect(display.find(row => row.code === EI_KIM_1996_CODE)).toBeUndefined();
    expect(display.find(row => row.code === "SNA")).toMatchObject({ unit: " (الوحدة غير موثقة)", mean:null, tol:null, status:null, interpretationAr:"" });
    expect(enrichPresentedCephMeasurements(display, { SNA: {mean:82,sd:2} }, true)[0]).toMatchObject({ refMean: null, refSd: null, z: null, refSeverity: null, refLabel: null });
    expect(archive[0].value).toBe(9999);
    expect(displayableCephSnapshot(archive)).toEqual([{ code: "SNA", value: 77.7 }]);
  });
  it("does not recompute a completed study with an empty snapshot", () => {
    const live = computeAll({ S: { x: 0, y: 0 }, N: { x: 10, y: 0 }, A: { x: 10, y: 10 } }, 0.1);
    expect(live.find(row => row.code === "SNA")?.value).not.toBeNull();
    expect(presentCephMeasurements(live, []).every(row => row.value === null)).toBe(true);
  });
  it("renders the actual completed tracer with an unavailable extraction row", () => {
    const html = renderToStaticMarkup(createElement(CephTracer, {
      patientName: "Synthetic only", patientBirthYear: null, analysis: study.analysis,
      initialLandmarks: study.landmarks as Parameters<typeof CephTracer>[0]["initialLandmarks"],
      stamped: study.measurements, refValues: null, refSetName: null, diagnosis: null,
    }));
    expect(html).not.toContain("9999"); expect(html).toContain("77.7");
    expect(html).toContain(CEPH_UNAVAILABLE_NOTICE);
    expect(extractionRow(html)).toBeUndefined();
    expect(html).toContain(CEPH_LEGACY_NOTICE);
    expect(html).toContain("الوحدة غير موثقة");
    expect(html).not.toContain("px/mm"); expect(html).not.toContain("بكسل/مم");
  });
  it("renders the actual report without a historical extraction value or invalid Wits SVG", async () => {
    const html = renderToStaticMarkup(await PrintPage({ params: Promise.resolve({ id: "909" }) }));
    expect(html).not.toContain("9999"); expect(html).toContain("77.7");
    expect(html).not.toContain('="NaN"'); expect(html).not.toContain('="Infinity"');
    expect(html).toContain(CEPH_UNAVAILABLE_NOTICE);
    expect(extractionRow(html)).toBeUndefined();
    expect(html).toContain(CEPH_LEGACY_NOTICE);
    expect(html).toContain("الوحدة غير موثقة");
    expect(html).not.toContain("px/mm"); expect(html).not.toContain("بكسل/مم");
  });
});

const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
function reader(name: string, endMarker: string, query: (...args: unknown[]) => unknown) {
  const start = source.indexOf(`export async function ${name}(`), end = source.indexOf(endMarker, start);
  if (start < 0 || end < start) throw new Error("Missing production reader");
  const compiled = transformSync(source.slice(start, end).replace(/^export /gm, ""), { loader: "ts", target: "node22" }).code;
  const dependencies = { cephComparisonProjectionSha256, parseCephCompletionSnapshot,
    readCephCompletionProvenance: async () => ({state:"unversioned",reason:"historical_completion_without_witness"}),
    getCephStudy: async () => ({...study,provenance:{state:"unversioned",reason:"historical_completion_without_witness"}}),
    readCephCorrectionSource:async()=>({state:'unavailable',reason:'synthetic'}), requireCephCorrectionAncestry:async()=>{},
    ensureSchema: async () => {}, getPool: () => ({ query,connect:async()=>({query:async(sql:string,...args:unknown[])=>/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)?{rows:[]}:query(sql,...args),release:()=>{}}) }), computeAll, isCephLandmarkCode,
    displayableCephSnapshot, isQuarantinedCephMeasurement, isDescriptiveCephMeasurement, mapCephAnalysis: (row: unknown) => row };
  return new Function(...Object.keys(dependencies), compiled + `\nreturn ${name};`)(...Object.values(dependencies));
}
describe("read boundaries preserve archives while withholding quarantined values", () => {
  it("filters comparison snapshots without executing any mutation", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 909, patient_id: 1, document_id: 2, status: "completed", mm_per_pixel: 0.1, created_at: new Date(), phase: "pretreatment" }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: study.measurements });
    const result = await reader("getCephAnalysisForCompare", "// ─── الوصفات", query)(909);
    expect(result.measurements).toEqual([]);
    expect(result.points).toEqual({});
    expect(result.comparisonUnavailableReason).toBeTruthy();
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT/.test(sql))).toBe(true);
    expect(study.measurements[0].value).toBe(9999);
  });
  it("filters study GET snapshots without rewriting archival records", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ status: "completed" }] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: study.measurements }).mockResolvedValueOnce({ rows: [] });
    const result = await reader("getCephStudy", "export interface CephCalibrationInput", query)(909);
    expect(result.measurements).toEqual([{ code: "SNA", value: 77.7 }]);
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT/.test(sql))).toBe(true);
  });
  it("filters the stamped-value reader without rewriting archival records", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ status: "completed" }] }).mockResolvedValueOnce({ rows: study.measurements });
    expect(await reader("getCephStampedValues", "// ─── المخزون", query)(909)).toEqual([{ code: "SNA", value: 77.7 }]);
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT/.test(sql))).toBe(true);
  });
});


describe("versioned descriptive EI presentation and references", () => {
  it("renders a new sealed EI without grading and shows the bounded scientific source", async () => {
    const measurements = [{ code: EI_KIM_1996_CODE, value: 150.4 }, { code: "SNA", value: 77.7 }];
    const provenance = versioned(measurements);
    const html = renderToStaticMarkup(createElement(CephTracer, {
      patientName: "Synthetic only", patientBirthYear: null, analysis: study.analysis,
      initialLandmarks: study.landmarks as Parameters<typeof CephTracer>[0]["initialLandmarks"],
      stamped: measurements, provenance, refValues: { [EI_KIM_1996_CODE]: { mean: 0, sd: 1 } }, refSetName: "Synthetic", diagnosis: null,
    }));
    const row = extractionRow(html); expect(row).toContain("150.4");
    expect(row).toContain("وصفي"); expect(row).not.toContain("***");
    expect(row).not.toContain("null±null"); expect(row).not.toContain("NaN");
    expect(html).not.toContain("ceph-scientific-context");
    expect(html).toContain(CEPH_ENGINE_VERSION);
    expect(html).toContain("مصادر الحساب والمراجع المحفوظة");
    const old = study.measurements;
    try {
      study.measurements = measurements; study.provenance = provenance;
      const print = renderToStaticMarkup(await PrintPage({ params: Promise.resolve({ id: "909" }) }));
      expect(extractionRow(print)).toContain("150.4");
      expect(extractionRow(print)).toContain("وصفي");
      expect(extractionRow(print)).not.toContain("***");
      expect(print).not.toContain("ceph-scientific-context");
      expect(print).not.toContain("null±null");
    } finally { study.measurements = old; study.provenance = undefined; }
  });
  it("never relabels an old extraction snapshot as the scientific index", () => {
    const live = computeAll({}, 0.1).map(row => row.code === EI_KIM_1996_CODE
      ? { ...row, value: 167.2, display: "167.2" } : row);
    const sealed = presentCephMeasurements(live, [{ code: "EXT_INDEX", value: 9999 }]);
    expect(sealed.find(row => row.code === EI_KIM_1996_CODE)).toBeUndefined();
    expect(sealed.some(row => row.value === 9999)).toBe(false);
    const newSealed = presentCephMeasurements(live, [{ code: EI_KIM_1996_CODE, value: 150.4 }], versioned([{code:EI_KIM_1996_CODE,value:150.4}]));
    const index = newSealed.find(row => row.code === EI_KIM_1996_CODE)!;
    expect(index).toMatchObject({ value: 150.4, display: "150.4", status: null, severityStars: "" });
    expect(enrichWithRefs([index], { [EI_KIM_1996_CODE]: { mean: 0, sd: 1 } })[0])
      .toMatchObject({ refMean: null, refSd: null, diff: null, z: null, refLabel: null, refSeverity: null });
  });
  it("filters stored legacy and descriptive references without deleting records", async () => {
    const vals = [
      { set_id: 1, code: "EXT_INDEX", mean: 153.8, sd: 7.8 },
      { set_id: 1, code: EI_KIM_1996_CODE, mean: 153.8, sd: 7.76 },
      { set_id: 1, code: "SNA", mean: 82, sd: 2 },
      { set_id: 1, code: "L1_APOG", mean: 99, sd: 1 },
    ];
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 1, key: "custom", name: "Synthetic", version: "v1" }] })
      .mockResolvedValueOnce({ rows: vals });
    const sets = await reader("listCephReferenceSets", "/** مجموعة واحدة", query)();
    expect(sets[0].values).toEqual({ SNA: { mean: 82, sd: 2 } });
    expect(vals).toHaveLength(4);
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT/.test(sql))).toBe(true);
  });
  it("seeds only finite non-descriptive norms while preserving old stored rows", () => {
    const start = source.indexOf("const referenceDefinitions = MEASUREMENTS.filter");
    const end = source.indexOf(";", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const definitions = new Function("MEASUREMENTS", "isQuarantinedCephMeasurement", "isDescriptiveCephMeasurement",
      source.slice(start, end + 1) + "return referenceDefinitions;")(MEASUREMENTS, isQuarantinedCephMeasurement, isDescriptiveCephMeasurement);
    expect(definitions.some((row: {code:string}) => ["EXT_INDEX", EI_KIM_1996_CODE, "L1_APOG"].includes(row.code))).toBe(false);
    expect(definitions.every((row: {mean:number;tol:number}) => Number.isFinite(row.mean) && Number.isFinite(row.tol) && row.tol > 0)).toBe(true);
    const seed = source.slice(start, source.indexOf("// بذر حسابات", start));
    expect(seed).toContain("referenceDefinitions.map((d) => d.code)");
    expect(seed).toContain("referenceDefinitions.map((d) => d.mean)");
    expect(seed).toContain("referenceDefinitions.map((d) => d.tol)");
    expect(seed).not.toMatch(/DELETE|TRUNCATE/);
  });
});

describe("completed clinical presentation never borrows today's provenance", () => {
  it("uses saved units and norms despite a changed live registry and catalog", () => {
    const provenance = versioned([{code:"SNA",value:77.7}]);
    const definition = MEASUREMENTS.find(row => row.code === "SNA")!;
    const old = {...definition};
    try {
      Object.assign(definition, {unit:"mm",mean:400,tol:90,source:"Changed today"});
      const live = computeAll({},0.1);
      const rows = enrichPresentedCephMeasurements(presentCephMeasurements(live,[{code:"SNA",value:1}],provenance),{SNA:{mean:900,sd:100}},true);
      expect(rows[0]).toMatchObject({value:77.7,unit:"°",mean:91,tol:7,refMean:91,refSd:7,source:"saved-reference@saved-v1",status:null,interpretationAr:"",severityStars:"",z:null});
    } finally { Object.assign(definition,old); }
  });
  it("keeps unknown legacy codes without inventing units, references, labels or interpretation", () => {
    const rows = presentCephMeasurements(computeAll({},1), [{code:"RETIRED_SYNTHETIC",value:12.3}]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({code:"RETIRED_SYNTHETIC",ar:"RETIRED_SYNTHETIC",en:"RETIRED_SYNTHETIC",value:12.3,unit:" (الوحدة غير موثقة)",mean:null,tol:null,status:null,interpretationAr:""});
  });
  it("uses witness diagnosis and source metadata in tracer and print, without current scientific panels", async () => {
    const provenance = versioned([{code:"SNA",value:77.7}]);
    const tracer = renderToStaticMarkup(createElement(CephTracer,{
      patientName:"Synthetic",patientBirthYear:null,analysis:study.analysis,initialLandmarks:[],
      stamped:[{code:"SNA",value:1}],provenance,refValues:{SNA:{mean:400,sd:90}},refSetName:"Changed today",diagnosis:null,
    }));
    expect(tracer).toContain("Saved clinician diagnosis"); expect(tracer).not.toContain("Changed today");
    expect(tracer).toContain("saved-reference@saved-v1"); expect(tracer).toContain("لا يثبت ذلك أن الطبيب شاهد المصدر");
    expect(tracer).not.toContain("ceph-scientific-context");
    const old = study.provenance;
    try {
      study.provenance=provenance;
      const print = renderToStaticMarkup(await PrintPage({params:Promise.resolve({id:"909"})}));
      expect(print).toContain("Saved clinician diagnosis"); expect(print).toContain("91±7");
      expect(print).toContain("saved-reference@saved-v1"); expect(print).not.toContain("ceph-scientific-context");
    } finally { study.provenance=old; }
  });
  it("withholds clinical rows and diagnosis entirely when integrity is unavailable", async () => {
    const provenance: CephProvenanceRead = {state:"integrity_unavailable",reason:"synthetic mismatch"};
    expect(presentCephMeasurements(computeAll({},1),study.measurements,provenance)).toEqual([]);
    const tracer = renderToStaticMarkup(createElement(CephTracer,{
      patientName:"Synthetic",patientBirthYear:null,analysis:study.analysis,initialLandmarks:[],
      stamped:study.measurements,provenance,refValues:null,refSetName:null,diagnosis:null,
    }));
    expect(tracer).toContain(CEPH_INTEGRITY_NOTICE); expect(tracer).not.toContain("77.7");
    const old = study.provenance;
    try {
      study.provenance=provenance;
      const print = renderToStaticMarkup(await PrintPage({params:Promise.resolve({id:"909"})}));
      expect(print).toContain(CEPH_INTEGRITY_NOTICE); expect(print).not.toContain("77.7");
      expect(print).not.toContain("Confirmed"); expect(print).not.toContain("Recorded Diagnosis");
    } finally { study.provenance=old; }
  });
  it("retains live draft measurement and reference behavior", () => {
    const live=computeAll({S:{x:0,y:0},N:{x:10,y:0},A:{x:10,y:10}},1);
    const rows=enrichPresentedCephMeasurements(presentCephMeasurements(live,null),{SNA:{mean:77,sd:3}},false);
    expect(rows.find(row=>row.code==="SNA")).toMatchObject({value:90,unit:"°",refMean:77,refSd:3});
  });
});


describe('L1_APOG exact signed distance static consumers',()=>{
 const row=(html:string)=>html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?<b>L1_APOG<\/b>(?:(?!<\/tr>)[\s\S])*?<\/tr>/)?.[0]
   ?? html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?<span[^>]*>L1_APOG<\/span>(?:(?!<\/tr>)[\s\S])*?<\/tr>/)?.[0];
 it.each([[-5,-2.5],[0,0],[5,2.5]])('renders real-engine signed x=%s as %s mm in completed tracer and print',async(x,expected)=>{
  const map={S:{x:-10,y:-10},N:{x:0,y:-10},Me:{x:0,y:20},A:{x:0,y:0},Pog:{x:0,y:10},L1:{x,y:5}};
  const value=computeAll(map,.5).find(r=>r.code==='L1_APOG')!.value!;expect(value).toBe(expected);
  const measurements=[{code:'L1_APOG',value}],provenance=versioned(measurements);
  const html=renderToStaticMarkup(createElement(CephTracer,{patientName:'Synthetic only',patientBirthYear:null,analysis:study.analysis,initialLandmarks:study.landmarks as Parameters<typeof CephTracer>[0]['initialLandmarks'],stamped:measurements,provenance,refValues:{L1_APOG:{mean:99,sd:1}},refSetName:'Injected norm',diagnosis:null}));
  expect(row(html)).toContain(String(expected));expect(row(html)).toContain('mm');expect(row(html)).toContain('وصفي');expect(row(html)).not.toContain('99');expect(row(html)).not.toContain('***');expect(html).toContain('قياس وصفي محفوظ');expect(html).not.toContain('عينة وصفية محفوظة');
  const old=study.measurements;try{study.measurements=measurements;study.provenance=provenance;const print=renderToStaticMarkup(await PrintPage({params:Promise.resolve({id:'909'})}));expect(row(print)).toContain(String(expected));expect(row(print)).toContain('mm');expect(row(print)).toContain('وصفي');expect(row(print)).not.toContain('***');}finally{study.measurements=old;study.provenance=undefined;}
 });
});

describe('direct anterior height static consumers',()=>{
 const tableRow=(html:string,code:string)=>html.match(new RegExp(`<tr\\b[^>]*>(?:(?!<\\/tr>)[\\s\\S])*?<b>${code}<\\/b>(?:(?!<\\/tr>)[\\s\\S])*?<\\/tr>`))?.[0]
  ??html.match(new RegExp(`<tr\\b[^>]*>(?:(?!<\\/tr>)[\\s\\S])*?<span[^>]*>${code}<\\/span>(?:(?!<\\/tr>)[\\s\\S])*?<\\/tr>`))?.[0];
 it.each([false,true])('renders saved total/lower mm without ratio relabeling; tiny positive lengths rounded to zero=%s',async zero=>{
  const map={N:{x:0,y:0},Me:{x:6,y:8},ANS:{x:3,y:4}};if(zero){map.N={x:0,y:0};map.Me={x:.0006,y:.0008};map.ANS={x:.0003,y:.0004};}
  const rows=computeAll(map,.5),codes=['AFH_N_ME','LAFH_ANS_ME'];const expected=zero?[0,0]:[5,2.5];
  const measurements=codes.map((code,i)=>{const value=rows.find(r=>r.code===code)!.value!;expect(value).toBe(expected[i]);return {code,value};});const provenance=versioned(measurements);
  const html=renderToStaticMarkup(createElement(CephTracer,{patientName:'Synthetic only',patientBirthYear:null,analysis:study.analysis,initialLandmarks:study.landmarks as Parameters<typeof CephTracer>[0]['initialLandmarks'],stamped:measurements,provenance,refValues:Object.fromEntries(codes.map(code=>[code,{mean:999,sd:1}])),refSetName:'Injected norm',diagnosis:null}));
  const old=study.measurements;try{study.measurements=measurements;study.provenance=provenance;const print=renderToStaticMarkup(await PrintPage({params:Promise.resolve({id:'909'})}));for(const output of [html,print])for(const [i,code]of codes.entries()){const row=tableRow(output,code);expect(row).toContain(String(expected[i]));expect(row).toContain('mm');expect(row).toContain('وصفي');expect(row).not.toContain('999');expect(row).not.toContain('***');expect(row).not.toContain('%');}}finally{study.measurements=old;study.provenance=undefined;}
 });
});

describe('direct palatal length static consumers',()=>{
 const tableRow=(html:string,code:string)=>html.match(new RegExp(`<tr\\b[^>]*>(?:(?!<\\/tr>)[\\s\\S])*?<b>${code}<\\/b>(?:(?!<\\/tr>)[\\s\\S])*?<\\/tr>`))?.[0]
  ??html.match(new RegExp(`<tr\\b[^>]*>(?:(?!<\\/tr>)[\\s\\S])*?<span[^>]*>${code}<\\/span>(?:(?!<\\/tr>)[\\s\\S])*?<\\/tr>`))?.[0];
 it.each([false,true])('renders saved palatal mm without angle or space relabeling; tiny positive lengths rounded to zero=%s',async zero=>{
  const map={ANS:{x:1,y:2},PNS:{x:7,y:10}};if(zero){map.ANS={x:0,y:0};map.PNS={x:.0006,y:.0008};}
  const rows=computeAll(map,.5),codes=['PALATAL_ANS_PNS'];const expected=zero?[0]:[5];
  const measurements=codes.map((code,i)=>{const value=rows.find(r=>r.code===code)!.value!;expect(value).toBe(expected[i]);return {code,value};});const provenance=versioned(measurements);
  const html=renderToStaticMarkup(createElement(CephTracer,{patientName:'Synthetic only',patientBirthYear:null,analysis:study.analysis,initialLandmarks:study.landmarks as Parameters<typeof CephTracer>[0]['initialLandmarks'],stamped:measurements,provenance,refValues:Object.fromEntries(codes.map(code=>[code,{mean:999,sd:1}])),refSetName:'Injected norm',diagnosis:null}));
  const old=study.measurements;try{study.measurements=measurements;study.provenance=provenance;const print=renderToStaticMarkup(await PrintPage({params:Promise.resolve({id:'909'})}));for(const output of [html,print])for(const [i,code]of codes.entries()){const row=tableRow(output,code);expect(row).toContain(String(expected[i]));expect(row).toContain('mm');expect(row).toContain('وصفي');expect(row).not.toContain('999');expect(row).not.toContain('***');expect(row).not.toContain('%');}}finally{study.measurements=old;study.provenance=undefined;}
 });
});

describe('posterior upper incisor palatal angle static consumers',()=>{
 const tableRow=(html:string,code:string)=>html.match(new RegExp(`<tr\\b[^>]*>(?:(?!<\\/tr>)[\\s\\S])*?<b>${code}<\\/b>(?:(?!<\\/tr>)[\\s\\S])*?<\\/tr>`))?.[0]
  ??html.match(new RegExp(`<tr\\b[^>]*>(?:(?!<\\/tr>)[\\s\\S])*?<span[^>]*>${code}<\\/span>(?:(?!<\\/tr>)[\\s\\S])*?<\\/tr>`))?.[0];
 it.each([60,90,120])('renders saved posterior angle %s in degrees without acute folding',async expectedAngle=>{
  const vector=expectedAngle===60?{x:1,y:Math.sqrt(3)}:expectedAngle===90?{x:0,y:2}:{x:-1,y:Math.sqrt(3)};const map={ANS:{x:0,y:0},PNS:{x:2,y:0},U1A:{x:4,y:4},U1:{x:4+vector.x,y:4+vector.y}};
  const rows=computeAll(map,NaN),codes=['U1_PP'],expected=[expectedAngle];
  const measurements=codes.map((code,i)=>{const value=rows.find(r=>r.code===code)!.value!;expect(value).toBe(expected[i]);return {code,value};});const provenance=versioned(measurements);
  const html=renderToStaticMarkup(createElement(CephTracer,{patientName:'Synthetic only',patientBirthYear:null,analysis:study.analysis,initialLandmarks:study.landmarks as Parameters<typeof CephTracer>[0]['initialLandmarks'],stamped:measurements,provenance,refValues:Object.fromEntries(codes.map(code=>[code,{mean:999,sd:1}])),refSetName:'Injected norm',diagnosis:null}));
  const old=study.measurements;try{study.measurements=measurements;study.provenance=provenance;const print=renderToStaticMarkup(await PrintPage({params:Promise.resolve({id:'909'})}));for(const output of [html,print])for(const [i,code]of codes.entries()){const row=tableRow(output,code);expect(row).toContain(String(expected[i]));expect(row).toContain('°');expect(row?.replace(/<[^>]*>/g,'')).not.toContain('mm');expect(row).toContain('وصفي');expect(row).not.toContain('999');expect(row).not.toContain('***');expect(row).not.toContain('%');}}finally{study.measurements=old;study.provenance=undefined;}
 });
});

describe('acute lower incisor A-Pog angle static consumers',()=>{
 const tableRow=(html:string,code:string)=>html.match(new RegExp(`<tr\\b[^>]*>(?:(?!<\\/tr>)[\\s\\S])*?<b>${code}<\\/b>(?:(?!<\\/tr>)[\\s\\S])*?<\\/tr>`))?.[0]
  ??html.match(new RegExp(`<tr\\b[^>]*>(?:(?!<\\/tr>)[\\s\\S])*?<span[^>]*>${code}<\\/span>(?:(?!<\\/tr>)[\\s\\S])*?<\\/tr>`))?.[0];
 it.each([20,60,120])('renders input angle %s as saved acute degrees without linear substitution',async angle=>{
  const vector={x:2*Math.cos(angle*Math.PI/180),y:2*Math.sin(angle*Math.PI/180)};const map={A:{x:0,y:0},Pog:{x:2,y:0},L1A:{x:4,y:4},L1:{x:4+vector.x,y:4+vector.y}};
  const rows=computeAll(map,NaN),codes=['L1_APOG_ANGLE'],expected=[angle===120?60:angle];
  const measurements=codes.map((code,i)=>{const value=rows.find(r=>r.code===code)!.value!;expect(value).toBe(expected[i]);return {code,value};});const provenance=versioned(measurements);
  const html=renderToStaticMarkup(createElement(CephTracer,{patientName:'Synthetic only',patientBirthYear:null,analysis:study.analysis,initialLandmarks:study.landmarks as Parameters<typeof CephTracer>[0]['initialLandmarks'],stamped:measurements,provenance,refValues:Object.fromEntries(codes.map(code=>[code,{mean:999,sd:1}])),refSetName:'Injected norm',diagnosis:null}));
  const old=study.measurements;try{study.measurements=measurements;study.provenance=provenance;const print=renderToStaticMarkup(await PrintPage({params:Promise.resolve({id:'909'})}));for(const output of [html,print])for(const [i,code]of codes.entries()){const row=tableRow(output,code);expect(row).toContain(String(expected[i]));expect(row).toContain('°');expect(row?.replace(/<[^>]*>/g,'')).not.toContain('mm');expect(row).toContain('وصفي');expect(row).not.toContain('999');expect(row).not.toContain('***');expect(row).not.toContain('%');}}finally{study.measurements=old;study.provenance=undefined;}
 });
});
