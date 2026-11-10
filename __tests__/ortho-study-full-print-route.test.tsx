import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { syntheticStudyCommand } from './fixtures/ortho-case-study';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
const state=vi.hoisted(()=>({session:{userId:7,username:'SYNTHETIC',role:'doctor',expiresAt:Date.now()+100000} as Record<string,unknown>|null,read:vi.fn(),audit:vi.fn()}));
vi.mock('../lib/session',()=>({requireSession:async()=>state.session}));
vi.mock('../lib/db',()=>({getSettingsSafe:async()=>({}),recordAudit:state.audit}));
vi.mock('../lib/ortho-case-study-store',()=>({getOrthoCaseStudy:state.read}));
vi.mock('../lib/ortho-study-image-store',()=>({getStudyImagePreview:vi.fn()}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('not_found');}}));
import Page,{dynamic} from '../app/print/ortho-study/[id]/page';
import FullPrint from '../components/OrthoFullStudyPrint';
import LegacyPrint from '../components/OrthoIllustratedStudyPrint';
const query=(mode?:string|string[])=>({patientId:'19',revisionId:'91',...(mode===undefined?{}:{mode})});
const input=(searchParams:Record<string,string|string[]|undefined>=query())=>({params:Promise.resolve({id:'41'}),searchParams:Promise.resolve(searchParams)});
beforeEach(()=>{
 state.session={userId:7,username:'SYNTHETIC',role:'doctor',expiresAt:Date.now()+100000};state.read.mockReset();state.audit.mockReset();
 const authored=syntheticStudyCommand().content;authored.comment='SYNTHETIC_SAVED_MARKER <script>';
 const content={schemaVersion:1,capturedAt:'2026-11-05T00:00:00.000Z',recordedPatientId:19,orthoCaseId:41,clinicalCaseId:51,caseStatusAtCapture:'assessment',authored,sources:[]};
 state.read.mockResolvedValue({ok:true,patientId:19,orthoCaseId:41,clinicalCaseId:51,revision:{id:91,patientId:19,orthoCaseId:41,clinicalCaseId:51,version:1,kind:'draft',content,contentHash:journeyContentHash(content)}});
});
it('routes explicit full mode to canonical export authorization without changing legacy illustrated or default text',async()=>{
 expect(dynamic).toBe('force-dynamic');
 const element=await Page(input(query('full')));expect(element.type).toBe(FullPrint);
 expect(element.props).toEqual({session:state.session,orthoCaseId:41,patientId:19,revisionId:91});
 const html=renderToStaticMarkup(await FullPrint(element.props));
 expect(html.replace(/<[^>]+>/g,'')).toContain('SYNTHETIC_SAVED_MARKER &lt;script&gt;');expect(html).toContain('data-print-ready="false"');expect(html).not.toContain('<script>');
 expect(state.read).toHaveBeenCalledTimes(3);
 for(const [read] of state.read.mock.calls)expect(read).toEqual({session:state.session,orthoCaseId:41,patientId:19,revisionId:91,exportAccess:true});
 expect(state.audit).toHaveBeenCalledOnce();
 const legacy=await Page(input(query('illustrated')));expect(legacy.type).toBe(LegacyPrint);expect(legacy.props).toEqual(element.props);
 state.read.mockClear();const text=renderToStaticMarkup(await Page(input()));expect(text).toContain('نسخة نصية');expect(state.read).toHaveBeenCalledTimes(2);
});
it.each([['full'],['full','illustrated'],'FULL','text','', 'pdf'])('rejects unsupported or repeated mode %j rather than guessing',async mode=>{
 await expect(Page(input(query(mode)))).rejects.toThrow('not_found');expect(state.read).not.toHaveBeenCalled();expect(state.audit).not.toHaveBeenCalled();
});
it('rejects missing/ambiguous scope, extra query keys and missing session before preparation',async()=>{
 for(const candidate of [{patientId:'19',mode:'full'},{patientId:['19','20'],revisionId:'91',mode:'full'},{...query('full'),permission:'true'},{...query('full'),patientId:'0'}])await expect(Page(input(candidate))).rejects.toThrow('not_found');
 state.session=null;await expect(Page(input(query('full')))).rejects.toThrow('not_found');expect(state.read).not.toHaveBeenCalled();
});
it('never falls back to another print mode after denied full-mode authorization',async()=>{
 state.read.mockResolvedValue({ok:false,status:403,code:'study_export_forbidden'});
 const element=await Page(input(query('full'))),html=renderToStaticMarkup(await FullPrint(element.props));
 expect(html).toContain('لم تُجهز نسخة جزئية');expect(html).not.toContain('SYNTHETIC_SAVED_MARKER');expect(html).not.toContain('data-print-sheet');expect(html).not.toContain('<button');
 expect(state.read).toHaveBeenCalledOnce();expect(state.audit).not.toHaveBeenCalled();
});
