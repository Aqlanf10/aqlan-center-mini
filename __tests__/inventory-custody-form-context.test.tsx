import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DoctorCustody } from "../components/inventory/DoctorCustody";

type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
const runtime = vi.hoisted(() => ({ slots: [] as Slot[], cursor: 0, effects: [] as (() => void)[], send: vi.fn() }));
vi.mock("react", async original => {
 const react=await original<typeof import("react")>();
 const slot=()=>{const i=runtime.cursor++;return runtime.slots[i]??(runtime.slots[i]={});};
 return {...react,
  useState:(initial:unknown)=>{const s=slot();if(!("value" in s))s.value=typeof initial==="function"?initial():initial;return [s.value,(next:unknown)=>{s.value=typeof next==="function"?next(s.value):next;}];},
  useEffect:(fn:()=>void|(()=>void),deps?:unknown[])=>{const s=slot();if(!s.deps||!deps||deps.some((value,i)=>!Object.is(value,s.deps![i]))){s.deps=deps;runtime.effects.push(()=>{s.cleanup?.();s.cleanup=fn()||undefined;});}},
 };
});
vi.mock("../components/SessionProvider",()=>{const session={userId:4,username:"synthetic-doctor",role:"doctor",displayName:"Synthetic doctor"};return {useSession:()=>session};});
vi.mock("../components/inventory/useInventoryCommand",()=>({useInventoryCommand:()=>({locked:false,busy:false,status:"idle",message:"",describe:()=>"",send:runtime.send,retry:vi.fn(),refresh:vi.fn()})}));

type Element=ReactElement<Record<string,unknown>>;
function elements(node:ReactNode):Element[]{
 if(Array.isArray(node))return node.flatMap(elements);
 if(!node||typeof node!=="object"||!("props" in node))return [];
 const element=node as Element;return [element,...elements(element.props.children as ReactNode)];
}
function words(node:ReactNode):string{
 if(Array.isArray(node))return node.map(words).join("");
 if(typeof node==="string"||typeof node==="number")return String(node);
 return node&&typeof node==="object"&&"props" in node?words((node as Element).props.children as ReactNode):"";
}
function render(){
 runtime.cursor=0;
 const wrapper=DoctorCustody();
 const tree=(wrapper.type as (props:unknown)=>ReactNode)(wrapper.props);
 runtime.effects.splice(0).forEach(fn=>fn());
 return tree;
}
function usageForm(){return elements(render()).find(node=>node.props["data-testid"]==="custody-usage-form")!;}
function change(label:string,value:string){
 const node=elements(usageForm()).find(node=>node.type==="label"&&words(node.props.children as ReactNode).startsWith(label))!;
 const control=elements(node).find(node=>["input","select","textarea"].includes(String(node.type)))!;
 (control.props.onChange as (event:unknown)=>void)({target:{value}});
}
async function submit(){
 const form=elements(usageForm()).find(node=>node.type==="form")!;
 await (form.props.onSubmit as (event:unknown)=>Promise<void>)({preventDefault:vi.fn()});
}
beforeEach(async()=>{
 runtime.slots=[];runtime.cursor=0;runtime.effects=[];runtime.send.mockReset().mockResolvedValue(false);
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,json:async()=>({scope:"clinic",pricesAllowed:false,
  locations:[{id:"custody",label:"Synthetic custody",kind:"custody",doctorPartyId:7,lots:[{lotId:"lot",itemId:1,name:"Synthetic material",unit:"piece",quantity:"20",availableQuantity:"20",wasteQuantity:"20",heldQuantity:"0",availability:"available",trackingState:"allocated",expiryDate:"2099-01-01",lotCode:"SYN"}],closableLots:[]}],
  storeLocations:[{id:"store",label:"Synthetic store"}],pendingTransfers:[],reconciliationRequired:[],closableLots:[],stocktakes:[],packageClosures:[],settlements:[],usageEvents:[],financialAdjustments:"not_automatic",hasMoreTransfers:false,
 })}));
 render();for(let i=0;i<8;i++)await Promise.resolve();
 change("موقع العهدة للاستهلاك أو الإرجاع","custody");change("دفعة العهدة للاستهلاك أو الإرجاع","lot");
 change("كمية الاستهلاك أو الإرجاع","2");change("سبب الاستهلاك أو الإرجاع","Synthetic actual operation");
 change("معرف المريض (اختياري)","101");change("معرف الزيارة (اختياري)","202");change("معرف الإجراء (اختياري)","303");
});
afterEach(()=>{runtime.slots.forEach(slot=>slot.cleanup?.());vi.unstubAllGlobals();});

describe("custody operation form clinical context",()=>{
 it("preserves explicit clinical references for actual consumption",async()=>{
  await submit();expect(runtime.send).toHaveBeenCalledWith("custody.consume",{usage:expect.objectContaining({kind:"consumed",patientId:"101",visitId:"202",procedureId:"303"})});
 });
 it.each(["returned_to_store","approved_waste"])("does not send hidden patient fields after switching to %s",async kind=>{
  change("نوع حركة العهدة",kind);
  if(kind==="returned_to_store")change("مخزن الإرجاع","store");else change("مرجع اعتماد التالف","synthetic-approval");
  await submit();
  expect(runtime.send).toHaveBeenCalledWith(kind==="returned_to_store"?"custody.return_to_store":"custody.consume",{usage:expect.objectContaining({kind,patientId:null,visitId:null,procedureId:null})});
  change("نوع حركة العهدة","consumed");await submit();
  expect(runtime.send).toHaveBeenLastCalledWith("custody.consume",{usage:expect.objectContaining({patientId:"101",visitId:"202",procedureId:"303"})});
 });
});
