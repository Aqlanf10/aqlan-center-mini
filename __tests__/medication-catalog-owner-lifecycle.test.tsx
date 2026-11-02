import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MedicationsSettings from "../app/settings/medications/page";
import { PrescriptionClinicCatalog } from "../components/PrescriptionClinicCatalog";
type Hooks = { values: unknown[]; cursor: number; changed: boolean; mounted: boolean; lateUpdates: number;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void; layout: boolean }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void>; layout: Array<() => void> };
const identity = vi.hoisted(() => ({ session: { username: "catalog-admin", role: "admin" } as { username: string; role: string } | null }));
vi.mock("../components/SessionProvider", () => ({ useSessionActions: () => ({ session: identity.session, ready: true }) }));
const runtime = vi.hoisted(() => ({ current: null as Hooks | null, editorUpdaters: [] as Array<(current: unknown) => unknown> }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const current = () => { if (!runtime.current) throw new Error("Missing synthetic owner"); return runtime.current; };
  const slot = (hooks: Hooks, initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => { const hooks = current(); const index = slot(hooks, undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); hooks.memos.set(index, { deps, value }); return value; };
  const effect = (layout: boolean) => (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const hooks = current(); const index = slot(hooks, undefined); const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    (layout ? hooks.layout : hooks.pending).push(() => { previous?.cleanup?.(); if (previous) previous.cleanup = undefined;
      const cleanup = run(); hooks.effects.set(index, { deps, layout, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => { const hooks = current(); const index = slot(hooks, typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => { if (!hooks.mounted) hooks.lateUpdates++;
        const previous = hooks.values[index];
        if (typeof value === "function" && previous && typeof previous === "object" && "username" in previous && "partyId" in previous) runtime.editorUpdaters.push(value as (current: unknown) => unknown);
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next; }]; },
    useRef: (initial: unknown) => { const hooks = current(); return hooks.values[slot(hooks, { current: initial })]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect(false), useLayoutEffect: effect(true),
  };
});
type Element=ReactElement<Record<string,unknown>>;
const makeHooks=():Hooks=>({values:[],cursor:0,changed:false,mounted:true,lateUpdates:0,effects:new Map(),memos:new Map(),pending:[],layout:[]});
let hooks:Hooks, ownerKey:string|null=null, retired:Hooks[]=[];
let page:()=>ReactNode;
function retire(){hooks.effects.forEach(e=>e.cleanup?.());hooks.mounted=false;retired.push(hooks);}
function render():ReactNode {
 const outer=page() as Element;
 if(ownerKey!==outer.key){if(ownerKey!==null)retire();hooks=makeHooks();ownerKey=outer.key;}
 let tree:ReactNode;let rounds=0;
 do{if(++rounds>20)throw Error('Render loop');hooks.cursor=0;hooks.changed=false;runtime.current=hooks;tree=(outer.type as (props:Record<string,unknown>)=>ReactNode)(outer.props);runtime.current=null;hooks.layout.splice(0).forEach(e=>e());hooks.pending.splice(0).forEach(e=>e());}while(hooks.changed);
 return tree;
}
function nodes(t:ReactNode):Element[]{if(Array.isArray(t))return t.flatMap(nodes);if(!t||typeof t!=='object'||!('props'in t))return [];return [t as Element,...nodes((t as Element).props.children as ReactNode)];}
function text(t:ReactNode):string {if(Array.isArray(t))return t.map(text).join('');if(t&&typeof t==='object'&&'props'in t)return text((t as Element).props.children as ReactNode);return t==null||typeof t==='boolean'?'':String(t);}
function button(label:string){const b=nodes(render()).find(n=>n.type==='button'&&text(n)===label);if(!b)throw Error('Missing '+label);return b;}
const click=(b:Element)=>(b.props.onClick as ()=>void)();
async function settle(){for(let i=0;i<40;i++)await Promise.resolve();}
async function ready(){render();await settle();render();}
const entry={id:'11111111-1111-4111-8111-111111111111',revision:1,enabled:true,name:'Synthetic medicine',arabicName:'',form:'tablet',strength:'1 mg',population:'adult',amount:'',frequency:'',duration:'',instructionsAr:'',instructionsEn:'',indication:'Test only',cautions:'',sourceUrl:''};
const payload={'clinical.medication_catalog':JSON.stringify({schemaVersion:1,entries:[entry]}),__versions:{'clinical.medication_catalog':'2026-11-01T00:00:00Z'}};
const response=(data:unknown)=>({ok:true,status:200,json:async()=>data});
let reads:(()=>Promise<ReturnType<typeof response>>)|null=null,patch:(()=>Promise<ReturnType<typeof response>>)|null=null;
let writes:number;
beforeEach(()=>{hooks=makeHooks();ownerKey=null;retired=[];reads=null;patch=null;writes=0;identity.session={username:'catalog-admin',role:'admin'};page=MedicationsSettings;
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method==='PATCH'){writes++;return patch?patch():response(payload);}if(url==='/api/auth/me')return response(identity.session);return reads?reads():response(payload);}));
});
afterEach(()=>{retire();vi.unstubAllGlobals();});
function edit(){click(button('تعديل / تعطيل'));render();const reason=nodes(render()).find(n=>n.type==='label'&&text(n).startsWith('سبب التغيير'))!;const input=nodes(reason).find(n=>n.type==='input')!;(input.props.onChange as (e:unknown)=>void)({target:{value:'Synthetic review'}});render();}
describe('actual catalogue component lifetime handlers (synthetic scheduling, not browser proof)',()=>{
 it('blocks dirty refresh and sends one PATCH for same-tick double click',async()=>{await ready();edit();expect(button('تحديث الدليل').props.disabled).toBe(true);let done!:(v:ReturnType<typeof response>)=>void;patch=()=>new Promise(resolve=>{done=resolve;});const save=button('حفظ التغيير');click(save);click(save);expect(writes).toBe(1);done(response(payload));await settle();expect(text(render())).toContain('حُفظ الدليل');});
 it('ignores late save when signed-in principal changes',async()=>{await ready();edit();let done!:(v:ReturnType<typeof response>)=>void;patch=()=>new Promise(resolve=>{done=resolve;});click(button('حفظ التغيير'));identity.session={username:'another-admin',role:'admin'};await ready();done(response(payload));await settle();expect(retired.every(h=>h.lateUpdates===0)).toBe(true);expect(text(render())).not.toContain('حُفظ الدليل');});
 it('ignores a late old GET after principal switch',async()=>{let done!:(v:ReturnType<typeof response>)=>void;reads=()=>new Promise(resolve=>{done=resolve;});render();await settle();identity.session={username:'another-admin',role:'admin'};reads=null;await ready();done(response(payload));await settle();expect(retired.every(h=>h.lateUpdates===0)).toBe(true);});
 it('retired catalogue selection callback cannot append to a new principal draft',async()=>{const select=vi.fn();page=()=>PrescriptionClinicCatalog({onSelect:select});await ready();const old=button('إضافة للمسودة للمراجعة');identity.session={username:'another-admin',role:'admin'};await ready();click(old);expect(select).not.toHaveBeenCalled();});
});

it('denied catalogue read exposes no entries and cannot select',async()=>{
 const select=vi.fn();page=()=>PrescriptionClinicCatalog({onSelect:select});
 reads=async()=>({ok:false,status:403,json:async()=>payload});await ready();
 expect(text(render())).toContain('تعذر تحميل إضافات المركز');
 expect(nodes(render()).some(n=>n.type==='button'&&text(n)==='إضافة للمسودة للمراجعة')).toBe(false);
 expect(select).not.toHaveBeenCalled();
});
it('late catalogue GET after principal retirement cannot expose old entries or append',async()=>{
 const select=vi.fn();page=()=>PrescriptionClinicCatalog({onSelect:select});
 let done!:(v:ReturnType<typeof response>)=>void;reads=()=>new Promise(resolve=>{done=resolve;});render();await settle();
 identity.session={username:'another-doctor',role:'doctor'};reads=async()=>response({'clinical.medication_catalog':JSON.stringify({schemaVersion:1,entries:[]})});await ready();
 done(response(payload));await settle();
 expect(text(render())).not.toContain(entry.name);expect(retired.every(h=>h.lateUpdates===0)).toBe(true);expect(select).not.toHaveBeenCalled();
});
