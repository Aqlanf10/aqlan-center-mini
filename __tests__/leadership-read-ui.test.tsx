import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
type Slot={value?:unknown;deps?:unknown[];cleanup?:()=>void};type Frame={slots:Slot[];cursor:number;effects:(()=>void)[]};
const runtime=vi.hoisted(()=>({frame:null as Frame|null,onForbidden:vi.fn()}));
vi.mock("react",async original=>{const react=await original<typeof import("react")>();const slot=()=>{const f=runtime.frame!,i=f.cursor++;return f.slots[i]??(f.slots[i]={});};return{...react,
 useContext:()=>runtime.onForbidden,
 useState:(initial:unknown)=>{const s=slot();if(!("value" in s))s.value=typeof initial==="function"?initial():initial;return[s.value,(next:unknown)=>{s.value=typeof next==="function"?next(s.value):next;}];},
 useRef:(initial:unknown)=>{const s=slot();if(!s.value)s.value={current:initial};return s.value;},
 useEffect:(fn:()=>void|(()=>void),deps?:unknown[])=>{const s=slot();if(!s.deps||!deps||deps.some((v,i)=>!Object.is(v,s.deps![i]))){s.deps=deps;runtime.frame!.effects.push(()=>{s.cleanup?.();s.cleanup=fn()||undefined;});}},
};});
import {useLeadershipRead} from "../components/leadership/useLeadershipRead";
import {MetricCard,LeadershipOverview} from "../components/leadership/LeadershipOverview";
const listeners=new Map<string,()=>void>(),response=(body:unknown,status=200)=>({ok:status<400,status,json:async()=>body});
const turns=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
// The test scheduler is outside the pure hook-bearing harness; no production hook rules are disabled.
function ReadHarness({url}:{url:string|null}) { return useLeadershipRead(url,v=>typeof v==="string"?v:null); }
function mount(){
 const frame:Frame={slots:[],cursor:0,effects:[]};let url:string|null="/synthetic/first";
 const render=()=>{runtime.frame=frame;frame.cursor=0;const read=ReadHarness({url});frame.effects.splice(0).forEach(f=>f());return read;};
 render();return{render,choose:(next:string|null)=>{url=next;},unmount:()=>frame.slots.forEach(s=>s.cleanup?.())};
}
beforeEach(()=>{vi.useFakeTimers();runtime.onForbidden.mockReset();listeners.clear();vi.stubGlobal("window",{addEventListener:(k:string,fn:()=>void)=>listeners.set(k,fn),removeEventListener:(k:string)=>listeners.delete(k)});vi.stubGlobal("document",{visibilityState:"visible",addEventListener:(k:string,fn:()=>void)=>listeners.set(k,fn),removeEventListener:(k:string)=>listeners.delete(k)});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it("shows unknown rather than zero while source data is unavailable",()=>{const html=renderToStaticMarkup(<MetricCard label="مؤشر اصطناعي" value={null} detail="المصدر لم يُتحقق منه" icon="clock" onClick={()=>{}}/>);expect(html).toContain("—");expect(html).not.toContain(">0<");});
it("clears old data at scope change and rejects superseded replies",async()=>{
 const pending:((value:unknown)=>void)[]=[];const fetch=vi.fn(()=>new Promise(resolve=>pending.push(resolve)));vi.stubGlobal("fetch",fetch);const f=mount();
 f.choose("/synthetic/second");expect(f.render().data).toBeNull();expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({signal:expect.objectContaining({aborted:true})});
 pending[1](response("new"));await turns();expect(f.render().data).toBe("new");pending[0](response("old"));await turns();expect(f.render().data).toBe("new");f.unmount();
});
it("clears successful values on revoked session or bad transport",async()=>{const fetch=vi.fn().mockResolvedValueOnce(response("verified")).mockResolvedValueOnce(response({},401));vi.stubGlobal("fetch",fetch);const f=mount();await turns();expect(f.render().data).toBe("verified");f.render().refresh();expect(f.render().data).toBeNull();await turns();expect(f.render().error).toContain("انتهت الجلسة");expect(f.render().data).toBeNull();f.unmount();});
it("marks returning focus stale without polling and cancels timeout on unmount",async()=>{const fetch=vi.fn().mockResolvedValue(response("verified"));vi.stubGlobal("fetch",fetch);const f=mount();await turns();listeners.get("focus")!();expect(f.render().stale).toBe(true);await vi.advanceTimersByTimeAsync(180000);expect(fetch).toHaveBeenCalledTimes(1);f.unmount();});
it("uses abort and unknown count on timeout",async()=>{vi.stubGlobal("fetch",vi.fn((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener("abort",()=>reject(new Error("aborted"))))));const f=mount();await vi.advanceTimersByTimeAsync(20000);await turns();expect(f.render().error).toContain("العدد غير معروف");expect(f.render().data).toBeNull();f.unmount();});

it("refreshes server-today after midnight, retains manually selected/paged cohorts, and returns explicitly to Today",async()=>{
 let serverDay="2026-10-25";
 const fetch=vi.fn(async(input:string)=>{
  const url=new URL(input,"http://synthetic"),today=serverDay,asOf=`${today}T12:00:00Z`,day=url.searchParams.get("day")||today,page=Number(url.searchParams.get("page")||0);
  const clock={today,asOf,timeZone:"Asia/Aden"};
  if(url.pathname==="/api/lab/backlog")return response({...clock,scope:"all_open_now",filter:"all",counts:{orders:0,patients:0,preparing:0,withLab:0,overdue:0,awaitingFitting:0},total:0,page:0,hasMore:false,items:[]});
  return response({...clock,view:"day",scope:"selected_arrival_day",day,page,total:11,hasMore:page===0,
   counts:{arrived:11,waiting:11,called:0,inChair:0,done:0,appointments:0,noShow:0,cancelled:0},
   items:Array.from({length:page===0?10:1},(_,i)=>({id:page*10+i+1,title:"Synthetic arrival",status:"waiting",patientId:null,eventAt:`${day}T09:00:00Z`,doctorName:null,assignee:null,dueAt:null,latestAction:null}))});
 });
 vi.stubGlobal("fetch",fetch);
 const frame:Frame={slots:[],cursor:0,effects:[]};
 const render=()=>{runtime.frame=frame;frame.cursor=0;const tree=LeadershipOverview({onSection:()=>{}});frame.effects.splice(0).forEach(effect=>effect());return tree;};
 type Element={type:unknown;props:Record<string,unknown>};
 const walk=(node:unknown):Element[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==="object"&&"props"in node?[node as Element,...walk((node as Element).props.children)]:[];
 const click=async(label:string)=>{const button=walk(render()).find(e=>e.type==="button"&&e.props.children===label);expect(button,label).toBeDefined();(button!.props.onClick as ()=>void)();render();await turns();render();};
 const latestDayUrl=()=>String(fetch.mock.calls.filter(([url])=>url.includes("pulse")).at(-1)![0]);
 render();await turns();render();expect(fetch).toHaveBeenCalledTimes(2);expect(latestDayUrl()).not.toContain("&day=");
 serverDay="2026-10-26";await click("تحديث التشغيل والمعمل");expect(latestDayUrl()).not.toContain("&day=");
 const input=walk(render()).find(e=>e.type==="input"&&e.props.type==="date")!;expect(input.props.value).toBe("2026-10-26");
 (input.props.onChange as (e:{target:{value:string}})=>void)({target:{value:"2098-01-01"}});render();await turns();render();
 await click("تحديث التشغيل والمعمل");expect(latestDayUrl()).toContain("day=2098-01-01");
 await click("اليوم");expect(latestDayUrl()).not.toContain("&day=");
 await click("عرض قائمة الزيارات");await click("التالي");expect(latestDayUrl()).toContain("page=1&day=2026-10-26");
 serverDay="2026-10-27";await click("تحديث التشغيل والمعمل");expect(latestDayUrl()).toContain("page=0&day=2026-10-26");
 await click("اليوم");expect(latestDayUrl()).not.toContain("&day=");expect(walk(render()).find(e=>e.type==="input"&&e.props.type==="date")!.props.value).toBe("2026-10-27");
 frame.slots.forEach(slot=>slot.cleanup?.());
});

it("disables an invalid financial range immediately and aborts its previous request",async()=>{
 const fetch=vi.fn().mockResolvedValue(response("verified"));vi.stubGlobal("fetch",fetch);const f=mount();await turns();expect(f.render().data).toBe("verified");
 f.choose(null);expect(f.render()).toMatchObject({data:null,error:null,loading:false});expect(fetch).toHaveBeenCalledTimes(1);
 f.choose("/synthetic/corrected");expect(f.render().loading).toBe(true);await turns();expect(f.render().data).toBe("verified");expect(fetch).toHaveBeenCalledTimes(2);f.unmount();
});
it("clears the whole hub only for a current permission refusal, never a superseded response",async()=>{
 const pending:((value:unknown)=>void)[]=[];vi.stubGlobal("fetch",vi.fn(()=>new Promise(resolve=>pending.push(resolve))));const f=mount();
 f.choose("/synthetic/new-session");f.render();pending[0](response({},401));await turns();expect(runtime.onForbidden).not.toHaveBeenCalled();
 pending[1](response({},403));await turns();expect(runtime.onForbidden).toHaveBeenCalledOnce();expect(f.render().data).toBeNull();f.unmount();
});
it("surfaces financial integrity refusal and clears verified money",async()=>{
 vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(response("verified")).mockResolvedValueOnce(response({},409)));const f=mount();await turns();expect(f.render().data).toBe("verified");
 f.render().refresh();expect(f.render().data).toBeNull();await turns();expect(f.render().error).toContain("سلامة السجلات");expect(f.render().data).toBeNull();f.unmount();
});
