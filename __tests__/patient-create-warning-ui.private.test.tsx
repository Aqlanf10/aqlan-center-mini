/** Headless synthetic JSX/handler wiring, not a hosted browser or replay test. */
import type {ReactElement,ReactNode} from "react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import PatientsPage from "../app/patients/page";
import {QuickPatientModal} from "../components/QuickPatientModal";
import {FamilyLinkSuggestion} from "../components/FamilyLinkSuggestion";
import {PreviousBalanceFields} from "../components/PreviousBalanceFields";
import {PATIENT_CREATE_RECHECK, PATIENT_CREATE_UNCERTAIN} from "../lib/patient-create-warning";

const hooks = vi.hoisted(()=>({slots:[] as unknown[],cursor:0}));
vi.mock("react",async original=>{
  const react=await original<typeof import("react")>();
  const slot=(x:unknown)=>{const i=hooks.cursor++;if(!(i in hooks.slots))hooks.slots[i]=x;return i;};
  return {...react,
    useState(initial:unknown){
      const i=slot(initial);
      return [hooks.slots[i],(value:unknown)=>{hooks.slots[i]=typeof value==="function"?value(hooks.slots[i]):value;}];
    },
    useRef:(initial:unknown)=>hooks.slots[slot({current:initial})],
    useCallback:(fn:unknown)=>fn,
    useId:()=>"fixture-form",
    useEffect:()=>undefined,
  };
});
vi.mock("next/navigation",()=>({useRouter:()=>({push:vi.fn()})}));
vi.mock("../components/Modal",()=>({Modal:()=>null}));
vi.mock("../components/SettingsProvider",()=>({useSetting:()=>undefined}));
vi.mock("../components/PatientContactPanel",()=>({PatientFlagChips:()=>null}));
vi.mock("../components/FamilyLinkSuggestion",async original=>({
  ...await original<typeof import("../components/FamilyLinkSuggestion")>(),FamilyLinkSuggestion:()=>null,
}));

type Element=ReactElement<Record<string,unknown>>;
function nodes(value:ReactNode):Element[]{
  if(Array.isArray(value))return value.flatMap(nodes);
  if(!value||typeof value!=="object"||!("props"in value))return [];
  const node=value as Element;
  return [node,...nodes(node.props.children as ReactNode)];
}
function words(value:ReactNode):string{
  if(typeof value==="string")return value;
  if(Array.isArray(value))return value.map(words).join("");
  if(value&&typeof value==="object"&&"props"in value)return words((value as Element).props.children as ReactNode);
  return "";
}
function required<T>(value:T|undefined):T {if(value===undefined)throw Error("missing exact JSX control");return value;}
const fetchMock=vi.fn();
const event={preventDefault(){}};
function tap(node:Element) { return (node.props.onClick as (e:typeof event)=>void|Promise<void>)(event); }
async function tick(){for(let i=0;i<14;i++)await Promise.resolve();}
const response=(status:number,body:unknown)=>({status,ok:status<400,json:async()=>body});
const clash=response(409,{message:"تحذير تجريبي",duplicates:[
  {patient:{id:77,patientNumber:"P-07077",fullName:"SYNTHETIC EXISTING",phone:"967731234567"},reason:"phone"},
]});
const nameA="SYNTHETIC ONE",nameB="SYNTHETIC TWO",phone="967731234567";
let props:Parameters<typeof QuickPatientModal>[0];
beforeEach(()=>{
  hooks.cursor=0;hooks.slots=[];fetchMock.mockReset();
  vi.stubGlobal("fetch",fetchMock);
  vi.stubGlobal("window",{alert:vi.fn()});
  props={isOpen:true,onClose:vi.fn(),onSuccess:vi.fn()};
});
afterEach(()=>vi.unstubAllGlobals());

