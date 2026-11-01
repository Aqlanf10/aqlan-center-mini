import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DoseProfileForm, PrescriptionDoseProfiles } from "../components/PrescriptionDoseProfiles";
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

let scope='patient1:doctor1',disabled=false,profileId='amoxicillin-child-aapd-q8';
let selected=vi.fn();
beforeEach(()=>{hooks=makeHooks();ownerKey=null;retired=[];scope='patient1:doctor1';disabled=false;profileId='amoxicillin-child-aapd-q8';selected=vi.fn();identity.session={username:'doctor1',role:'doctor'};page=()=>({type:DoseProfileForm,key:scope,props:{profileId,onSelect:selected,disabled}} as Element);});
afterEach(()=>{retire();});
function field(label:string,value:string){const el=nodes(render()).find(n=>n.props['aria-label']===label);if(!el)throw Error('Missing field '+label);(el.props.onChange as (e:unknown)=>void)({target:{value}});}
function tickLabel(start:string){const label=nodes(render()).find(n=>n.type==='label'&&text(n).trim().startsWith(start));if(!label)throw Error('Missing check '+start);const el=nodes(label).find(n=>n.type==='input');if(!el)throw Error();(el.props.onChange as (e:unknown)=>void)({target:{checked:true}});}
const addLabel='نقل الجرعة والتعليمات إلى مسودة غير مؤكدة';
function fill(){render();for(const [label,value] of Object.entries({'الاستطباب المراجع':'Synthetic indication','العمر بأشهر مكتملة من تاريخ الميلاد':'60','الوزن الحالي kg':'20','المقدار المختار mg/kg/day':'30','عدد الجرعات خلال24ساعة':'3','الفاصل الأدنى بالساعات':'8','المدة المختارة بالأيام':'5','خطة المراجعة والإيقاف':'Review test patient','اسم المستحضر الفعلي':'Synthetic suspension','مادة المنتج':'amoxicillin','الشكل والطريق':'oral-liquid','قوة المنتج mg':'250','حجم المقام mL بعد التحضير':'5','تدريج أداة القياس mL':'0.1','رابط نشرة المستحضر HTTPS':'https://synthetic.invalid/label','أدنى عمر للمنتج بالأشهر وفق النشرة':'4','المادة نفسها من جميع المصادر الأخرى mg/24h — اكتب0 بعد التحقق':'0'}))field(label,value);
 for(const label of ['تحققت من العمر','تحققت من الوزن','راجعت المادة','راجعت الحساسية','قررت استطباب'])tickLabel(label);render();}
function confirm(){tickLabel('راجعت هذه المدخلات');render();}
describe('actual dose form handlers with synthetic scheduling (not browser proof)',()=>{
 it('starts blank and never inserts a dose on render',()=>{expect(button(addLabel).props.disabled).toBe(true);expect(selected).not.toHaveBeenCalled();});
 it('copies reviewed amount and directions once, with snapshot but final row unconfirmed',()=>{fill();expect(text(render())).toContain('200 mg/dose');expect(button(addLabel).props.disabled).toBe(true);confirm();const add=button(addLabel);expect(add.props.disabled).toBe(false);click(add);click(add);expect(selected).toHaveBeenCalledTimes(1);expect(selected.mock.calls[0][0]).toMatchObject({dose:'250 mg/5 mL',frequency:'Every 8 hours (3 doses/24h)',duration:'5 days',selection:{amount:'4 mL (200 mg)',confirmed:false,doseReview:{mode:'calculated',input:{weightKg:20},result:{mgPerDose:200}}}});});
 it('invalidates confirmation and stale same-tick transfer after input edit',()=>{fill();confirm();const old=button(addLabel);field('الوزن الحالي kg','21');click(old);expect(selected).not.toHaveBeenCalled();expect(button(addLabel).props.disabled).toBe(true);});
 it('retired patient/doctor form callback cannot append into the new draft',()=>{fill();confirm();const old=button(addLabel);scope='patient2:doctor2';render();click(old);expect(selected).not.toHaveBeenCalled();expect(button(addLabel).props.disabled).toBe(true);});
 it('blocks a stale callback after permission becomes unavailable',()=>{fill();confirm();const old=button(addLabel);disabled=true;render();click(old);expect(selected).not.toHaveBeenCalled();});
 it('binds outer lifetime to session principal and permissions',()=>{const first=PrescriptionDoseProfiles({onSelect:selected});identity.session={username:'doctor2',role:'doctor'};const second=PrescriptionDoseProfiles({onSelect:selected});expect(first.key).not.toBe(second.key);});
});
