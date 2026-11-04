import {describe,it,expect} from "vitest";
import {readInvoiceSelectionPreview} from "../components/dental/invoice-selection-state";
const labWork={intentId:"11111111-1111-4111-8111-111111111111",memberId:"22222222-2222-4222-8222-222222222222",expectedRevision:1,groupKind:"single",prescription:{partyId:null,shade:"",stumpShade:"",toothNumbers:"",dueDate:"2026-11-01",impressionType:"physical",priority:"normal"}};
function fixture(){return {existingPlanId:null,planChoices:[{id:5,compatible:true}],lines:[{line:0,kind:"clinical",specialty:"prosthodontics",specialtyLabel:"تركيبات",item:{mode:"existing",id:30},case:{mode:"none",id:null,title:null,options:[]},itemCandidates:[{id:30,planId:5,clinicalCaseId:null}],refusal:null,refusalMessage:null,labWork,labWorkOrderId:8}]};}
const rows=[{key:"stable-row",clinical:true,planItemId:30}];
describe("invoice exact source lab preview",()=>{
 it("preserves validated exact chosen-plan prescription and same-order editor ID",()=>{const result=readInvoiceSelectionPreview(fixture(),rows,null);expect(result?.byRow.get("stable-row")?.labWork).toEqual(labWork);expect(result?.byRow.get("stable-row")?.labWorkOrderId).toBe(8);});
 it("never adopts fuzzy suggested existing work without explicit source selection",()=>{expect(readInvoiceSelectionPreview(fixture(),[{key:"stable-row",clinical:true}],null)).toBeNull();});
 it("rejects malformed intent, missing/invalid order ID, or a foreign chosen source",()=>{for(const patch of [{labWork:{...labWork,intentId:"bad"}},{labWorkOrderId:undefined},{labWorkOrderId:-1},{item:{mode:"existing",id:31}}]){const value=fixture();Object.assign(value.lines[0],patch);expect(readInvoiceSelectionPreview(value,rows,null)).toBeNull();}});
 it("accepts exact unmaterialized intent with explicit null order",()=>{const value=fixture();Object.assign(value.lines[0],{labWorkOrderId:null});expect(readInvoiceSelectionPreview(value,rows,null)?.byRow.get("stable-row")?.labWorkOrderId).toBeNull();});
 it("preserves legacy preview without fabricating lab evidence",()=>{const value=fixture();const {labWork:_work,labWorkOrderId:_order,...line}=value.lines[0];expect(readInvoiceSelectionPreview({...value,lines:[line]},rows,null)?.byRow.get("stable-row")?.labWork).toBeUndefined();});
});
