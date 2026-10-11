import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceTemplatePicker } from "../components/InvoiceTemplatePicker";
import { ToothSelectionDialog } from "../components/dental/ToothSelectionDialog";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  memo: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(), pending: [] as Array<() => void> }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value,index) => Object.is(value,b[index]));
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.effects.get(index);
    if (previous && same(previous.deps,deps)) return;
    hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = run(); hooks.effects.set(index,{deps,cleanup:typeof cleanup === "function" ? cleanup : undefined}); });
  };
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [hooks.values[index], (value: unknown) => {
      const next = typeof value === "function" ? value(hooks.values[index]) : value; if (!Object.is(next,hooks.values[index])) hooks.changed = true; hooks.values[index] = next;
    }]; },
    useRef: (initial: unknown) => { const index = slot({ current: initial }); return hooks.values[index]; },
    useMemo: (factory: () => unknown, deps?: readonly unknown[]) => { const index = slot(undefined), prior = hooks.memo.get(index);
      if (prior && same(prior.deps,deps)) return prior.value; const value = factory(); hooks.memo.set(index,{deps,value}); return value; },
    useEffect: effect, useLayoutEffect: effect,
  };
});
type Node = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Node[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Node, ...nodes((node as Node).props.children as ReactNode)] : [];
let props: ComponentProps<typeof InvoiceTemplatePicker>;
const fetchMock = vi.fn(), ready = vi.fn(), changed = vi.fn();
const template = { id: "endo", name: "Synthetic template", specialty: "علاج عصب", description: "Synthetic source only", steps: [{
  key: "rct", title: "علاج الجذور", category: "rct", preferredService: null, perTooth: true, optional: false, billingRule: "per_session", labWork: false,
  sessions: [{ title: "فتح السن", minutes: 45, afterDays: 0 }, { title: "الحشو", minutes: 30, afterDays: 7 }],
}] };
function render() {
  let result: ReturnType<typeof InvoiceTemplatePicker> | null = null;
  for (let i=0;i<30;i++) { hooks.cursor=0;hooks.changed=false;result=InvoiceTemplatePicker(props);hooks.pending.splice(0).forEach(run=>run());if(!hooks.changed)return result; }
  throw new Error("Template picker did not settle");
}
async function settle() { for(let i=0;i<20;i++)await Promise.resolve();return render(); }
const select = (label:string) => { const found=nodes(render()).find(node=>node.type==="select"&&node.props["aria-label"]===label);if(!found)throw new Error(`Missing ${label}`);return found; };
const choose = () => (select("قالب العلاج").props.onChange as (event:{target:{value:string}})=>void)({target:{value:"endo"}});
beforeEach(() => {
  hooks.values=[];hooks.cursor=0;hooks.changed=false;hooks.memo.clear();hooks.effects.clear();hooks.pending=[];
  fetchMock.mockReset();ready.mockReset();changed.mockReset();
  fetchMock.mockResolvedValue({ok:true,redirected:false,json:async()=>({templates:[template]})});
  props={patientId:11,authorityKey:"synthetic-admin",services:[{id:31,name:"Root canal",category:"rct"}],doctors:[],disabled:false,draft:null,onCatalogReady:ready,
    onChange:draft=>{changed(draft);props={...props,draft};},evidence:null};vi.stubGlobal("fetch",fetchMock);
});
afterEach(()=>{hooks.effects.forEach(one=>one.cleanup?.());vi.unstubAllGlobals();});

