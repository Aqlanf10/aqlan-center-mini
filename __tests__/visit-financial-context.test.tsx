import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { projectVisitFinancialContext, redactVisitFinancialContext, type VisitFinancialWork } from "../lib/visit-financial-context";
import { VisitFinancialSourceDetails } from "../components/VisitFinancialSources";
import { canViewMoney } from "../lib/roles";
const work = (id:number,coverage:VisitFinancialWork["coverage"]="verified",decision:VisitFinancialWork["decision"]="none"):VisitFinancialWork => ({ key:`procedure:${id}`,id,kind:"procedure",coverage,decision,reasons:[],references:[{kind:"invoice",id:81,state:"current",path:"visit_procedure"}] });
const context=(lines:VisitFinancialWork[])=>projectVisitFinancialContext({visitId:42,patientId:23,signed:true,directReference:null,directReferenceState:"missing",work:lines});
describe("visit source projection",()=>{
 it("keeps verified coverage, explicit decision and mixed/unresolved work separate",()=>{
  expect(context([work(1)]).summary).toBe("verified");expect(context([work(1,"unresolved","no_charge")]).summary).toBe("no_new_charge");
  expect(context([work(1),work(2,"unresolved")]).summary).toBe("mixed");expect(context([work(1),work(2,"unresolved","no_charge")]).summary).toBe("mixed");
  expect(context([{...work(1),reasons:["source_conflict"]}]).summary).toBe("unresolved");expect(context([]).summary).toBe("no_recorded_work");
 });
 it("rejects duplicate work and deduplicates repeated evidence paths",()=>{
  expect(()=>context([work(1),work(1)])).toThrow("Duplicate");const line=work(1);line.references.push({...line.references[0]});
  expect(context([line]).work[0].references).toHaveLength(1);
 });
 it.each(["doctor","assistant","admin","reception","accountant","cashier"])("uses existing %s financial visibility without money or unauthorized source IDs",role=>{
  const result=redactVisitFinancialContext(context([work(1)]),canViewMoney(role));
  const html=renderToStaticMarkup(<VisitFinancialSourceDetails context={result} financial={canViewMoney(role)} />);
  expect(html.includes("/print/invoice/81")).toBe(canViewMoney(role));expect(html.includes("#81")).toBe(canViewMoney(role));
  expect(JSON.stringify(result)).not.toMatch(/amount|total|Minor|balance|receipt/i);
 });
 it("never links historical or review references, even for finance roles",()=>{
  const line=work(1);line.references[0].state="historical";
  expect(renderToStaticMarkup(<VisitFinancialSourceDetails context={context([line])} financial />)).not.toContain("href=");
  line.references[0].state="review";expect(renderToStaticMarkup(<VisitFinancialSourceDetails context={context([line])} financial />)).not.toContain("href=");
 });
});
