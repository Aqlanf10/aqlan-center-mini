import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoSpacePanel } from "../components/PatientOrtho";
import OrthoSpaceLedger, {type SpaceEditorCommand} from "../components/OrthoSpaceLedger";
import type {SpaceLedgerRead} from "../lib/ortho-space-client";
import type {SpaceSubmissionRecovery} from "../lib/ortho-space-submission-contract";
import type {SpacePersistenceCommand} from "../lib/ortho-space-command";

// Exercise the actual standalone form's state and submit handlers with synthetic data.
// Peripheral components are stubbed; no route, database, browser, or real network runs.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, memos: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  session: { userId: 7, username: "synthetic-doctor", role: "doctor", permissions: { canUploadXrays: true } } as Record<string, unknown>,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useContext: () => null,
    useMemo: (compute: () => unknown, deps?: readonly unknown[]) => {
      const index = hooks.cursor++; const before = hooks.memos.get(index);
      if (before && deps && before.deps && deps.length === before.deps.length && deps.every((value, at) => Object.is(value, before.deps![at]))) return before.value;
      const value = compute(); hooks.memos.set(index, { value, deps }); return value;
    },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.cursor++; const before = hooks.effects.get(index);
      if (before && deps && before.deps && deps.length === before.deps.length
        && deps.every((value, at) => Object.is(value, before.deps![at]))) return;
      before?.cleanup?.();
      hooks.effects.set(index, { deps, cleanup: effect() || undefined });
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.cursor++; const before = hooks.effects.get(index);
      if (before && deps && before.deps && deps.length === before.deps.length
        && deps.every((value, at) => Object.is(value, before.deps![at]))) return;
      before?.cleanup?.();
      hooks.effects.set(index, { deps, cleanup: effect() || undefined });
    },
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) {
        hooks.values[index] = typeof initial === "function" ? initial() : initial;
      }
      return [hooks.values[index], (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
  };
});
vi.mock("../components/LegacyOnboardingChecklist", () => ({ LegacyOnboardingChecklist: () => null }));
vi.mock("../components/OrthoPackageLink", () => ({ OrthoPackageLink: () => null }));
vi.mock("../components/PatientCeph", () => ({ PatientCeph: () => null }));
vi.mock("../components/PatientDiagnosis", () => ({ PatientDiagnosis: () => null }));
vi.mock("../components/WebCephRecordsGrid", () => ({ WebCephRecordsGrid: () => null }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));

