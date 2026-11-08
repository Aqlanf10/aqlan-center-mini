import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoProblemSourcesPanel } from "../components/PatientOrtho";
import { canonicalJourneyJSON } from "../lib/ortho-case-journey-json";

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

type Props = ComponentProps<typeof OrthoProblemSourcesPanel>;
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
const patientId = 92001;
const fetchMock = vi.fn();
const candidate = { identity: 'clinical_diagnosis:skeletal', ref: {kind:'clinical_diagnosis', id:1, member:'skeletal', version:`sha256:${'a'.repeat(64)}`}, category:'تشخيص', title:'مصدر اصطناعي', summary:'وصف محفوظ اصطناعي', proposedLabel:'مشكلة اصطناعية', site:null, target:{kind:'case'}, snapshot:{text:'synthetic'}, sourceActor:'synthetic-doctor', sourceDate:'2026-11-05', available:true, requiresImages:false };
let view: Record<string, unknown>;
let failNextWrite: boolean;
let recovery: unknown = null;
const scope = {patientId,orthoCaseId:base.id,clinicalCaseId:3};
const response = (status: number, value: unknown) => new Response(JSON.stringify(value), {status,headers:{"cache-control":"private, no-store","content-type":"application/json"}});
function render() { hooks.cursor=0; return OrthoProblemSourcesPanel({patientId,row:base,visible:true}); }
function elements(node: ReactNode): Element[] {
 if (Array.isArray(node)) return node.flatMap(elements);
 if (!node || typeof node !== 'object' || !('props' in node)) return [];
 const element=node as Element; return [element,...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string { if (typeof node==='string' || typeof node==='number') return String(node); if(Array.isArray(node))return node.map(text).join(''); if(node && typeof node==='object' && 'props' in node)return text((node as Element).props.children as ReactNode); return ''; }
function button(label: string) { const result=elements(render()).find(e=>e.type==='button' && text(e)===label); if(!result)throw Error(`Missing ${label}`); return result; }
function change(label: string, value: string) { const input=elements(render()).find(e=>e.props['aria-label']===label); if(!input)throw Error(`Missing ${label}`); (input.props.onChange as (e:unknown)=>void)({target:{value}}); }
function reason(value: string) { const label=elements(render()).find(e=>e.type==='label' && text(e).startsWith('سبب مراجعة')); if(!label)throw Error('Missing reason'); const field=elements(label).find(e=>e.type==='textarea')!; (field.props.onChange as (e:unknown)=>void)({target:{value}}); }
function confirm() { const field=elements(render()).find(e=>e.type==='input' && e.props.type==='checkbox')!; (field.props.onChange as (e:unknown)=>void)({target:{checked:true}}); }
async function flush() { for(let i=0;i<20;i++) await new Promise(resolve=>setTimeout(resolve,0)); render(); }
async function click(label:string) { const b=button(label); expect(b.props.disabled).not.toBe(true); (b.props.onClick as ()=>void)(); await flush(); }
async function ready() {render(); await flush(); change('مصدر المشكلة',candidate.identity); reason('راجع الطبيب المصدر الاصطناعي'); confirm();}
const writes=()=>fetchMock.mock.calls.filter(call=>call[1]?.method==='POST' && !String(call[0]).includes('/recovery'));
function unmount(){for(const effect of hooks.effects.values())effect.cleanup?.();hooks.effects.clear();hooks.memos.clear();hooks.values=[];hooks.cursor=0;}
beforeEach(()=>{
 unmount(); vi.clearAllMocks(); failNextWrite=false; recovery=null; vi.stubGlobal("window",{confirm:vi.fn(()=>true)});
 hooks.session={userId:7,username:'synthetic-doctor',role:'doctor',permissions:{canUploadXrays:true}};
 view={ok:true,patientId,orthoCaseId:base.id,clinicalCaseId:3,writable:true,candidates:[structuredClone(candidate)],problems:[],reviews:[]};
 fetchMock.mockReset().mockImplementation(async (_url:string,init?:RequestInit)=>{
  if(_url.includes('/recovery')) {
   if(init?.method!=='POST')return response(200,{ok:true,actorId:7,scope,recovery});
   const body=JSON.parse(String(init.body));
   if(body.action==='cancel')recovery={state:'cancelled',identity:{id:8,commandId:body.commandId,requestFingerprint:body.requestFingerprint}};
   const state=(recovery as any)?.state==='cancelled'?'cancelled':'committed';
   const result=response(200,{ok:true,actorId:7,scope,identity:{id:8,commandId:body.commandId,requestFingerprint:body.requestFingerprint},state,acknowledged:body.action==='acknowledge'});
   if(body.action==='acknowledge')recovery=null;
   return result;
  }
  if(init?.method!=='POST')return response(200,view);
  if(failNextWrite){failNextWrite=false;throw Error('synthetic lost response');}
  const command=JSON.parse(String(init.body)).command;
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJourneyJSON(command))))].map(n=>n.toString(16).padStart(2,'0')).join('');
  return response(201,{ok:true,patientId,orthoCaseId:base.id,clinicalCaseId:3,actorId:7,commandId:command.commandId,requestFingerprint:hash,reviewId:1,problemId:4,sourceIdentity:candidate.identity,sourceVersion:command.source.version,replayed:false});
 }); vi.stubGlobal('fetch',fetchMock);
});
afterEach(()=>{unmount();vi.unstubAllGlobals();});
// Actual component handlers with a deterministic hook lifecycle, not browser E2E.
describe('problem-source mounted handlers',()=>{
 it('saves with the real userId-only session shape and acknowledges verified receipt',async()=>{
  await ready(); await click('حفظ المشكلة ومراجعة مصدرها'); expect(writes()).toHaveLength(1);
  expect(JSON.parse(String(writes()[0][1].body))).toMatchObject({patientId,command:{source:candidate.ref,clinicianReviewed:true,action:'create'}});
  expect(text(render())).not.toContain('لم تتأكد نتيجة الحفظ');
  expect(elements(render()).find(e=>e.props['aria-label']==='مصدر المشكلة')?.props.value).toBe('');
 });
 it('disables save when refresh makes the same source version unavailable',async()=>{
  await ready(); view={...view,candidates:[{...candidate,available:false}]}; await click('تحديث مصادر المشاكل'); await flush();
  expect(button('حفظ المشكلة ومراجعة مصدرها').props.disabled).toBe(true); expect(text(render())).toContain('لم يعد متاحاً'); expect(writes()).toHaveLength(0);
 });
 it('freezes uncertain command and retries exactly the original content and identity',async()=>{
  await ready(); failNextWrite=true; await click('حفظ المشكلة ومراجعة مصدرها'); expect(writes()).toHaveLength(1);
  const original=writes()[0][1].body; reason('must not replace uncertain intent'); await click('التحقق بإعادة نفس طلب المشكلة');
  expect(writes()).toHaveLength(2); expect(writes()[1][1].body).toBe(original); expect(text(render())).not.toContain('لم تتأكد نتيجة الحفظ');
 });
 it('latches same-turn duplicate save handlers',async()=>{
  await ready(); const save=button('حفظ المشكلة ومراجعة مصدرها').props.onClick as ()=>void; save(); save(); await flush(); expect(writes()).toHaveLength(1);
 });
 it('requires explicit re-selection and confirmation after source version changes',async()=>{
  await ready(); view={...view,candidates:[{...candidate,ref:{...candidate.ref,version:`sha256:${'b'.repeat(64)}`}}]};
  await click('تحديث مصادر المشاكل'); await flush(); expect(button('حفظ المشكلة ومراجعة مصدرها').props.disabled).toBe(true);
  await click('اختيار النسخة الحالية للمراجعة'); expect(button('حفظ المشكلة ومراجعة مصدرها').props.disabled).toBe(true);
  confirm(); await click('حفظ المشكلة ومراجعة مصدرها'); expect(JSON.parse(String(writes()[0][1].body)).command.source.version).toBe(`sha256:${'b'.repeat(64)}`);
 });
 it('does not acknowledge a receipt for a foreign actor',async()=>{
  await ready(); fetchMock.mockResolvedValueOnce(response(201,{ok:true,patientId,orthoCaseId:base.id,clinicalCaseId:3,actorId:99,replayed:false}));
  await click('حفظ المشكلة ومراجعة مصدرها'); expect(text(render())).toContain('لم تتأكد نتيجة الحفظ');
  expect(elements(render()).find(e=>e.props['aria-label']==='مصدر المشكلة')?.props.value).toBe(candidate.identity);
  await click('التحقق بإعادة نفس طلب المشكلة'); expect(writes()[1][1].body).toBe(writes()[0][1].body);
 });

});

