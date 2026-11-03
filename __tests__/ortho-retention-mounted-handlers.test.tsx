import type { ReactElement, ReactNode } from "react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoRetentionEvents } from "../components/OrthoRetentionEvents";
import { OrthoRetentionEventEditor, type RetentionDraftEdit } from "../components/OrthoRetentionEventEditor";
import { OrthoRetentionDocumentPicker } from "../components/OrthoRetentionDocumentPicker";
import { makeRetentionMountOwner } from "../lib/ortho-retention-mount-owner";
import { makeRetentionRecoveryLedger } from "../lib/ortho-retention-recovery";
import { canonicalJourneyJSON } from "../lib/ortho-case-journey-json";
import { readFixture, scope, row, delivery } from "./fixtures/ortho-retention-ui";
// Actual view handlers and real typed owner/reader/transport. Synthetic hook
// scheduling is not native React or browser proof. No successful POST is mocked.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { phase: "layout" | "passive"; deps?: readonly unknown[]; cleanup?: () => void }>(), pending: [] as Array<() => void> }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value,index)=>Object.is(value,b[index]));
  const effect = (phase: "layout" | "passive") => (callback: () => void | (()=>void), deps?: readonly unknown[]) => {
    const index=hooks.cursor++, old=hooks.effects.get(index); if(old&&same(old.deps,deps))return;
    hooks.pending.push(()=>{old?.cleanup?.();const cleanup=callback();hooks.effects.set(index,{phase,deps,cleanup:typeof cleanup==="function"?cleanup:undefined});});
  };
  return {...react,useEffect:effect("passive"),useLayoutEffect:effect("layout"),
    useRef:(initial:unknown)=>{const index=hooks.cursor++;if(!(index in hooks.values))hooks.values[index]={current:initial};return hooks.values[index];},
    useState:(initial:unknown)=>{const index=hooks.cursor++;if(!(index in hooks.values))hooks.values[index]=typeof initial==="function"?initial():initial;
      return[hooks.values[index],(value:unknown)=>{const next=typeof value==="function"?value(hooks.values[index]):value;if(!Object.is(next,hooks.values[index]))hooks.changed=true;hooks.values[index]=next;}];}};
});
type Node=ReactElement<Record<string,unknown>>;
const nodes=(node:ReactNode):Node[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==="object"&&"props" in node?[node as Node,...nodes((node as Node).props.children as ReactNode)]:[];
const text=(node:ReactNode):string=>typeof node==="string"||typeof node==="number"?String(node):Array.isArray(node)?node.map(text).join(""):node&&typeof node==="object"&&"props" in node?text((node as Node).props.children as ReactNode):"";
let owner:ReturnType<typeof makeRetentionMountOwner>, recovery:ReturnType<typeof makeRetentionRecoveryLedger>, allowed:boolean;
const transport=vi.fn(), confirm=vi.fn(()=>true);
function make(actorId=17){const value=makeRetentionMountOwner({...scope,actorId,ownerKey:`synthetic-${actorId}`,recovery,authorized:()=>allowed,writable:()=>allowed,deny(){allowed=false;}});value.activate();return value;}
function unmount(){hooks.effects.forEach(value=>value.cleanup?.());hooks.effects.clear();hooks.values.length=0;hooks.pending.length=0;}
function render():ReactNode{for(let n=0;n<30;n++){hooks.cursor=0;hooks.changed=false;const tree=OrthoRetentionEvents({owner,confirmDiscard:confirm});hooks.pending.splice(0).forEach(effect=>effect());if(!hooks.changed)return tree;}throw new Error("Retention handler render did not settle");}
async function flush(){for(let n=0;n<12;n++){await new Promise<void>(resolve=>setTimeout(resolve,0));render();}}
const button=(name:string)=>{const node=nodes(render()).find(value=>value.type==="button"&&text(value)===name);if(!node)throw new Error(`Missing ${name}`);return node.props.onClick as()=>void;};
const save=()=>nodes(render()).find(value=>value.type==="form")!.props.onSubmit as(e:{preventDefault():void})=>void;
const editor=()=>nodes(render()).find(value=>value.type===OrthoRetentionEventEditor)!;
const picker=()=>nodes(render()).find(value=>value.type===OrthoRetentionDocumentPicker)!;
type DocumentEdit={ownerKey:string;expectedDocumentIds:readonly number[];documentIds:readonly number[]};
const documentChange=(node=picker())=>node.props.onChange as(request:DocumentEdit)=>boolean;
const postBodies=()=>transport.mock.calls.filter(call=>call[1]?.method==="POST").map(call=>call[1].body);
async function ready(){render();await flush();expect(owner.retention).not.toBeNull();expect(editor()).toBeDefined();}
async function authored(){await ready();const node=editor(),draft=node.props.draft as RetentionDraftEdit["draft"];
  const change=node.props.onChange as(request:RetentionDraftEdit)=>boolean;
  expect(change({ownerKey:owner.ownerKey,expectedDraft:canonicalJourneyJSON(draft),draft:{...draft,kind:"device_delivery",arch:"upper",deviceType:"fixed",description:"Synthetic local retainer",extent:"13–23",reason:"Synthetic author reason"}})).toBe(true);render();}
beforeEach(()=>{unmount();allowed=true;recovery=makeRetentionRecoveryLedger();owner=make();confirm.mockReset();confirm.mockReturnValue(true);transport.mockReset();
  transport.mockImplementation(async(_url:string,init?:RequestInit)=>new Response(JSON.stringify(init?.method==="POST"?{ok:false,code:"write_unconfirmed"}:readFixture()),{status:init?.method==="POST"?503:200,headers:{"cache-control":"private, no-store"}}));
  vi.stubGlobal("crypto",webcrypto);vi.stubGlobal("fetch",transport);});
afterEach(()=>{unmount();owner.retire();vi.unstubAllGlobals();vi.useRealTimers();});
describe("actual retention mounted handlers",()=>{
  it("keeps dirty bytes across temporary view detach and retires old save/change/discard/refresh handlers",async()=>{
    await authored();const prior=owner.retention!,document=prior.document,oldSave=save(),oldDiscard=button("تجاهل المسودة وبدء تدوين جديد بعد التأكيد"),oldRefresh=button("تحديث سجل التثبيت");
    const oldEditor=editor(),change=oldEditor.props.onChange as(request:RetentionDraftEdit)=>boolean;
    unmount();await ready();const count=transport.mock.calls.length;
    oldSave({preventDefault(){}});oldDiscard();oldRefresh();expect(change({ownerKey:owner.ownerKey,expectedDraft:document,draft:oldEditor.props.draft as RetentionDraftEdit["draft"]})).toBe(false);
    await flush();expect(prior.document).toBe(document);expect(transport).toHaveBeenCalledTimes(count);expect(postBodies()).toEqual([]);expect(confirm).not.toHaveBeenCalled();
  });
  it("blocks captured fresh save while parent authority is being reread and restores the same authored draft",async()=>{
    await authored();const oldSave=save(),draft=owner.retention!.document;let release!:(response:Response)=>void;
    transport.mockImplementationOnce(()=>new Promise<Response>(resolve=>{release=resolve;}));owner.invalidateRead();render();
    expect(owner.retention).toBeNull();oldSave({preventDefault(){}});expect(postBodies()).toEqual([]);
    release(new Response(JSON.stringify(readFixture()),{headers:{"cache-control":"no-store"}}));await flush();expect(owner.retention!.document).toBe(draft);
    oldSave({preventDefault(){}});expect(postBodies()).toEqual([]);
  });
  it("retains exact unknown-result bytes through real transport retry without fabricating success",async()=>{
    await authored();save()({preventDefault(){}});await flush();expect(owner.retention!.uncertain).toBe(true);expect(postBodies()).toHaveLength(1);
    const original=postBodies()[0];button("التحقق بإعادة طلب التثبيت الأصلي")();await flush();expect(postBodies()).toEqual([original,original]);expect(owner.retention!.uncertain).toBe(true);
    expect(editor().props.writable).toBe(false);expect(text(render())).toContain("طلب غير محسوم");
  });
  it("rechecks the exact owner after a discard confirmation changes authority",async()=>{
    await authored();const before=owner.retention!.document;confirm.mockImplementation(()=>{allowed=false;return true;});
    button("تجاهل المسودة وبدء تدوين جديد بعد التأكيد")();render();expect(recovery.forDraftOwner(scope,17).read()?.owned?.document).toBe(before);expect(postBodies()).toEqual([]);
  });
  it("does not show the first actor's pending body or permit retained actions after an actor switch",async()=>{
    await authored();save()({preventDefault(){}});await flush();const oldRetry=button("التحقق بإعادة طلب التثبيت الأصلي"),first=owner;
    first.retire();unmount();owner=make(18);await ready();expect(owner.retention!.document).toBe("");expect(owner.retention!.uncertain).toBe(true);
    const count=postBodies().length;oldRetry();await flush();expect(postBodies()).toHaveLength(count);expect(text(render())).not.toContain("Synthetic local retainer");
  });
});

it("retires an old bridge-quarantine discard handler on view detach and rechecks its dialog context",async()=>{
  await authored();const before=owner.retention!.document;owner.invalidateRead();
  await expect(owner.beginRead()!.accept({...readFixture(),clinicalCaseId:92})).rejects.toThrow("retention_mount_bridge_changed");
  const old=button("تجاهل التعديلات المحلية للرابط السابق بعد التأكيد");unmount();render();
  old();expect(confirm).not.toHaveBeenCalled();expect(recovery.forDraftOwner(scope,17).read()?.owned?.document).toBe(before);
  confirm.mockImplementation(()=>{owner.invalidateRead();return true;});button("تجاهل التعديلات المحلية للرابط السابق بعد التأكيد")();
  expect(recovery.forDraftOwner(scope,17).read()?.owned?.document).toBe(before);
});

it("does not render prior-owner historical facts when the same component receives a new actor owner",async()=>{
  const original=readFixture([row(101,1,delivery("Synthetic private historical delivery"))]);
  original.revision!.reason="Synthetic private historical revision reason";
  transport.mockImplementation(async()=>new Response(JSON.stringify(original),{headers:{"cache-control":"no-store"}}));
  await ready();button("نسخة 1 · #101")();await flush();expect(text(render())).toContain("Synthetic private historical revision reason");
  owner.retire();owner=make(18);transport.mockImplementation(async()=>new Response(JSON.stringify(readFixture()),{headers:{"cache-control":"no-store"}}));
  expect(text(render())).not.toContain("Synthetic private historical revision reason");await flush();expect(text(render())).not.toContain("Synthetic private historical revision reason");
});
it("view cleanup cancels its exact accepted-in-progress GET lease without retiring the parent owner",()=>{
  const real=owner.beginRead.bind(owner),cancel=vi.fn();
  vi.spyOn(owner,"beginRead").mockImplementation(()=>{const lease=real();if(!lease)return null;const original=lease.cancel.bind(lease);lease.cancel=()=>{cancel();original();};return lease;});
  transport.mockImplementation(()=>new Promise<Response>(()=>{}));render();unmount();expect(cancel).toHaveBeenCalledTimes(1);expect(owner.retired).toBe(false);
});
it("the read timeout cancels its own lease and presents an explicit retry without asserting empty history",async()=>{
  vi.useFakeTimers();const real=owner.beginRead.bind(owner),cancel=vi.fn();
  vi.spyOn(owner,"beginRead").mockImplementation(()=>{const lease=real();if(!lease)return null;const original=lease.cancel.bind(lease);lease.cancel=()=>{cancel();original();};return lease;});
  transport.mockImplementation(()=>new Promise<Response>(()=>{}));render();await vi.advanceTimersByTimeAsync(20_000);render();
  expect(cancel).toHaveBeenCalledTimes(1);expect(owner.retention).toBeNull();expect(text(render())).toContain("لم يُعتبر السجل فارغًا");vi.useRealTimers();
});

it("cancels GET admission in layout cleanup before any passive cleanup runs",()=>{
  const real=owner.beginRead.bind(owner),cancel=vi.fn();
  vi.spyOn(owner,"beginRead").mockImplementation(()=>{const lease=real();if(!lease)return null;const original=lease.cancel.bind(lease);lease.cancel=()=>{cancel();original();};return lease;});
  transport.mockImplementation(()=>new Promise<Response>(()=>{}));render();
  for(const effect of hooks.effects.values())if(effect.phase==="layout")effect.cleanup?.();
  expect(cancel).toHaveBeenCalledTimes(1);expect(owner.retired).toBe(false);
  // The harness tracks effect phases separately; native React ordering still
  // requires the actual built-page evidence rather than this scheduler alone.
});

describe("controlled document picker at the real retention mount boundary",()=>{
  it("passes the exact owner and scope and updates only explicit document IDs",async()=>{
    await authored();const before=JSON.parse(owner.retention!.document),tree=nodes(render());
    const node=tree.find(value=>value.type===OrthoRetentionDocumentPicker)!;
    // Inspect both children from the same committed render. Calling editor()
    // here commits another render and correctly retires the picker's callback.
    expect(tree.find(value=>value.type===OrthoRetentionEventEditor)!.props.documentReferencesManaged).toBe(true);
    expect(node.props).toMatchObject({...scope,ownerIdentity:owner,ownerKey:owner.ownerKey,generation:owner.generation,readVersion:owner.readVersion,writable:true,documentIds:[]});
    expect(documentChange(node)({ownerKey:owner.ownerKey,expectedDocumentIds:[],documentIds:[501,502]})).toBe(true);
    expect(JSON.parse(owner.retention!.document)).toEqual({...before,documentIds:[501,502]});expect(postBodies()).toEqual([]);
  });
  it("rejects retained picker changes after an unrelated draft edit, without losing newer facts",async()=>{
    await authored();const old=documentChange(),node=editor(),draft=node.props.draft as RetentionDraftEdit["draft"];
    expect((node.props.onChange as(request:RetentionDraftEdit)=>boolean)({ownerKey:owner.ownerKey,expectedDraft:canonicalJourneyJSON(draft),draft:{...draft,note:"Synthetic newer unrelated fact"}})).toBe(true);
    const newer=owner.retention!.document;render();expect(old({ownerKey:owner.ownerKey,expectedDocumentIds:[],documentIds:[501]})).toBe(false);
    expect(owner.retention!.document).toBe(newer);expect(postBodies()).toEqual([]);
  });
  it("refuses foreign owner keys, stale ID snapshots and invalid arrays at the parent CAS boundary",async()=>{
    await authored();const before=owner.retention!.document,change=documentChange();
    expect(change({ownerKey:"foreign-owner",expectedDocumentIds:[],documentIds:[501]})).toBe(false);
    expect(change({ownerKey:owner.ownerKey,expectedDocumentIds:[501],documentIds:[]})).toBe(false);
    for(const documentIds of [[501,501],[0],Array.from({length:31},(_,i)=>i+1)])expect(change({ownerKey:owner.ownerKey,expectedDocumentIds:[],documentIds})).toBe(false);
    expect(owner.retention!.document).toBe(before);expect(postBodies()).toEqual([]);
  });
  it("retires captured picker edits and denial callbacks on temporary detach without deleting draft bytes",async()=>{
    await authored();const before=owner.retention!.document,node=picker(),change=documentChange(node),deny=node.props.onDenied as()=>void;
    unmount();await ready();expect(change({ownerKey:owner.ownerKey,expectedDocumentIds:[],documentIds:[501]})).toBe(false);deny();
    expect(allowed).toBe(true);expect(owner.retention!.document).toBe(before);expect(postBodies()).toEqual([]);
  });
  it("rejects a previous read-generation picker while retaining its exact local draft",async()=>{
    await authored();const old=documentChange(),before=owner.retention!.document;owner.invalidateRead();
    expect(old({ownerKey:owner.ownerKey,expectedDocumentIds:[],documentIds:[501]})).toBe(false);render();await flush();
    expect(owner.retention!.document).toBe(before);expect(postBodies()).toEqual([]);
  });
  it("preserves correction document IDs until an explicit current removal, independent of inventory pages",async()=>{
    const content={...delivery(),documentIds:[501,526]},original=readFixture([row(101,1,content)]);
    transport.mockImplementation(async()=>new Response(JSON.stringify(original),{headers:{"cache-control":"private, no-store"}}));await ready();
    button("تصحيح السجل #101 صراحةً")();const node=picker(),before=JSON.parse(owner.retention!.document);
    expect(node.props.documentIds).toEqual([501,526]);expect(before.supersedesEntryId).toBe(101);
    expect(documentChange(node)({ownerKey:owner.ownerKey,expectedDocumentIds:[501,526],documentIds:[526]})).toBe(true);
    expect(JSON.parse(owner.retention!.document)).toEqual({...before,documentIds:[526]});expect(postBodies()).toEqual([]);
  });
  it("honors a current picker authority denial and retains, rather than clearing, local facts",async()=>{
    await authored();const before=owner.retention!.document;(picker().props.onDenied as()=>void)();render();
    expect(allowed).toBe(false);expect(recovery.forDraftOwner(scope,17).read()?.owned?.document).toBe(before);expect(postBodies()).toEqual([]);
  });
});

describe("current inventory restriction and accepted source-bearing retention reads",()=>{
  it("does not retire an unrelated source-free read merely because unsaved document choices are restricted",async()=>{
    await authored();expect(documentChange()({ownerKey:owner.ownerKey,expectedDocumentIds:[],documentIds:[501]})).toBe(true);
    const before=owner.retention!.document,generation=owner.generation,read=owner.read;
    (picker().props.onRestricted as()=>void)();expect(owner.generation).toBe(generation);expect(owner.read).toBe(read);
    expect(owner.retention!.document).toBe(before);expect(allowed).toBe(true);expect(postBodies()).toEqual([]);
  });
  it("immediately invalidates cached source-bearing current events and preserves the exact unsent draft through canonical denial",async()=>{
    const original=readFixture([row(101,1,{...delivery(),documentIds:[501]})]);
    transport.mockImplementation(async()=>new Response(JSON.stringify(original),{headers:{"cache-control":"no-store"}}));await authored();
    const before=owner.retention!.document,node=picker();transport.mockImplementation(async()=>new Response(JSON.stringify({ok:false,code:"retention_images_restricted"}),{status:403,headers:{"cache-control":"no-store"}}));
    (node.props.onRestricted as()=>void)();expect(owner.read).toBeNull();expect(owner.retention).toBeNull();
    expect(recovery.forDraftOwner(scope,17).read()?.owned?.document).toBe(before);render();await flush();
    expect(allowed).toBe(false);expect(recovery.forDraftOwner(scope,17).read()?.owned?.document).toBe(before);expect(postBodies()).toEqual([]);
  });
  it("invalidates an independently inspected source-bearing historical record while retaining permitted source-free current history",async()=>{
    const records=[row(101,1,{...delivery(),documentIds:[501]}),row(102,2,delivery(),{supersedesEntryId:101})];
    const currentRead=readFixture(records),historical=readFixture(records,101);historical.revision!.reason="Synthetic protected historical document reason";
    transport.mockImplementation(async(url:string)=>new Response(JSON.stringify(url.includes("revisionId=101")?historical:currentRead),{headers:{"cache-control":"no-store"}}));
    await ready();button("نسخة 1 · #101")();await flush();expect(text(render())).toContain("Synthetic protected historical document reason");
    (picker().props.onRestricted as()=>void)();expect(owner.read).toBeNull();render();await flush();
    expect(owner.read).not.toBeNull();expect(allowed).toBe(true);expect(text(render())).not.toContain("Synthetic protected historical document reason");expect(postBodies()).toEqual([]);
  });
  it("cannot invalidate a replacement view through a retained old inventory-restriction callback",async()=>{
    const original=readFixture([row(101,1,{...delivery(),documentIds:[501]})]);
    transport.mockImplementation(async()=>new Response(JSON.stringify(original),{headers:{"cache-control":"no-store"}}));await ready();const old=picker().props.onRestricted as()=>void;
    unmount();await ready();const generation=owner.generation,read=owner.read;old();expect(owner.generation).toBe(generation);expect(owner.read).toBe(read);expect(postBodies()).toEqual([]);
  });
});

it("retires an already-entered historical inspection on restriction even when current events are source-free",async()=>{
  const records=[row(101,1,{...delivery(),documentIds:[501]}),row(102,2,delivery(),{supersedesEntryId:101})],currentRead=readFixture(records),historical=readFixture(records,101);
  historical.revision!.reason="Synthetic delayed private historical source";let release!:(response:Response)=>void,signal:AbortSignal|undefined;
  transport.mockImplementation(async(url:string,init?:RequestInit)=>{if(url.includes("revisionId=101")){signal=init?.signal as AbortSignal;return new Promise<Response>(resolve=>{release=resolve;});}
    return new Response(JSON.stringify(currentRead),{headers:{"cache-control":"no-store"}});});
  await authored();const before=owner.retention!.document,accepted=owner.read;button("نسخة 1 · #101")();expect(signal?.aborted).toBe(false);
  (picker().props.onRestricted as()=>void)();expect(signal?.aborted).toBe(true);expect(owner.read).toBe(accepted);
  release(new Response(JSON.stringify(historical),{headers:{"cache-control":"no-store"}}));await flush();
  expect(text(render())).not.toContain("Synthetic delayed private historical source");expect(owner.retention!.document).toBe(before);expect(allowed).toBe(true);expect(postBodies()).toEqual([]);
});

it("clears an already-verified historical value queued before the restriction's next render",async()=>{
  const records=[row(101,1,{...delivery(),documentIds:[501]}),row(102,2,delivery(),{supersedesEntryId:101})],currentRead=readFixture(records),historical=readFixture(records,101);
  const reason="Synthetic queued private historical source";historical.revision!.reason=reason;
  transport.mockImplementation(async(url:string)=>new Response(JSON.stringify(url.includes("revisionId=101")?historical:currentRead),{headers:{"cache-control":"no-store"}}));
  await authored();const before=owner.retention!.document,accepted=owner.read,tree=render();
  const restrict=nodes(tree).find(node=>node.type===OrthoRetentionDocumentPicker)!.props.onRestricted as()=>void;
  const inspect=nodes(tree).find(node=>node.type==="button"&&text(node)==="نسخة 1 · #101")!.props.onClick as()=>void;
  inspect();
  // Let the real async verifier finish and queue its historical state, without
  // committing another component render. This reproduces the prior old=null
  // closure while proving that the source-bearing response did get admitted.
  await expect.poll(()=>hooks.values.some(value=>value&&typeof value==="object"&&"revision" in value
    &&(value as {revision?:{reason?:unknown}}).revision?.reason===reason)).toBe(true);
  restrict();expect(text(render())).not.toContain(reason);expect(owner.read).toBe(accepted);
  expect(owner.retention!.document).toBe(before);expect(allowed).toBe(true);expect(postBodies()).toEqual([]);
});