type Props = ComponentProps<typeof OrthoSpacePanel>;
type Case = Props["row"];
type Element = ReactElement<Record<string, unknown>>;
const base: Case = {
  id: 95001, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
  status: "active", phase: "aligning", startDate: "2026-09-01", plannedMonths: 18,
  upperWire: "014 NiTi", lowerWire: "012 NiTi", planId: null, retainer: null, retainerOn: null, note: null,
  closedAt: null, closedBy: null, closedNote: null, baselineKind: null, baselineRecordedAt: null,
  elastics: null, responsibleDoctorName: null, legacyFinancialMode: null, remainingObjectives: null,
  adjustments: [{ id: 94001, visitId: 91001, visitSigned: true, doneOn: "2026-09-01", phase: "aligning",
    upperWire: "012 NiTi", lowerWire: null, elastics: "none", elasticNote: null,
    done: "Historical signed adjustment, not today's work", nextWeeks: 4, note: null,
    recordedBy: "Synthetic clinician", photos: [],
  }],
  progress: { monthsElapsed: 1, monthsPlanned: 18, monthsRemaining: 17, percent: 6,
    overdue: false, adjustments: 1, lastAdjustment: "2026-09-01", daysSinceLast: 33 },
};
const clients=vi.hoisted(()=>({bootstrap:vi.fn(),submit:vi.fn(),cancel:vi.fn(),identity:vi.fn(),verify:vi.fn()}));
vi.mock('../lib/ortho-space-submission-client',()=>({bootstrapSpaceRecovery:clients.bootstrap,submitSpaceAndAcknowledge:clients.submit,cancelSpaceAndAcknowledge:clients.cancel,spaceCommandIdentity:clients.identity}));
vi.mock('../lib/ortho-space-client',()=>({verifySpaceRead:clients.verify}));
const patientId=92001,scope={patientId,orthoCaseId:base.id,clinicalCaseId:3};
const ref={kind:'assessment_analysis' as const,id:11,member:'upper',version:`sha256:${'a'.repeat(64)}`};
const plan=():SpacePersistenceCommand=>({schemaVersion:1,clientRequestId:'synthetic_space_command_1',expectedHeadId:null,reason:'Synthetic documentary plan',content:{kind:'plan',arch:'upper',strategyRevisionId:12,baseline:ref,gains:[],uses:[],contacts:[{teeth:[11,12],plannedUm:null,budgetGainUm:null,clinicianLimitUm:null,note:'Contact confirmed by synthetic clinician'}],rationale:'Clinician authored rationale',alternatives:'Clinician reviewed alternatives'}});
const session={id:94001,visitId:91001,occurredOn:'2026-09-01',recordedBy:'Synthetic clinician'};
let recovery:SpaceSubmissionRecovery['recovery'];
let data:SpaceLedgerRead;
const calls:string[]=[];
const fetchMock=vi.fn();
const metadata=():SpaceSubmissionRecovery=>({ok:true,scope,actorId:7,recovery});
const identity={id:8,commandId:'synthetic_space_command_1',requestFingerprint:'a'.repeat(64)};
const pending=(state:'pending'|'committed'='pending'):SpaceSubmissionRecovery['recovery']=>({state,identity,expected:{scope,actorId:7,command:plan()}});
function unmount(){for(const effect of hooks.effects.values())effect.cleanup?.();hooks.effects.clear();hooks.memos.clear();hooks.values=[];hooks.cursor=0;}
function render(){hooks.cursor=0;return OrthoSpacePanel({patientId,row:base});}
function elements(node:ReactNode):Element[]{
 if(Array.isArray(node))return node.flatMap(elements);
 if(!node||typeof node!=='object'||!('props'in node))return[];
 const e=node as Element;return[e,...elements(e.props.children as ReactNode)];
}
function text(node:ReactNode):string {if(typeof node==='string'||typeof node==='number')return String(node);if(Array.isArray(node))return node.map(text).join('');if(node&&typeof node==='object'&&'props'in node)return text((node as Element).props.children as ReactNode);return'';}
function editor(){const e=elements(render()).find(e=>e.type===OrthoSpaceLedger);if(!e)throw Error('Missing editor');return e.props as unknown as ComponentProps<typeof OrthoSpaceLedger>;}
function button(label:string){const b=elements(render()).find(e=>e.type==='button'&&text(e)===label);if(!b)throw Error(`Missing ${label}`);return b;}
async function flush(){for(let i=0;i<5;i++){await new Promise(resolve=>setTimeout(resolve,0));render();}}
async function click(label:string){const b=button(label);expect(b.props.disabled).not.toBe(true);(b.props.onClick as()=>void)();await flush();}
async function ready(){render();await flush();editor().update(plan());render();}
const retryLabel='التحقق من طلب المسافات والإقرار بنتيجته',cancelLabel='إلغاء طلب المسافات والإقرار',refreshLabel='تحديث سجل المسافات';
beforeEach(()=>{
 unmount();vi.clearAllMocks();recovery=null;calls.length=0;
 hooks.session={userId:7,username:'synthetic-doctor',role:'doctor',permissions:{canUploadXrays:true}};
 data={ok:true,scope,actorId:7,writable:true,headId:null,history:[],ipr:{current:[],totals:[]},baselines:[{ref,arch:'upper',discrepancyMm:-2,estimated:false}],strategy:null,adjustments:[session]};
 vi.stubGlobal('window',{confirm:vi.fn(()=>true)});
 clients.bootstrap.mockReset().mockImplementation(async()=>{calls.push('metadata');return metadata();});
 clients.verify.mockReset().mockImplementation(async()=>data);
 clients.identity.mockReset().mockResolvedValue(identity);
 clients.submit.mockReset().mockImplementation(async(context)=>{if(!context.current())throw Error('stale');recovery=null;});
 clients.cancel.mockReset().mockImplementation(async(context)=>{if(!context.current())throw Error('stale');recovery=null;});
 fetchMock.mockReset().mockImplementation(async()=>{calls.push('content');return new Response('{}',{status:200,headers:{'cache-control':'private, no-store'}});});
 vi.stubGlobal('fetch',fetchMock);
});
afterEach(()=>{unmount();vi.unstubAllGlobals();});
// Synthetic hook/handler tests. Transport verifiers, routes, browser rendering and
// database authority are deliberately outside this harness; tested separately.
describe('space panel durable-recovery handlers',()=>{
 it('loads metadata before clinical content and writes only after explicit save',async()=>{
  await ready();expect(calls).toEqual(['metadata','content']);expect(clients.submit).not.toHaveBeenCalled();
  editor().save();await flush();expect(clients.submit).toHaveBeenCalledOnce();
  expect(clients.submit.mock.calls[0][1]).toEqual({scope,actorId:7,command:plan()});expect(editor().draft).toBeNull();
 });
 it('latches same-turn duplicate saves',async()=>{await ready();const save=editor().save;save();save();await flush();expect(clients.submit).toHaveBeenCalledOnce();});
 it('freezes a lost-response command and retries exact intent after attempted edits',async()=>{
  await ready();clients.submit.mockRejectedValueOnce(Error('lost reply'));editor().save();await flush();
  const original=clients.submit.mock.calls[0][1];expect(editor().uncertain).toBe(true);
  editor().update({...plan(),reason:'must not replace frozen request'});await click(retryLabel);
  expect(clients.submit).toHaveBeenCalledTimes(2);expect(clients.submit.mock.calls[1][1]).toEqual(original);expect(editor().draft).toBeNull();
 });
 it('cancels uncertain intent using its original command identity',async()=>{
  await ready();clients.submit.mockRejectedValueOnce(Error('lost reply'));editor().save();await flush();await click(cancelLabel);
  expect(clients.identity).toHaveBeenCalledWith(plan());expect(clients.cancel.mock.calls[0][1]).toEqual(identity);expect(editor().draft).toBeNull();
 });
 it('restores pending after remount without an automatic write',async()=>{
  recovery=pending();render();await flush();unmount();render();await flush();expect(clients.submit).not.toHaveBeenCalled();
  await click(retryLabel);expect(clients.submit.mock.calls[0][1]).toEqual({scope,actorId:7,command:plan()});
 });
 it('requires explicit receipt verification for committed recovery; no cancellation',async()=>{
  recovery=pending('committed');render();await flush();expect(clients.submit).not.toHaveBeenCalled();
  expect(elements(render()).some(e=>e.type==='button'&&text(e)===cancelLabel)).toBe(false);
  await click(retryLabel);expect(clients.submit).toHaveBeenCalledOnce();
 });
 it('preserves an unsent draft on recovery conflict and requires confirmed discard',async()=>{
  await ready();recovery=pending();await click(refreshLabel);expect(text(render())).toContain('لم نستبدل');expect(editor().draft).toEqual(plan());
  vi.mocked(window.confirm).mockReturnValueOnce(false);await click('استعادة طلب المسافات بدلاً من المسودة المحلية');expect(text(render())).toContain('لم نستبدل');
  await click('استعادة طلب المسافات بدلاً من المسودة المحلية');expect(text(render())).not.toContain('لم نستبدل');expect(clients.submit).not.toHaveBeenCalled();await click(retryLabel);expect(clients.submit).toHaveBeenCalledOnce();
 });
 for(const state of ['pending','committed'] as const) it(`settles server ${state} B while preserving uncertain local A for later exact retry`,async()=>{
  await ready();clients.submit.mockRejectedValueOnce(Error('A lost reply'));editor().save();await flush();
  const local=clients.submit.mock.calls[0][1];
  const command={...plan(),clientRequestId:'synthetic_server_command_B',reason:'Server B reason'};
  const serverIdentity={id:9,commandId:command.clientRequestId,requestFingerprint:'b'.repeat(64)};
  recovery={state,identity:serverIdentity,expected:{scope,actorId:7,command}};
  await click(refreshLabel);expect(text(render())).toContain('لم نستبدل');expect(text(render())).toContain('Server B reason');
  expect(editor().draft).toEqual(local.command);
  await click('إعادة طلب الخادم والإقرار مع إبقاء الطلب المحلي');
  expect(clients.submit.mock.calls[1][1]).toEqual({scope,actorId:7,command});expect(clients.submit.mock.calls[1][2]).toEqual(serverIdentity);
  expect(editor().draft).toEqual(local.command);expect(editor().uncertain).toBe(true);expect(text(render())).not.toContain('لم نستبدل');
  await click(retryLabel);expect(clients.submit.mock.calls[2][1]).toEqual(local);expect(editor().draft).toBeNull();
 });
 it('cancels server pending B while preserving uncertain local A for exact retry',async()=>{
  await ready();clients.submit.mockRejectedValueOnce(Error('A lost reply'));editor().save();await flush();const local=clients.submit.mock.calls[0][1];
  const command={...plan(),clientRequestId:'synthetic_server_command_B',reason:'Server B reason'};
  const serverIdentity={id:9,commandId:command.clientRequestId,requestFingerprint:'b'.repeat(64)};
  recovery={state:'pending',identity:serverIdentity,expected:{scope,actorId:7,command}};
  await click(refreshLabel);await click('إلغاء طلب الخادم مع إبقاء الطلب المحلي');
  expect(clients.cancel.mock.calls[0][1]).toEqual(serverIdentity);expect(clients.identity).not.toHaveBeenCalled();
  expect(editor().draft).toEqual(local.command);expect(editor().uncertain).toBe(true);
  await click(retryLabel);expect(clients.submit.mock.calls[1][1]).toEqual(local);expect(editor().draft).toBeNull();
 });
 it('allows cancellation of blocked server B while preserving uncertain A',async()=>{
  await ready();clients.submit.mockRejectedValueOnce(Error('A lost reply'));editor().save();await flush();const local=clients.submit.mock.calls[0][1];
  const serverIdentity={id:9,commandId:'synthetic_server_command_B',requestFingerprint:'b'.repeat(64)};
  recovery={state:'blocked',identity:serverIdentity,canCancel:true};await click(refreshLabel);
  await click('إلغاء طلب الخادم مع إبقاء الطلب المحلي');
  expect(clients.cancel.mock.calls[0][1]).toEqual(serverIdentity);expect(editor().draft).toEqual(local.command);
  await click(retryLabel);expect(clients.submit.mock.calls[1][1]).toEqual(local);
 });
 it('acknowledges cancelled server B after lost cancellation reply while preserving A',async()=>{
  await ready();clients.submit.mockRejectedValueOnce(Error('A lost reply'));editor().save();await flush();const local=clients.submit.mock.calls[0][1];
  const command={...plan(),clientRequestId:'synthetic_server_command_B',reason:'Server B reason'};
  const serverIdentity={id:9,commandId:command.clientRequestId,requestFingerprint:'b'.repeat(64)};
  recovery={state:'pending',identity:serverIdentity,expected:{scope,actorId:7,command}};
  await click(refreshLabel);
  clients.cancel.mockImplementationOnce(async()=>{recovery={state:'cancelled',identity:serverIdentity};throw Error('B cancellation committed, acknowledgment lost');});
  await click('إلغاء طلب الخادم مع إبقاء الطلب المحلي');await click(refreshLabel);
  await click('إلغاء طلب الخادم مع إبقاء الطلب المحلي');
  expect(clients.cancel.mock.calls[1][1]).toEqual(serverIdentity);expect(clients.cancel.mock.calls[1][2]).toBe(true);
  expect(editor().draft).toEqual(local.command);await click(retryLabel);expect(clients.submit.mock.calls[1][1]).toEqual(local);
 });
 for(const action of ['save','cancel'] as const) it(`retains unsent D and frozen server B ${action} after lost ack and empty metadata`,async()=>{
  await ready();const local=structuredClone(editor().draft);
  const command={...plan(),clientRequestId:'synthetic_server_command_B',reason:'Server B reason'};
  const serverIdentity={id:9,commandId:command.clientRequestId,requestFingerprint:'b'.repeat(64)};
  recovery={state:'pending',identity:serverIdentity,expected:{scope,actorId:7,command}};
  await click(refreshLabel);
  const client=action==='save'?clients.submit:clients.cancel;
  const label=action==='save'?'إعادة طلب الخادم والإقرار مع إبقاء الطلب المحلي':'إلغاء طلب الخادم مع إبقاء الطلب المحلي';
  client.mockImplementationOnce(async()=>{recovery=null;throw Error('B ack committed, reply lost');});
  await click(label);await click(refreshLabel);
  expect(editor().writable).toBe(false);expect(editor().uncertain).toBe(true);expect(editor().draft).toEqual(local);
  editor().update({...plan(),reason:'must not edit D while B proof missing'});expect(editor().draft).toEqual(local);
  await click(label);
  if(action==='save'){expect(clients.submit.mock.calls[1][1]).toEqual({scope,actorId:7,command});expect(clients.submit.mock.calls[1][2]).toEqual(serverIdentity);}
  else expect(clients.cancel.mock.calls[1][1]).toEqual(serverIdentity);
  expect(editor().draft).toEqual(local);expect(editor().uncertain).toBe(false);expect(editor().writable).toBe(true);
 });
 it('can acknowledge B cancellation after an interrupted B save reconciliation without replacing A',async()=>{
  await ready();clients.submit.mockRejectedValueOnce(Error('A lost reply'));editor().save();await flush();const local=clients.submit.mock.calls[0][1];
  const command={...plan(),clientRequestId:'synthetic_server_command_B',reason:'Server B reason'};
  const serverIdentity={id:9,commandId:command.clientRequestId,requestFingerprint:'b'.repeat(64)};
  recovery={state:'pending',identity:serverIdentity,expected:{scope,actorId:7,command}};await click(refreshLabel);
  clients.submit.mockImplementationOnce(async()=>{recovery={state:'cancelled',identity:serverIdentity};throw Error('B cancelled by another tab');});
  await click('إعادة طلب الخادم والإقرار مع إبقاء الطلب المحلي');await click(refreshLabel);
  await click('إلغاء طلب الخادم مع إبقاء الطلب المحلي');expect(clients.cancel.mock.calls[0][1]).toEqual(serverIdentity);expect(clients.cancel.mock.calls[0][2]).toBe(true);
  expect(editor().draft).toEqual(local.command);await click(retryLabel);expect(clients.submit.mock.calls[2][1]).toEqual(local);
 });
 it('verifies committed B after interrupted cancellation of B while retaining local A',async()=>{
  await ready();clients.submit.mockRejectedValueOnce(Error('A lost reply'));editor().save();await flush();const local=clients.submit.mock.calls[0][1];
  const command={...plan(),clientRequestId:'synthetic_server_command_B',reason:'Server B reason'};
  const serverIdentity={id:9,commandId:command.clientRequestId,requestFingerprint:'b'.repeat(64)};
  recovery={state:'pending',identity:serverIdentity,expected:{scope,actorId:7,command}};await click(refreshLabel);
  clients.cancel.mockImplementationOnce(async()=>{recovery={state:'committed',identity:serverIdentity,expected:{scope,actorId:7,command}};throw Error('B committed by another tab');});
  await click('إلغاء طلب الخادم مع إبقاء الطلب المحلي');await click(refreshLabel);
  await click('إعادة طلب الخادم والإقرار مع إبقاء الطلب المحلي');expect(clients.submit.mock.calls[1][1]).toEqual({scope,actorId:7,command});expect(clients.submit.mock.calls[1][2]).toEqual(serverIdentity);
  expect(editor().draft).toEqual(local.command);await click(retryLabel);expect(clients.submit.mock.calls[2][1]).toEqual(local);
 });
 it('reconciles cancellation of B despite unrelated committed C metadata while retaining unsent D',async()=>{
  await ready();const local=structuredClone(editor().draft);
  const command={...plan(),clientRequestId:'synthetic_server_command_B',reason:'Server B reason'};
  const serverIdentity={id:9,commandId:command.clientRequestId,requestFingerprint:'b'.repeat(64)};
  recovery={state:'pending',identity:serverIdentity,expected:{scope,actorId:7,command}};await click(refreshLabel);
  clients.cancel.mockImplementationOnce(async()=>{recovery=null;throw Error('B acknowledged, reply lost');});
  await click('إلغاء طلب الخادم مع إبقاء الطلب المحلي');
  const third={...plan(),clientRequestId:'synthetic_server_command_C',reason:'Server C reason'};
  recovery={state:'committed',identity:{id:10,commandId:third.clientRequestId,requestFingerprint:'c'.repeat(64)},expected:{scope,actorId:7,command:third}};
  await click(refreshLabel);clients.cancel.mockImplementationOnce(async(context)=>{if(!context.current())throw Error('stale');});
  await click('إلغاء طلب الخادم مع إبقاء الطلب المحلي');expect(clients.cancel).toHaveBeenCalledTimes(2);expect(clients.cancel.mock.calls[1][1]).toEqual(serverIdentity);
  expect(editor().draft).toEqual(local);expect(text(render())).toContain('Server C reason');expect(editor().writable).toBe(false);
 });
 it('does not replace A when verification of server B fails and retries B explicitly',async()=>{
  await ready();clients.submit.mockRejectedValueOnce(Error('A lost reply'));editor().save();await flush();const local=clients.submit.mock.calls[0][1];
  const command={...plan(),clientRequestId:'synthetic_server_command_B',reason:'Server B reason'};
  const serverIdentity={id:9,commandId:command.clientRequestId,requestFingerprint:'b'.repeat(64)};
  recovery={state:'committed',identity:serverIdentity,expected:{scope,actorId:7,command}};
  await click(refreshLabel);clients.submit.mockRejectedValueOnce(Error('B acknowledgment lost'));
  await click('إعادة طلب الخادم والإقرار مع إبقاء الطلب المحلي');expect(editor().draft).toEqual(local.command);expect(editor().uncertain).toBe(true);
  await click('إعادة طلب الخادم والإقرار مع إبقاء الطلب المحلي');expect(clients.submit.mock.calls[2][1]).toEqual({scope,actorId:7,command});
  expect(editor().draft).toEqual(local.command);await click(retryLabel);expect(clients.submit.mock.calls[3][1]).toEqual(local);
 });
 it('permits metadata-only cancellation when source content is forbidden',async()=>{
  recovery={state:'blocked',identity,canCancel:true};fetchMock.mockImplementation(async()=>new Response('{}',{status:403,headers:{'cache-control':'private, no-store'}}));render();await flush();
  expect(text(render())).toContain('طلب الاستعادة محجوب');await click(cancelLabel);expect(clients.cancel).toHaveBeenCalledOnce();expect(clients.submit).not.toHaveBeenCalled();
 });
 it('acknowledges already cancelled recovery without requesting cancellation again',async()=>{
  recovery={state:'cancelled',identity};render();await flush();await click(cancelLabel);expect(clients.cancel.mock.calls[0][2]).toBe(true);
 });
 it('refuses a foreign actor metadata response before loading content',async()=>{
  clients.bootstrap.mockResolvedValue({...metadata(),actorId:99});render();await flush();expect(fetchMock).not.toHaveBeenCalled();expect(clients.submit).not.toHaveBeenCalled();
 });
 it('does not acknowledge or clear a late save result after unmount',async()=>{
  await ready();let release!:()=>void;let currentAfter=false;
  clients.submit.mockImplementation(async(context)=>{await new Promise<void>(resolve=>{release=resolve;});currentAfter=context.current();if(!currentAfter)throw Error('stale');});
  editor().save();unmount();release();await new Promise(resolve=>setTimeout(resolve,0));expect(currentAfter).toBe(false);
  render();await flush();expect(editor().draft).toBeNull();expect(clients.submit).toHaveBeenCalledOnce();
 });
 it('retires in-flight authority on session change without acknowledging the old save',async()=>{
  await ready();let release!:()=>void;let stillCurrent=true;
  clients.submit.mockImplementation(async(context)=>{await new Promise<void>(resolve=>{release=resolve;});stillCurrent=context.current();if(!stillCurrent)throw Error('stale session');});
  editor().save();hooks.session={userId:99,username:'different-doctor',role:'doctor',permissions:{canUploadXrays:true}};render();release();await flush();
  expect(stillCurrent).toBe(false);expect(clients.submit).toHaveBeenCalledOnce();expect(elements(render()).some(e=>e.type===OrthoSpaceLedger)).toBe(false);
 });
 it('does not restore an unsent local draft after full remount',async()=>{await ready();unmount();render();await flush();expect(editor().draft).toBeNull();expect(clients.submit).not.toHaveBeenCalled();});
});