async function serverPending(state: 'pending'|'committed' = 'pending') {
 const command={schemaVersion:1,commandId:'synthetic_recovered_command',source:candidate.ref,expectedReviewId:null,action:'create',problemId:null,label:'Recovered synthetic problem',reason:'Synthetic recovered reason',clinicianReviewed:true};
 const requestFingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJourneyJSON(command))))].map(n=>n.toString(16).padStart(2,'0')).join('');
 return {state,identity:{id:8,commandId:command.commandId,requestFingerprint},expected:{scope,actorId:7,command}};
}
describe('durable problem recovery mounted handlers',()=>{
 it('restores server pending without automatically writing and retries exact command',async()=>{
  recovery=await serverPending(); render(); await flush(); expect(writes()).toHaveLength(0);
  const command=(recovery as any).expected.command;
  await click('التحقق بإعادة نفس طلب المشكلة'); expect(JSON.parse(String(writes()[0][1].body))).toEqual({patientId,clinicalCaseId:3,actorId:7,command});
 });
 it('recovers committed command after remount without auto resubmitting',async()=>{
  recovery=await serverPending('committed'); render(); await flush(); unmount(); render(); await flush(); expect(writes()).toHaveLength(0);
  expect(button('التحقق بإعادة نفس طلب المشكلة').props.disabled).toBe(false);
  expect(button('إلغاء الطلب غير المحفوظ وتأكيد النتيجة').props.disabled).toBe(true);
 });
 it('requires confirmed discard of unsent local draft before adopting other-tab recovery',async()=>{
  await ready(); recovery=await serverPending(); await click('تحديث مصادر المشاكل'); await flush();
  expect(text(render())).toContain('لم تُستبدل مسودتك'); expect(writes()).toHaveLength(0);
  vi.mocked(window.confirm).mockReturnValueOnce(false); await click('تجاهل المسودة المحلية واستعادة طلب الخادم'); expect(text(render())).toContain('لم تُستبدل مسودتك');
  await click('تجاهل المسودة المحلية واستعادة طلب الخادم'); expect(text(render())).not.toContain('لم تُستبدل مسودتك'); expect(writes()).toHaveLength(0);
  await click('التحقق بإعادة نفس طلب المشكلة'); expect(JSON.parse(String(writes()[0][1].body)).command.commandId).toBe('synthetic_recovered_command');
 });
 it('does not overwrite uncertain local command with a different server command',async()=>{
  await ready(); failNextWrite=true; await click('حفظ المشكلة ومراجعة مصدرها'); const original=writes()[0][1].body;
  recovery=await serverPending(); await click('تحديث مصادر المشاكل'); await flush();
  expect(button('التحقق بإعادة نفس طلب المشكلة').props.disabled).toBe(true);
  expect(text(render())).not.toContain('تجاهل المسودة المحلية واستعادة طلب الخادم'); expect(writes()[0][1].body).toBe(original);
 });
 it('can cancel pending from metadata when ordinary source read returns403',async()=>{
  recovery=await serverPending(); const handler=fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url,init)=>String(url).includes('/recovery')?handler(url,init):response(403,{ok:false}));
  render(); await flush(); expect(text(render())).toContain('تعذّرت قراءة مصادر');
  await click('إلغاء الطلب غير المحفوظ وتأكيد النتيجة'); expect(writes()).toHaveLength(0);
  expect(fetchMock.mock.calls.filter(c=>c[1]?.method==='POST').map(c=>JSON.parse(String(c[1].body)).action)).toEqual(['cancel','acknowledge']);
 });
 it('supports metadata-only blocked pending cancellation without clinical command',async()=>{
  const pending=await serverPending(); recovery={state:'blocked',identity:pending.identity,canCancel:true}; render(); await flush();
  await click('إلغاء الطلب غير المحفوظ وتأكيد النتيجة'); expect(writes()).toHaveLength(0);
 });
 it('acknowledges cancelled recovery without repeating cancellation',async()=>{
  const pending=await serverPending(); recovery={state:'cancelled',identity:pending.identity}; render(); await flush();
  await click('إلغاء الطلب غير المحفوظ وتأكيد النتيجة'); expect(fetchMock.mock.calls.filter(c=>c[1]?.method==='POST').map(c=>JSON.parse(String(c[1].body)).action)).toEqual(['acknowledge']);
 });
 it('does not restore drafts which were never sent after remount',async()=>{
  await ready(); unmount(); render(); await flush(); expect(elements(render()).find(e=>e.props['aria-label']==='مصدر المشكلة')?.props.value).toBe(''); expect(writes()).toHaveLength(0);
 });
 it('refuses foreign actor recovery before loading sources',async()=>{
  fetchMock.mockResolvedValue(response(200,{ok:true,actorId:99,scope,recovery:null})); render(); await flush(); expect(fetchMock).toHaveBeenCalledOnce(); expect(writes()).toHaveLength(0);
 });
 it('cancels uncertain command absent from server using its original fingerprint',async()=>{
  await ready(); failNextWrite=true; await click('حفظ المشكلة ومراجعة مصدرها'); const command=JSON.parse(String(writes()[0][1].body)).command;
  await click('إلغاء الطلب غير المحفوظ وتأكيد النتيجة'); const transitions=fetchMock.mock.calls.filter(c=>c[1]?.method==='POST'&&String(c[0]).includes('/recovery'));
  expect(JSON.parse(String(transitions[0][1].body))).toMatchObject({action:'cancel',commandId:command.commandId}); expect(transitions).toHaveLength(2);
 });
});