function mount(kind:"inline"|"quick"){
  const inline=kind==="inline";
  let renderTree=()=>QuickPatientModal(props);
  const notify=inline ? vi.fn() : props.onSuccess!;
  if(inline){
    hooks.cursor=0;
    const root=nodes(PatientsPage());
    tap(required(root.find(e=>e.type==="button"&&words(e.props.children as ReactNode)==="+ مريض جديد")));
    hooks.cursor=0;
    const opened=required(nodes(PatientsPage()).find(e=>typeof e.type==="function"&&e.type.name==="NewPatientForm"));
    const Form=opened.type as unknown as (p:Record<string,unknown>)=>ReactElement;
    hooks.slots=[];
    renderTree=()=>Form({...opened.props,onCreated:notify});
  }
  const render=()=>{hooks.cursor=0;return nodes(renderTree());};
  const field=(key:string)=>required(render().find(n=>n.type==="input" &&
    (n.props["aria-label"]===key || String(n.props.id).endsWith("-"+key))));
  const name=()=>field(inline?"الاسم الكامل":"name");
  const set=(e:Element,value:string)=>(e.props.onChange as (x:unknown)=>void)({target:{value}});
  const confirm=()=>render().find(n=>n.type==="button"&&words(n.props.children as ReactNode)===
    (inline?"ليس أحدهم — أضف مريضًا جديدًا":"تأكيد الإنشاء رغم التشابه"));
  const review=()=>required(render().find(n=>n.type==="button"&&words(n.props.children as ReactNode)===
    (inline?"تراجع":"مراجعة وتعديل الاسم")));
  const selectFamily=(choice:{familyId:number;name:string;role:null})=>
    (required(render().find(n=>n.type===FamilyLinkSuggestion)).props.onChange as (value:unknown)=>void)(choice);
  const editBalance=()=>{
    const change=required(render().find(n=>n.type===PreviousBalanceFields)).props.onChange as (value:unknown)=>void;
    change({enabled:true,amount:"37",currency:"SAR",note:"synthetic"});
  };
  const submit=async()=>{
    const form=required(render().find(n=>n.type==="form"));
    await (form.props.onSubmit as (e:typeof event)=>void)(event);await tick();
  };
  const focus=vi.fn();
  const nameRef=name().props.ref as {current:unknown}|undefined;
  if(nameRef)nameRef.current={focus};
  set(name(),nameA);
  set(field(inline?"رقم الجوال":"phone"),phone);
  return { render,name, set,confirm,review,submit,notify,focus,selectFamily,editBalance };
}

function requestBody(index:number) {
  return JSON.parse(fetchMock.mock.calls[index][1].body as string);
}

