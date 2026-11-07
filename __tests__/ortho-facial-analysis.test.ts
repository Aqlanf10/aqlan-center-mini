import { syntheticFace } from "./fixtures/ortho-facial-analysis";
import { describe, expect, it } from "vitest";
import { computeFacialResults, readFacialCommand, type FacialCommand } from "../lib/ortho-facial-analysis";
const command = (): FacialCommand => ({ schemaVersion: 1, clientRequestId: "synthetic_facial_command_1", documentId: 1, expectedHeadId: null, reason: "Synthetic measurement", content: syntheticFace() });
describe("versioned manual frontal proportions", () => {
  it("computes exact thirds and fifths, with no physical units or diagnostic verdict", () => {
    const r = computeFacialResults(syntheticFace()); expect(r.units).toBe("image_pixels_and_percent"); expect(r.clinicalInterpretation).toBe("clinician_only");
    expect(r.measures.every(m => m.state === "ready")).toBe(true);
    expect(r.measures[0].segments.map(s => s.pixels)).toEqual([300,300,300]);
    for (const segment of r.measures[0].segments) expect(segment.percent).toBeCloseTo(100/3,10);
    expect(r.measures[1].segments.map(s => s.percent)).toEqual([20,20,20,20,20]);
    expect(r.measures[2].segments.map(s => s.pixels)).toEqual([100,200]);
    expect(JSON.stringify(r)).not.toContain('"mm"'); expect(JSON.stringify(r)).not.toContain('"normal"');
  });
  it("preserves ratios under translation, proportional scaling and in-plane rotation on a rectangular image", () => {
    const original = syntheticFace(), moved = structuredClone(original), angle = 0.17;
    moved.image = { ...moved.image, width: 2400, height: 3000 };
    for (const value of Object.values(moved.landmarks)) if (value.state === "located") {
      const x=value.x*original.image.width-500,y=value.y*original.image.height-600;
      value.x=(1200+1.5*(x*Math.cos(angle)-y*Math.sin(angle)))/moved.image.width;
      value.y=(1500+1.5*(x*Math.sin(angle)+y*Math.cos(angle)))/moved.image.height;
    }
    const baseline = computeFacialResults(original), result = computeFacialResults(moved);
    expect(result.measures.map(m => [m.state,m.segments.length])).toEqual(baseline.measures.map(m => [m.state,m.segments.length]));
    expect(result.measures.every(m => m.state === "ready")).toBe(true);
    result.measures.forEach((measure,i) => measure.segments.forEach((segment,j) => {
      expect(segment.percent).toBeCloseTo(baseline.measures[i].segments[j].percent,10);
      expect(segment.pixels).toBeCloseTo(1.5*baseline.measures[i].segments[j].pixels,10);
    }));
  });
  it("does not turn an invisible landmark into zero or disable unrelated valid measurements", () => {
    const input=syntheticFace();input.landmarks.tr={state:"unavailable",reason:"Hairline is not visible"};
    const r=computeFacialResults(input); expect(r.measures[0]).toMatchObject({state:"incomplete",segments:[]});
    expect(r.measures.slice(1).every(m=>m.state==="ready")).toBe(true);
  });
  it.each(["zero_axis","reversed_axis","swapped_eye","coincident_levels"])("refuses invalid geometry: %s", kind => {
    const c=syntheticFace();
    if(kind==="zero_axis")c.landmarks.axisBottom=c.landmarks.axisTop;
    if(kind==="reversed_axis")[c.landmarks.axisTop,c.landmarks.axisBottom]=[c.landmarks.axisBottom,c.landmarks.axisTop];
    if(kind==="swapped_eye")[c.landmarks.exImageLeft,c.landmarks.enImageLeft]=[c.landmarks.enImageLeft,c.landmarks.exImageLeft];
    if(kind==="coincident_levels")c.landmarks.gl=c.landmarks.tr;
    expect(computeFacialResults(c).measures.some(m=>m.state==="invalid_geometry")).toBe(true);
  });
  it("permits a documentary draft without pretending the clinician reviewed it", () => {
    const c=command();expect(readFacialCommand(c)).toEqual(c);
    c.content.review={state:"reviewed",note:"Explicit synthetic physician review"};expect(()=>readFacialCommand(c)).toThrow();
    c.content.quality={frontalRest:true,headPosition:true,visibleLandmarks:true,perspectiveReviewed:true,note:""};expect(readFacialCommand(c)).toEqual(c);
    c.content.review.note="";expect(()=>readFacialCommand(c)).toThrow();
  });
  it.each([NaN,Infinity,-0.01,1.01,"0.5"])("refuses non-finite or out-of-image coordinates %s", value=>{
    const c=command();c.content.landmarks.tr={state:"located",x:value as number,y:0.2};expect(()=>readFacialCommand(c)).toThrow();
  });
  it("rejects unknown landmarks, physical-scale claims and an unversioned method",()=>{
    const c=command();expect(()=>readFacialCommand({...c,content:{...c.content,calibrationMm:50}})).toThrow();
    expect(()=>readFacialCommand({...c,content:{...c.content,protocol:"unreviewed"}})).toThrow();
    expect(()=>readFacialCommand({...c,content:{...c.content,landmarks:{nose:{state:"located",x:0.5,y:0.5}}}})).toThrow();
  });
});
it('checks independent unequal projections rather than only symmetric fractions',()=>{
 const c=syntheticFace();
 c.landmarks.tr={state:'located',x:0.5,y:100/1200};c.landmarks.gl={state:'located',x:0.5,y:300/1200};
 c.landmarks.sn={state:'located',x:0.5,y:600/1200};c.landmarks.me={state:'located',x:0.5,y:1000/1200};c.landmarks.sto={state:'located',x:0.5,y:750/1200};
 const r=computeFacialResults(c);expect(r.measures[0].state).toBe('ready');
 expect(r.measures[0].segments.map(s=>s.pixels)).toEqual([200,300,400]);
 expect(r.measures[0].segments.map(s=>s.percent)).toEqual([200/900*100,300/900*100,400/900*100]);
 expect(r.measures[2].segments.map(s=>s.pixels)).toEqual([150,250]);
});
it.each(['axisTop','axisBottom','paImageLeft','exImageLeft','enImageLeft','enImageRight','exImageRight','paImageRight','sto'] as const)('keeps missing %s dependencies explicit',key=>{
 const c=syntheticFace();c.landmarks[key]={state:'unavailable',reason:'Synthetic hidden landmark'};
 const results=computeFacialResults(c);
 for(const measure of results.measures){
  const needed=key==='axisTop'||key==='axisBottom'||measure.landmarks.includes(key);
  expect(measure.state).toBe(needed?'incomplete':'ready');
  expect(measure.segments.length).toBe(needed?0:({thirds:3,fifths_postaurale:5,lower_third:2,eye_widths:3}[measure.id]));
 }
});