describe('problem write-source permission quarantine',()=>{
 it('keeps exact pending cancellable after write403 and fresh metadata blocked recovery',async()=>{
  await ready(); const handler=fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url,init)=>{
   if(init?.method==='POST'&&!String(url).includes('/recovery')) {
    const command=JSON.parse(String(init.body)).command;
    const {problemSubmissionHash}=await import('../lib/ortho-problem-submission-contract');
    recovery={state:'blocked',identity:{id:8,commandId:command.commandId,requestFingerprint:await problemSubmissionHash(command)},canCancel:true};
    return response(403,{ok:false,code:'clinical_image_access_denied'});
   }
   if(init?.method!=='POST'&&!String(url).includes('/recovery'))return response(403,{ok:false});
   return handler(url,init);
  });
  await click('حفظ المشكلة ومراجعة مصدرها'); await flush();
  expect(text(render())).not.toContain('وصف محفوظ اصطناعي');
  expect(button('التحقق بإعادة نفس طلب المشكلة').props.disabled).toBe(true);
  await click('إلغاء الطلب غير المحفوظ وتأكيد النتيجة');
  expect(fetchMock.mock.calls.filter(c=>c[1]?.method==='POST'&&String(c[0]).includes('/recovery')).map(c=>JSON.parse(String(c[1].body)).action)).toEqual(['cancel','acknowledge']);
 });
});