describe.each(["inline","quick"] as const)("%s exact component handlers",kind=>{
  it("dismisses warning on relevant edits and rejects a stale direct click even after a newer same-form warning",async()=>{
    const u=mount(kind);
    fetchMock.mockResolvedValue(clash);
    await u.submit();
    const old=required(u.confirm());
    u.set(u.name(),nameB);
    expect(u.confirm()).toBeUndefined();
    await tap(old);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(u.focus).toHaveBeenCalled();
    expect(u.render().some(n=>words(n.props.children as ReactNode)===PATIENT_CREATE_RECHECK)).toBe(true);

    // Even returning to the same serialized body does not revive the old button.
    u.set(u.name(),nameA);
    await u.submit();
    expect(u.confirm()).toBeDefined();
    await tap(old);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(1).confirmDuplicate).toBe(false);
  });

  it("ignores a delayed duplicate for a form edited while the request was pending",async()=>{
    const u=mount(kind);
    let finish!:(value:unknown)=>void;
    fetchMock.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const inFlight=u.submit();
    u.set(u.name(),nameB);
    u.set(u.name(),nameA); // even edit then revert invalidates the pending preview
    finish(clash);
    await inFlight;
    expect(u.confirm()).toBeUndefined();
    expect(u.render().some(n=>words(n.props.children as ReactNode)===PATIENT_CREATE_RECHECK)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serializes two same-tick submissions and supersedes the prior warning even for identical fields",async()=>{
    const u=mount(kind);let finish!:(value:unknown)=>void;
    fetchMock.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(clash);
    const first=u.submit();
    const redundant=u.submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(clash);
    await first;await redundant;
    const obsolete=required(u.confirm());
    await u.submit();
    expect(u.confirm()).toBeDefined();
    await tap(obsolete);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows distinct household member only against their own fresh warning and passes exact returned ID to family link",async()=>{
    const u=mount(kind);
    fetchMock.mockResolvedValueOnce(clash).mockResolvedValueOnce(clash)
      .mockResolvedValueOnce(response(201,{id:92,fullName:nameB,patientNumber:"P-07092",phone}))
      .mockResolvedValueOnce(response(201,{}));
    await u.submit();
    u.set(u.name(),nameB);
    u.selectFamily({familyId:13,name:"Synthetic household",role:null});
    await u.submit();
    expect(requestBody(0)).toMatchObject({fullName:nameA,phone,confirmDuplicate:false});
    expect(requestBody(1)).toMatchObject({fullName:nameB,phone,confirmDuplicate:false});
    await tap(required(u.confirm()));await tick();
    expect(requestBody(2)).toMatchObject({fullName:nameB,phone,confirmDuplicate:true});
    const key = (i: number) => new Headers(fetchMock.mock.calls[i][1].headers).get("Idempotency-Key");
    expect(key(0)).not.toBe(key(1));
    expect(key(1)).toBe(key(2));
    expect(fetchMock.mock.calls[3][0]).toBe("/api/families/13/members");
    expect(requestBody(3)).toEqual({patientId:92,role:null});
    expect(u.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:92,patientNumber:"P-07092"}));
  });

  it("consumes the confirmation, restores focus on review and does not retry a lost save with Boolean true",async()=>{
    const u=mount(kind);
    fetchMock.mockResolvedValueOnce(clash).mockResolvedValueOnce(clash)
      .mockRejectedValueOnce(Error("synthetic response lost")).mockResolvedValueOnce(clash);
    await u.submit();
    await tap(u.review());
    expect(u.focus).toHaveBeenCalledTimes(1);
    expect(u.confirm()).toBeUndefined();
    await u.submit();
    const used=required(u.confirm());
    await tap(used);await tick();
    expect(u.render().some(n=>words(n.props.children as ReactNode)===PATIENT_CREATE_UNCERTAIN)).toBe(true);
    await tap(used);await tick();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await u.submit();
    expect(fetchMock.mock.calls.map((_,i)=>requestBody(i).confirmDuplicate)).toEqual([false,false,true,false]);
    const keys = fetchMock.mock.calls.map(([, init]) => new Headers(init.headers).get("Idempotency-Key"));
    expect(keys[0]).toMatch(/^register:/);
    expect(new Set(keys).size).toBe(1);
    expect(u.notify).not.toHaveBeenCalled();
  });

  it("invalidates on the selected family or previous balance changing, not merely name or phone",async()=>{
    const u=mount(kind);
    fetchMock.mockResolvedValue(clash);
    await u.submit();
    u.editBalance();
    expect(u.confirm()).toBeUndefined();
    await u.submit();
    u.selectFamily({familyId:11,name:"Other synthetic household choice",role:null});
    expect(u.confirm()).toBeUndefined();
  });
});


it("invalidates the Quick Patient warning across modal close and reopen", async()=>{
  const u=mount("quick");
  fetchMock.mockResolvedValue(clash);
  await u.submit();
  const old=required(u.confirm());
  const close=required(u.render().find(e=>e.type==="button"&&e.props["aria-label"]==="إغلاق"));
  await tap(close);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  props={...props,isOpen:false};
  expect(u.render()).toEqual([]);
  props={...props,isOpen:true};
  expect(u.confirm()).toBeUndefined();
  await tap(old);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
