import {type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const hooks=vi.hoisted(()=>({values:[] as unknown[],cursor:0,changed:false,effects:new Map<number,{deps?:readonly unknown[],cleanup?:()=>void}>(),pending:[] as Array<()=>void>}));
vi.mock('react',async original=>{const react=await original<typeof import('react')>();return {...react,
 useId:()=> 'synthetic-reconciliation',
 useState:(initial:unknown)=>{const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]=initial;return[hooks.values[i],(v:unknown)=>{const next=typeof v==='function'?v(hooks.values[i]):v;if(!Object.is(next,hooks.values[i]))hooks.changed=true;hooks.values[i]=next;}];},
 useRef:(initial:unknown)=>{const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]={current:initial};return hooks.values[i];},
 useCallback:(fn:unknown,deps:readonly unknown[])=>{const i=hooks.cursor++;const old=hooks.values[i] as {fn:unknown,deps:readonly unknown[]}|undefined;if(!old||old.deps.length!==deps.length||old.deps.some((d,j)=>!Object.is(d,deps[j])))hooks.values[i]={fn,deps};return (hooks.values[i] as {fn:unknown}).fn;},
 useEffect:(effect:()=>void|(()=>void),deps?:readonly unknown[])=>{const i=hooks.cursor++;const old=hooks.effects.get(i);if(old?.deps&&deps&&old.deps.length===deps.length&&old.deps.every((d,j)=>Object.is(d,deps[j])))return;hooks.pending.push(()=>{old?.cleanup?.();const cleanup=effect();hooks.effects.set(i,{deps,cleanup:typeof cleanup==='function'?cleanup:undefined});});}
};});
const mocks=vi.hoisted(()=>({read:vi.fn(),reserve:vi.fn(),ack:vi.fn(),session:{username:'synthetic-admin',role:'admin'}}));
vi.mock('../components/SessionProvider',()=>({useSession:()=>mocks.session}));
vi.mock('../components/useDurableMoneyAttempt',()=>({MONEY_JOURNAL_EVENT:'synthetic-journal'}));
vi.mock('../lib/financial-command-journal',()=>({readFinancialJournal:mocks.read,reserveFinancialCommand:mocks.reserve,acknowledgeFinancialCommand:mocks.ack}));
import {AgreementReconciliationPanel} from '../components/AgreementReconciliationPanel';
import {reconciliationCommand,reconciliationRequestHash,type ReconciliationDraft} from '../lib/agreement-reconciliation-view';
import type {FinancialJournal,FinancialCommand} from '../lib/financial-command-journal';
const onChanged=vi.fn(async()=>{}),fetcher=vi.fn();
let journal:FinancialJournal;
const view=()=>({status:'preview',patientId:71,planId:82,currency:'SAR',sourceHash:'a'.repeat(64),amounts:{agreedMinor:250000,billedPrincipalMinor:30000,unbilledPrincipalMinor:220000,paidMinor:30000,remainingMinor:220000,dueNowMinor:15000},sourceInvoices:[{invoiceId:1,invoiceNumber:"SYN-1",principalMinor:30000,settledMinor:30000,remainingMinor:0}],blockers:[],reconciliation:null,commission:{doctorId:8,doctorName:'Synthetic doctor',percent:30,incrementalAccruedMinor:66000},canConfirm:true});
const response=(data:unknown,status=200)=>({status,ok:status>=200&&status<300,redirected:false,json:async()=>data}) as Response;
type Element=ReactElement<Record<string,unknown>>;
function nodes(node:ReactNode):Element[]{if(Array.isArray(node))return node.flatMap(nodes);if(!node||typeof node!=='object'||!('props'in node))return[];const e=node as Element;return[e,...nodes(e.props.children as ReactNode)];}
function render(){let element:ReactElement|null=null;for(let i=0;i<20;i++){hooks.changed=false;hooks.cursor=0;const outer=AgreementReconciliationPanel({patientId:71,planId:82,onChanged});element=outer?(outer.type as (p:unknown)=>ReactElement)(outer.props):null;const effects=hooks.pending.splice(0);effects.forEach(f=>f());if(!hooks.changed)break;}return {nodes:nodes(element),html:renderToStaticMarkup(element)};}
async function settle(){for(let i=0;i<15;i++){await new Promise<void>(resolve=>setImmediate(resolve));render();}return render();}
function button(label:string){return render().nodes.find(n=>n.type==='button'&&n.props.children===label)!;}
function click(label:string){const b=button(label);expect(b).toBeTruthy();expect(b.props.disabled).not.toBe(true);(b.props.onClick as ()=>void)();render();}
async function open(){await settle();click('تسوية الاتفاق');return settle();}
const pendingDraft=():ReconciliationDraft=>JSON.parse(journal.command!.original) as ReconciliationDraft;
const receipt=(d:ReconciliationDraft)=>({id:4,patientId:71,planId:82,operationKey:d.body.operationKey,expectedSourceHash:d.body.expectedSourceHash,deltaInvoiceId:5,amounts:view().amounts,cashMovementMinor:0});
beforeEach(()=>{hooks.values=[];hooks.cursor=0;hooks.changed=false;hooks.effects.clear();hooks.pending=[];journal={revision:0,command:null};mocks.session={username:'synthetic-admin',role:'admin'};mocks.read.mockReset().mockImplementation(async()=>({...journal}));mocks.reserve.mockReset().mockImplementation(async(_s:unknown,_r:number,c:FinancialCommand)=>{if(!journal.command)journal={...journal,command:c};return {...journal};});mocks.ack.mockReset().mockImplementation(async()=>{journal={revision:journal.revision+1,command:null};return journal;});onChanged.mockClear();fetcher.mockReset().mockImplementation(async()=>response(view()));vi.stubGlobal('fetch',fetcher);vi.stubGlobal('window',new EventTarget());});
afterEach(()=>{hooks.effects.forEach(e=>e.cleanup?.());vi.unstubAllGlobals();});
describe('تسوية الاتفاق interactive recovery (synthetic, not browser proof)',()=>{
 it('uses exact requested label and does not request preview before opening',async()=>{await settle();expect(button('تسوية الاتفاق')).toBeTruthy();expect(fetcher).not.toHaveBeenCalled();const p=await open();expect(p.html).toContain('المبلغ الذي سيُضاف للفوترة');expect(p.html).not.toContain('تسوية الاتفاق القديم');});
 it('does not render the action for nonadmin',()=>{mocks.session.role='reception';expect(render().nodes).toEqual([]);});
 it('rejects wrong patient preview without enabling submit',async()=>{fetcher.mockResolvedValue(response({...view(),patientId:72}));await open();expect(button('تأكيد التسوية').props.disabled).toBe(true);expect(mocks.reserve).not.toHaveBeenCalled();});
 it.each(['collection','invoice-maintenance'] as const)('retains a pending %s command and blocks new reconciliation',async kind=>{journal.command={kind,key:'synthetic-other-key',original:'{}',payload:'{}'};await open();expect(button('تأكيد التسوية').props.disabled).toBe(true);expect(mocks.ack).not.toHaveBeenCalled();});
 it('does not send POST if durable reservation fails',async()=>{await open();mocks.reserve.mockRejectedValueOnce(new Error('storage'));click('تأكيد التسوية');await settle();expect(fetcher.mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(0);});
 it('keeps exact request and key after lost reply and on retry',async()=>{await open();fetcher.mockRejectedValueOnce(new Error('lost reply'));click('تأكيد التسوية');await settle();const first=fetcher.mock.calls.find(([,i])=>i?.method==='POST')![1].body;expect(journal.command).not.toBeNull();fetcher.mockRejectedValueOnce(new Error('still offline'));click('إعادة الطلب المحفوظ نفسه');await settle();const posts=fetcher.mock.calls.filter(([,i])=>i?.method==='POST');expect(posts).toHaveLength(2);expect(posts[1][1].body).toBe(first);expect(mocks.ack).not.toHaveBeenCalled();});
 it.each([403,409,500])('does not retire command from bare %s',async status=>{await open();fetcher.mockResolvedValueOnce(response({code:'agreement_source_changed'},status));click('تأكيد التسوية');await settle();expect(journal.command).not.toBeNull();expect(mocks.ack).not.toHaveBeenCalled();expect(button('تحقق من حالة الطلب')).toBeTruthy();});
 it('acknowledges matching receipt even when optional refreshed view is null',async()=>{await open();fetcher.mockImplementationOnce(async(_u,init)=>{const body=JSON.parse(init.body);return response({status:'reconciled',replayed:false,reconciliation:receipt({actor:'synthetic-admin',patientId:71,planId:82,body}),view:null},201);});click('تأكيد التسوية');const p=await settle();expect(journal.command).toBeNull();expect(onChanged).toHaveBeenCalledTimes(1);expect(p.html).toContain('التسوية #4');});
 it('keeps command when success receipt has another key',async()=>{await open();fetcher.mockImplementationOnce(async(_u,init)=>response({status:'reconciled',reconciliation:{...receipt({actor:'synthetic-admin',patientId:71,planId:82,body:JSON.parse(init.body)}),operationKey:'another-key'}}));click('تأكيد التسوية');await settle();expect(journal.command).not.toBeNull();expect(onChanged).not.toHaveBeenCalled();});

 it('does not apply a prior rejection proof to a new uncertain command adopted from another tab',async()=>{
  await open();fetcher.mockResolvedValueOnce(response({code:'agreement_source_changed'},409));click('تأكيد التسوية');await settle();
  const first=pendingDraft();const proof={state:'rejected',code:'agreement_source_changed',planId:82,patientId:71,operationKey:first.body.operationKey,expectedSourceHash:first.body.expectedSourceHash,observedSourceHash:'b'.repeat(64),rejectedAt:'2026-10-26T00:00:00Z',requestHash:await reconciliationRequestHash(first)};
  fetcher.mockResolvedValueOnce(response(proof));click('تحقق من حالة الطلب');await settle();expect(button('تحديث المعاينة بعد الرفض المثبت')).toBeTruthy();
  const second={...first,body:{...first.body,operationKey:'synthetic-new-uncertain',expectedSourceHash:'b'.repeat(64)}};
  journal={revision:1,command:reconciliationCommand(second)};window.dispatchEvent(new Event('focus'));await settle();
  expect(button('تحديث المعاينة بعد الرفض المثبت')).toBeUndefined();expect(button('تحقق من حالة الطلب')).toBeTruthy();expect(mocks.ack).not.toHaveBeenCalled();expect(pendingDraft()).toEqual(second);
 });
 it('releases stale command only after exact permanent rejection proof',async()=>{await open();fetcher.mockResolvedValueOnce(response({code:'agreement_source_changed'},409));click('تأكيد التسوية');await settle();const d=pendingDraft();const proof={state:'rejected',code:'agreement_source_changed',planId:82,patientId:71,operationKey:d.body.operationKey,expectedSourceHash:d.body.expectedSourceHash,observedSourceHash:'b'.repeat(64),rejectedAt:'2026-10-26T00:00:00Z',requestHash:await reconciliationRequestHash(d)};fetcher.mockResolvedValueOnce(response(proof));click('تحقق من حالة الطلب');await settle();expect(journal.command).not.toBeNull();click('تحديث المعاينة بعد الرفض المثبت');await settle();expect(journal.command).toBeNull();expect(mocks.ack).toHaveBeenCalledTimes(1);expect(onChanged).not.toHaveBeenCalled();});
});