// The real presentation is called directly; Amount is a hook-free child. These
// assertions concern handlers and values, not layout, focus, or browser behavior.
function presentation(props:ComponentProps<typeof OrthoSpaceLedger>){
 const root=OrthoSpaceLedger(props);
 const expanded=(node:ReactNode):Element[]=>{
  if(Array.isArray(node))return node.flatMap(expanded);
  if(!node||typeof node!=='object'||!('props'in node))return[];
  const e=node as Element;
  if(typeof e.type==='function')return expanded((e.type as(props:Record<string,unknown>)=>ReactNode)(e.props));
  return[e,...expanded(e.props.children as ReactNode)];
 };return expanded(root);
}
describe('space documentary editor handlers',()=>{
 let draft:SpaceEditorCommand;const update=vi.fn((next:SpaceEditorCommand)=>{draft=next;});
 const props=()=>({data,draft,writable:true,busy:false,uncertain:false,update,discard:vi.fn(),save:vi.fn()});
 function field(label:string){const e=presentation(props()).find(e=>e.props['aria-label']===label);if(!e)throw Error(`Missing ${label}`);return e;}
 function change(label:string,value:string){(field(label).props.onChange as(e:unknown)=>void)({target:{value}});}
 beforeEach(()=>{draft=plan();update.mockClear();});
 it('preserves unknown and explicit zero as distinct contact amounts',()=>{
  const label='IPR المخطط للتماس 1 (mm)';expect(field(label).props.value).toBe('');change(label,'0');expect(draft.content.kind==='plan'&&draft.content.contacts[0].plannedUm).toBe(0);expect(field(label).props.value).toBe(0);
  change(label,'');expect(draft.content.kind==='plan'&&draft.content.contacts[0].plannedUm).toBeNull();
 });
 it('pins selected performed-session witness and does not refresh it on unrelated edits',()=>{
  draft={schemaVersion:2,clientRequestId:'synthetic_space_command_2',expectedHeadId:null,reason:'Synthetic IPR',expectedSession:null,content:{kind:'ipr',arch:'upper',planEntryId:13,teeth:[11,12],adjustmentId:0,performedUm:null,measurementNote:'Synthetic evidence',supersedesEntryId:null,reviewReason:null}};
  change('جلسة التقويم الفعلية',String(session.id));expect(draft.expectedSession).toEqual({visitId:session.visitId,occurredOn:session.occurredOn,recordedBy:session.recordedBy});
  data={...data,adjustments:[{...session,occurredOn:'2026-09-02',recordedBy:'Changed clinician'}]};
  change('مقدار IPR المنفذ في هذه الجلسة (mm)','0.1');expect(draft.expectedSession).toEqual({visitId:session.visitId,occurredOn:session.occurredOn,recordedBy:session.recordedBy});
 });
 it('exposes only existing performed sessions rather than bookings',()=>{
  draft={schemaVersion:2,clientRequestId:'synthetic_space_command_2',expectedHeadId:null,reason:'Synthetic IPR',expectedSession:null,content:{kind:'ipr',arch:'upper',planEntryId:13,teeth:[11,12],adjustmentId:0,performedUm:null,measurementNote:'Synthetic evidence',supersedesEntryId:null,reviewReason:null}};
  const options=elements(field('جلسة التقويم الفعلية')).filter(e=>e.type==='option');expect(options.map(e=>e.props.value)).toEqual([0,session.id]);expect(text(options[1])).toContain(`زيارة #${session.visitId}`);
 });
});
