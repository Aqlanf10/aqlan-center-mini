import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,expect,it,vi} from 'vitest';
import {syntheticStudyCommand} from './fixtures/ortho-case-study';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
const state=vi.hoisted(()=>({revoked:false,at:'' as ''|'settings'|'audit',saved:{} as Record<string,unknown>,events:[] as string[]}));
vi.mock('../lib/db',()=>({getSettingsSafe:async()=>{state.events.push('settings');if(state.at==='settings')state.revoked=true;return {};},recordAudit:async()=>{state.events.push('audit');if(state.at==='audit')state.revoked=true;}}));
vi.mock('../lib/ortho-case-study-store',()=>({getOrthoCaseStudy:async()=>{state.events.push('read');return state.revoked?{ok:false,status:403}:state.saved;}}));
vi.mock('../lib/ortho-study-image-store',()=>({getStudyImagePreview:vi.fn()}));
vi.mock('../components/PrintHeader',()=>({PrintHeader:({title}:{title:string})=><h2>{title}</h2>}));
vi.mock('../components/OrthoStudyPrintButton',()=>({OrthoStudyPrintButton:()=> <button>Print</button>}));
import Print from '../components/OrthoIllustratedStudyPrint';
const input={session:{userId:7,username:'Synthetic',role:'doctor' as const,expiresAt:Date.now()+100000},patientId:19,orthoCaseId:41,revisionId:91};
beforeEach(()=>{
 state.revoked=false;state.at='';state.events=[];
 const authored=syntheticStudyCommand().content;authored.comment='PRIVATE_SAVED_ONLY <script>';
 const content={schemaVersion:1,capturedAt:'2026-11-05T00:00:00.000Z',recordedPatientId:19,orthoCaseId:41,clinicalCaseId:51,caseStatusAtCapture:'assessment',authored,sources:[]};
 state.saved={ok:true,patientId:19,orthoCaseId:41,clinicalCaseId:51,revision:{id:91,version:1,kind:'draft',content,contentHash:journeyContentHash(content)}};
});
it('prepares settings/audit before final authority and escapes exact saved text',async()=>{
 const html=renderToStaticMarkup(await Print(input));
 expect(state.events).toEqual(['read','settings','audit','read']);expect(html).toContain('PRIVATE_SAVED_ONLY &lt;script&gt;');
 expect(html).toContain('ليست مجهولة الهوية');expect(html).toContain('height: auto;');expect(html).not.toContain('<script>');
});
it.each(['settings','audit'] as const)('withholds the entire printout if access changes during %s',async at=>{
 state.at=at;const html=renderToStaticMarkup(await Print(input));
 expect(html).not.toContain('PRIVATE_SAVED_ONLY');expect(html).not.toContain('data:image/');expect(html).not.toContain('<button');
 expect(html).toContain('لم تُجهز نسخة جزئية');expect(state.events.at(-1)).toBe('read');
});
