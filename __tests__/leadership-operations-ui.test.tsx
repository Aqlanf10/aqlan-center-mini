import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperationalOverview, OperationalSection } from "../lib/leadership-operations";
type Slot={value?:unknown;deps?:unknown[];cleanup?:()=>void};
type Frame={slots:Slot[];cursor:number;effects:(()=>void)[]};
const runtime=vi.hoisted(()=>({frame:null as Frame|null,session:{username:"synthetic",role:"admin"} as {username:string;role:string}|null}));
vi.mock("react",async original=>{const react=await original<typeof import("react")>();const slot=()=>{const f=runtime.frame!;const i=f.cursor++;return f.slots[i]??(f.slots[i]={});};return {...react, useContext:()=>null,
  useState:(initial:unknown)=>{const s=slot();if(!("value"in s))s.value=typeof initial==="function"?initial():initial;return[s.value,(next:unknown)=>{s.value=typeof next==="function"?next(s.value):next;}];},
  useRef:(initial:unknown)=>{const s=slot();if(!s.value)s.value={current:initial};return s.value;},
  useEffect:(fn:()=>void|(()=>void),deps?:unknown[])=>{const s=slot();if(!s.deps||!deps||deps.some((v,i)=>!Object.is(v,s.deps![i]))){s.deps=deps;runtime.frame!.effects.push(()=>{s.cleanup?.();s.cleanup=fn()||undefined;});}},
};});
vi.mock("../components/SessionProvider",()=>({useSession:()=>runtime.session}));
import { LeadershipOperationalOverview, OperationalOverviewPanel, OperationalSourceSection } from "../components/leadership/LeadershipOperationalOverview";
import { decodeOperationalOverview } from "../lib/leadership-operations";
type Element=ReactElement<Record<string,unknown>>;
function elements(node:ReactNode):Element[]{if(Array.isArray(node))return node.flatMap(elements);if(!node||typeof node!=="object"||!("props"in node))return[];const e=node as Element;return[e,...elements(e.props.children as ReactNode)];}
function words(node:ReactNode):string{if(Array.isArray(node))return node.map(words).join(" ");if(typeof node==="string"||typeof node==="number")return String(node);return node&&typeof node==="object"&&"props"in node?words((node as Element).props.children as ReactNode):"";}
const turns=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const snapshot=(day="2026-10-22",lane:"all"|"doctor"|"reception"="all"):OperationalOverview=>({day,timeZone:"Asia/Aden",lane,sections:(lane==="all"?["appointments","referrals"]:lane==="doctor"?["referrals"]:["appointments"]).map(source=>({source:source as "appointments"|"referrals",status:"ready",asOf:"2026-10-22T07:00:00Z",total:0,page:0,hasMore:false,items:[]}))});
const response=(body:unknown,status=200)=>({ok:status<400,status,json:async()=>body});
const listeners=new Map<string,()=>void>();
function mount(){const frame:Frame={slots:[],cursor:0,effects:[]};const render=()=>{runtime.frame=frame;frame.cursor=0;const tree=OperationalOverviewPanel();frame.effects.splice(0).forEach(fn=>fn());return tree;};
  const find=(type:string,text?:string)=>elements(render()).find(e=>e.type===type&&(!text||words(e.props.children as ReactNode)===text))!;
  const click=(text:string)=>(find("button",text).props.onClick as()=>void)();
  const date=(value:string)=>(find("input").props.onChange as(e:unknown)=>void)({target:{value}});
  render();return{render,find,click,date,unmount:()=>frame.slots.forEach(s=>s.cleanup?.())};}