describe("invoice template picker preserves explicit draft identity",()=>{
  it("reads catalog only and emits explicit service/teeth references without a plan or invoice write",async()=>{
    render();await settle();expect(changed).not.toHaveBeenCalled();choose();render();
    expect(props.draft?.selection).toMatchObject({templateId:"endo",teeth:[],doctorId:null,steps:[{key:"rct",include:true,serviceId:31}]});
    const opener=nodes(render()).find(node=>node.props["data-testid"]==="invoice-template-teeth")!;
    (opener.props.onClick as ()=>void)();render();
    const picker=nodes(render()).find(node=>node.type===ToothSelectionDialog)!;
    expect(picker.props.patientId).toBe(11);expect(picker.props.mode).toBe("per_tooth_episode");
    (picker.props.onConfirm as (selection:{teeth:number[];scope:null;surfaces:string})=>void)({teeth:[36,35,36],scope:null,surfaces:""});render();
    expect(props.draft?.selection.teeth).toEqual([35,36]);expect(props.draft?.selection.sites).toEqual([]);
    expect(fetchMock.mock.calls.every(([url,init])=>url==="/api/plan-templates"&&!(init as RequestInit).method)).toBe(true);
    expect(props.draft?.selection).not.toHaveProperty("price");expect(props.draft?.selection).not.toHaveProperty("sessionPlan");
  });
  it("uses the shared dialog, cancels without edits, and retires a late confirmation",async()=>{
    render();await settle();choose();render();
    const open=()=>{const button=nodes(render()).find(node=>node.props["data-testid"]==="invoice-template-teeth")!;(button.props.onClick as ()=>void)();render();};
    open();const dialog=nodes(render()).find(node=>node.type===ToothSelectionDialog)!;
    const confirm=dialog.props.onConfirm as (selection:{teeth:number[];scope:null;surfaces:string})=>void;
    changed.mockClear();(dialog.props.onCancel as ()=>void)();render();expect(changed).not.toHaveBeenCalled();
    open();props={...props,draft:{...props.draft!,selection:{...props.draft!.selection,teeth:[37]}}};render();
    expect(nodes(render()).some(node=>node.type===ToothSelectionDialog)).toBe(false);
    confirm({teeth:[36],scope:null,surfaces:""});expect(changed).not.toHaveBeenCalled();
  });
  it("refuses a captured editor after another draft selection owns the picker",async()=>{
    render();await settle();choose();render();
    const old=select("خدمة علاج الجذور").props.onChange as (event:{target:{value:string}})=>void;
    const oldDraft=props.draft!;
    props={...props,draft:{...oldDraft,selection:{...oldDraft.selection,teeth:[36]}}};render();changed.mockClear();
    old({target:{value:"31"}});expect(changed).not.toHaveBeenCalled();
    props={...props,draft:{...oldDraft,selection:{...oldDraft.selection}}};render();
    old({target:{value:"31"}});expect(changed).not.toHaveBeenCalled();
  });
  it("does not revive captured controls across an equal-valued patient A to B to A lifetime",async()=>{
    render();await settle();choose();render();
    const old=select("خدمة علاج الجذور").props.onChange as (event:{target:{value:string}})=>void;
    props={...props,patientId:12};render();await settle();
    props={...props,patientId:11};render();await settle();changed.mockClear();
    old({target:{value:"31"}});expect(changed).not.toHaveBeenCalled();
    (select("خدمة علاج الجذور").props.onChange as (event:{target:{value:string}})=>void)({target:{value:"31"}});
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("a held catalogue refresh retires old controls even after an identical catalogue returns",async()=>{
    render();await settle();choose();render();
    const old=select("خدمة علاج الجذور").props.onChange as (event:{target:{value:string}})=>void;
    let release!: (body:unknown)=>void;
    fetchMock.mockResolvedValueOnce({ok:true,redirected:false,json:()=>new Promise(resolve=>{release=resolve;})});
    const refresh=nodes(render()).find(node=>node.type==="button"&&node.props.children==="إعادة قراءة دليل القوالب")!;
    (refresh.props.onClick as ()=>void)();render();changed.mockClear();
    expect(nodes(render()).some(node=>node.type==="select"&&node.props["aria-label"]==="قالب العلاج")).toBe(false);
    expect(nodes(render()).find(node=>node.type==="fieldset")?.props.disabled).toBe(true);
    old({target:{value:"31"}});expect(changed).not.toHaveBeenCalled();expect(ready).toHaveBeenLastCalledWith(false);
    for(let i=0;i<5;i++)await Promise.resolve();release({templates:[template]});await settle();
    old({target:{value:"31"}});expect(changed).not.toHaveBeenCalled();
    (select("خدمة علاج الجذور").props.onChange as (event:{target:{value:string}})=>void)({target:{value:"31"}});
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("captured case choices cannot use evidence retired by another preview",async()=>{
    render();await settle();choose();props={...props,draft:{...props.draft!,selection:{...props.draft!.selection,teeth:[36]}}};
    const proof={line:0,kind:"clinical" as const,specialtyLabel:"علاج عصب",item:{mode:"new" as const,id:null},
      case:{mode:"choose" as const,id:null,title:null,options:[{id:71,title:"Synthetic case"}]},refusal:null,refusalMessage:null};
    props={...props,evidence:{template:{templateId:"endo",version:"a".repeat(64),lines:[]},byRow:new Map([['template-row:["rct",36]',proof]])}};render();
    const old=select("حالة علاج الجذور 36").props.onChange as (event:{target:{value:string}})=>void;
    props={...props,evidence:null};render();changed.mockClear();old({target:{value:"71"}});
    expect(changed).not.toHaveBeenCalled();
  });
  it("retained template intent blocks current and captured manual-mode transitions until recovery clears",async()=>{
    render();await settle();choose();render();
    const beforeRetention=select("قالب العلاج").props.onChange as (event:{target:{value:string}})=>void;
    props={...props,allowManual:false};render();changed.mockClear();
    const original=props.draft;
    const retainedSelect=select("قالب العلاج");
    expect(nodes(retainedSelect).find(node=>node.type==="option"&&node.props.value==="")?.props.disabled).toBe(true);
    expect(nodes(render()).some(node=>node.props["data-testid"]==="invoice-template-retained-origin")).toBe(true);
    beforeRetention({target:{value:""}});
    (retainedSelect.props.onChange as (event:{target:{value:string}})=>void)({target:{value:""}});
    expect(changed).not.toHaveBeenCalled();expect(props.draft).toBe(original);
    // An explicitly edited template remains possible; it cannot silently become an ordinary invoice.
    (select("خدمة علاج الجذور").props.onChange as (event:{target:{value:string}})=>void)({target:{value:"31"}});render();
    expect(props.draft?.selection.templateId).toBe("endo");expect(changed).toHaveBeenCalledTimes(1);
    // The parent clears this constraint only after a verified receipt clears its recovery record.
    props={...props,allowManual:true};render();changed.mockClear();
    (select("قالب العلاج").props.onChange as (event:{target:{value:string}})=>void)({target:{value:""}});render();
    expect(changed).toHaveBeenCalledExactlyOnceWith(null);expect(props.draft).toBeNull();
  });
  it("rejects malformed or denied catalogs without a fabricated default",async()=>{
    fetchMock.mockResolvedValue({ok:true,redirected:false,json:async()=>({templates:[{id:"endo"}]})});
    render();await settle();expect(ready).not.toHaveBeenCalledWith(true);
    expect(nodes(render()).some(node=>node.type==="select")).toBe(false);expect(changed).not.toHaveBeenCalled();
  });
  it("a late catalog body cannot populate the next patient's owner",async()=>{
    let release!: (body:unknown)=>void;
    fetchMock.mockResolvedValueOnce({ok:true,redirected:false,json:()=>new Promise(resolve=>{release=resolve;})});
    render();for(let i=0;i<5;i++)await Promise.resolve();
    props={...props,patientId:12};render();await settle();const count=ready.mock.calls.filter(([value])=>value===true).length;
    release({templates:[{...template,id:"foreign"}]});await settle();
    expect(ready.mock.calls.filter(([value])=>value===true)).toHaveLength(count);
    expect(nodes(render()).some(node=>node.type==="option"&&node.props.value==="foreign")).toBe(false);
  });
});
