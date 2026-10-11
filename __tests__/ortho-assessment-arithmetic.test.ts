import { describe,it,expect } from "vitest";
import { boltonArithmetic,permanentArchSpaceArithmetic } from "../lib/ortho-assessment-arithmetic";
const widths=(v:Record<string,number>)=>Object.entries(v).map(([tooth,value])=>({tooth:Number(tooth),value}));
describe("unrounded descriptive model arithmetic with literal independent fixtures",()=>{
  it("keeps explicit reference-arch residuals distinct and signed",()=>{
    const r=boltonArithmetic("anterior",widths({13:8,12:7,11:10,21:10,22:7,23:8}),widths({43:7,42:6,41:7,31:7,32:6,33:7}),77.2);
    if(!r.ok)throw Error(r.code);
    expect(r.value.upperSumMm).toBe(50);expect(r.value.lowerSumMm).toBe(40);expect(r.value.ratioPercent).toBe(80);
    expect(r.value.upperReferenceLowerResidualMm).toBeCloseTo(1.4,12);
    expect(r.value.lowerReferenceUpperResidualMm).toBeCloseTo(-1.8134715025906736,12);
  });
  it("uses available minus required separately for each arch",()=>{
    const upper=permanentArchSpaceArithmetic("upper",widths({15:7,14:7,13:8,12:7,11:8,21:8,22:7,23:8,24:7,25:7}),72.5);
    const lower=permanentArchSpaceArithmetic("lower",widths({45:7,44:7,43:6.5,42:5.5,41:5,31:5,32:5.5,33:6.5,34:7,35:7}),64.25);
    expect(upper).toEqual({ok:true,value:{arch:"upper",requiredMm:74,availableMm:72.5,discrepancyMm:-1.5,formula:"available_minus_required_v2"}});
    expect(lower).toEqual({ok:true,value:{arch:"lower",requiredMm:62,availableMm:64.25,discrepancyMm:2.25,formula:"available_minus_required_v2"}});
  });
  it("rejects missing, wrong, duplicated and zero widths instead of inventing teeth or zero",()=>{
    const u=widths({13:8,12:7,11:10,21:10,22:7,23:8}),l=widths({43:7,42:6,41:7,31:7,32:6,33:7});
    for(const bad of [u.slice(1),[...u.slice(1),u[1]],u.map((x,i)=>i===0?{tooth:16,value:x.value}:x),u.map((x,i)=>i===0?{...x,value:0}:x),u.map((x,i)=>i===0?{...x,value:NaN}:x)])
      expect(boltonArithmetic("anterior",bad,l,77.2).ok).toBe(false);
    expect(boltonArithmetic("anterior",u,l,0).ok).toBe(false);
  });
});