beforeEach(()=>{vi.useFakeTimers();listeners.clear();runtime.session={username:"synthetic",role:"admin"};
  vi.stubGlobal("window",{addEventListener:(k:string,fn:()=>void)=>listeners.set(k,fn),removeEventListener:(k:string)=>listeners.delete(k)});
  vi.stubGlobal("document",{visibilityState:"visible",addEventListener:(k:string,fn:()=>void)=>listeners.set(k,fn),removeEventListener:(k:string)=>listeners.delete(k)});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it.each([null,{username:"synthetic",role:"doctor"},{username:"synthetic",role:"reception"}])("does not mount or fetch operational patient data for a non-admin session",session=>{runtime.session=session;const fetch=vi.fn();vi.stubGlobal("fetch",fetch);expect(LeadershipOperationalOverview()).toBeNull();expect(fetch).not.toHaveBeenCalled();});
it("keys the complete view by current authenticated account",()=>{expect(LeadershipOperationalOverview()?.key).toBe("synthetic:admin:");runtime.session={username:"other",role:"admin"};expect(LeadershipOperationalOverview()?.key).toBe("other:admin:");});
it("distinguishes loading from a verified zero and pins the default clinic day across midnight",async()=>{
  const fetch=vi.fn().mockResolvedValue(response(snapshot()));vi.stubGlobal("fetch",fetch);const f=mount();
  expect(words(f.render())).toContain("الأعداد غير معروفة بعد");await turns();expect(f.find("input").props.value).toBe("2026-10-22");
  vi.setSystemTime(new Date("2026-10-23T21:00:00Z"));f.click("تحديث القراءة");f.render();await turns();
  expect(fetch.mock.calls[1][0]).toContain("day=2026-10-22");f.unmount();
});
it("hides previous data immediately on a day change and ignores the superseded reply",async()=>{
  const pending:((v:unknown)=>void)[]=[];const fetch=vi.fn(()=>new Promise(resolve=>pending.push(resolve)));vi.stubGlobal("fetch",fetch);const f=mount();
  f.date("2026-10-21");f.render();expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({signal:expect.objectContaining({aborted:true})});
  pending[1](response(snapshot("2026-10-21")));await turns();expect(words(f.render())).toContain("2026-10-21");
  pending[0](response(snapshot("2026-10-22")));await turns();expect(words(f.render())).not.toContain("2026-10-22");f.unmount();
});
it("clears the previous snapshot after session expiry rather than retaining stale patient content",async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(response(snapshot())).mockResolvedValueOnce(response({message:"private"},401));vi.stubGlobal("fetch",fetch);const f=mount();await turns();
  f.click("تحديث القراءة");f.render();await turns();expect(words(f.render())).toContain("انتهت الجلسة");expect(elements(f.render()).some(e=>e.type===OperationalSourceSection)).toBe(false);f.unmount();
});
it("marks a returned-to tab stale without pretending a time threshold is a clinical SLA",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response(snapshot())));const f=mount();await turns();listeners.get("focus")!();
  expect(words(f.render())).toContain("قد تكون السجلات تغيّرت");f.unmount();expect(listeners.size).toBe(0);
});
it("aborts pending reads on unmount",async()=>{
  const fetch=vi.fn().mockImplementation(()=>new Promise(()=>{}));vi.stubGlobal("fetch",fetch);const f=mount();f.unmount();expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
});
it("turns a request timeout into unknown, not zero",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockImplementation((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener("abort",()=>reject(new Error("aborted"))))));
  const f=mount();await vi.advanceTimersByTimeAsync(20_000);await turns();expect(words(f.render())).toContain("العدد غير معروف");expect(f.find("button","تحديث القراءة").props.disabled).toBe(false);f.unmount();
});
it("rejects malformed, wrong-day or partial transport metadata instead of rendering misleading counts",()=>{
  const valid=snapshot();expect(decodeOperationalOverview(valid,valid.day,"all")).toEqual(valid);
  for(const bad of [{...valid,day:"2026-10-23"},{...valid,timeZone:"Invalid/Zone"},{...valid,sections:[]},{...valid,sections:[{...valid.sections[0],total:1},valid.sections[1]]}])expect(decodeOperationalOverview(bad,valid.day,"all")).toBeNull();
});
it("uses explicit read-only scope and native labeled date controls without duplicating Today actions",()=>{
  vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>new Promise(()=>{})));const f=mount();const text=words(f.render());
  expect(text).toContain("ليست قائمة بكل المتابعات المتراكمة");expect(text).toContain("فتح الملف لا يغلق المتابعة");
  expect(f.find("input").props).toMatchObject({id:"operational-day",type:"date","aria-describedby":"operational-scope"});
  expect(elements(f.render()).filter(e=>e.type==="button").map(e=>words(e.props.children as ReactNode))).not.toContain("وصل");f.unmount();
});
it("SSR keeps source error unknown and successful empty scope explicit",()=>{
  const failed:OperationalSection={source:"appointments",status:"error",asOf:null,total:null,message:"العدد غير معروف"};
  const html=renderToStaticMarkup(<OperationalSourceSection section={failed} timeZone="Asia/Aden" onPage={()=>{}} onRetry={()=>{}}/>);
  expect(html).toContain('role="alert"');expect(html).toContain("العدد غير معروف");expect(html).not.toContain("0 موعد");
  const empty=renderToStaticMarkup(<OperationalSourceSection section={snapshot().sections[0]} timeZone="Asia/Aden" onPage={()=>{}} onRetry={()=>{}}/>);
  expect(empty).toContain("هذا لا ينفي وجود متابعات في أيام أخرى");
});
it("SSR links only the exact patient and separates original cancellation from replacement proof",()=>{
  const section:OperationalSection={source:"appointments",status:"ready",asOf:"2026-10-22T07:00:00Z",total:1,page:0,hasMore:false,items:[{id:71,patientId:23,patientName:"Synthetic",patientNumber:"SYN-23",status:"cancelled",state:"replacement_active",eventAt:"2026-10-22 16:00",plannedVisitId:81,reviewDoctor:null,replacement:{id:72,date:"2026-10-23",time:"16:00",status:"booked",auditId:"91",recordedAt:"2026-10-22T07:00:00Z"}}]};
  const html=renderToStaticMarkup(<OperationalSourceSection section={section} timeZone="Asia/Aden" onPage={()=>{}} onRetry={()=>{}}/>);
  expect(html).toContain('href="/patients/23?tab=summary"');expect(html).toContain("ملغى");expect(html).toContain("حجز بديل قائم موثّق");expect(html).toContain("تفاصيل الحجز البديل");expect(html).not.toContain("وقت الموعد الأصلي ليس");expect(html).toContain("سجل #91");
});
