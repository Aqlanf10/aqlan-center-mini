import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const harness=vi.hoisted(()=>({states:[] as unknown[], refs:[] as {current:number}[], cursor:0, refCursor:0, effects:[] as (()=>void)[]}));
vi.mock('react',async(original)=>({...await original<typeof import('react')>(),
  useState:(initial:unknown)=>{const index=harness.cursor++;if(!(index in harness.states))harness.states[index]=typeof initial==='function'?initial():initial;return[harness.states[index],(value:unknown)=>{harness.states[index]=typeof value==='function'?value(harness.states[index]):value;}];},
  useRef:(initial:number)=>{const index=harness.refCursor++;return harness.refs[index]??(harness.refs[index]={current:initial});},
  useEffect:(effect:()=>void)=>{harness.effects.push(effect);},
  useCallback:(callback:unknown)=>callback,
}));
vi.mock('../components/PageHeader',()=>({PageHeader:({children}:{children:ReactNode})=>createElement('header',null,children),StatCard:()=>null}));
vi.mock('../components/financeLinks',()=>({financeLinks:()=>[]}));
import FxPage from '../app/finance/fx/page';
import ExecutivePage from '../app/executive/page';
import { JOURNAL_REVIEW_RESPONSE } from '../lib/journal-read-integrity';
function render(Page:typeof FxPage){harness.cursor=0;harness.refCursor=0;harness.effects=[];return renderToStaticMarkup(createElement(Page));}
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(yes=>{resolve=yes;});return{promise,resolve};}
const response=(payload:unknown,status=200)=>({ok:status===200,status,json:async()=>payload}) as Response;
async function settle(){for(let i=0;i<8;i++)await Promise.resolve();}
beforeEach(()=>{harness.states=[];harness.refs=[];harness.effects=[];vi.clearAllMocks();});
afterEach(()=>vi.unstubAllGlobals());
for(const [name,Page,feedIndex] of [['FX',FxPage,0],['executive',ExecutivePage,2]] as const){
  it(`${name} clears stale data, shows review and retry, and never claims successful empty results`,async()=>{
    const pending=deferred();vi.stubGlobal('fetch',vi.fn(()=>pending.promise));
    render(Page);harness.effects[0]();
    // Simulate an existing successful result retained by an earlier render.
    harness.states[feedIndex]={sentinel:'previous money'};
    pending.resolve(response(JOURNAL_REVIEW_RESPONSE,409));await settle();
    const html=render(Page);
    expect(harness.states[feedIndex]).toBeNull();expect(html).toContain('role="alert"');expect(html).toContain(JOURNAL_REVIEW_RESPONSE.message);
    expect(html).toContain('إعادة المحاولة');expect(html).not.toContain('لا عملات أجنبية');expect(html).not.toContain('تصدير CSV');expect(html).not.toContain('previous money');
  });
  it(`${name} ignores an older success arriving after the latest integrity refusal`,async()=>{
    const old=deferred(),current=deferred();vi.stubGlobal('fetch',vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise));
    render(Page);const effect=harness.effects[0];effect();effect();
    current.resolve(response(JOURNAL_REVIEW_RESPONSE,409));await settle();
    old.resolve(response({sentinel:'stale success'}));await settle();
    expect(harness.states[feedIndex]).toBeNull();expect(render(Page)).toContain(JOURNAL_REVIEW_RESPONSE.message);
  });
}
it('FX reserves the empty-currency message for a successful empty response',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response({asOf:'2026-08-07',baseCurrency:'YER',positions:[],historicalRevaluations:[]})));
  render(FxPage);harness.effects[0]();await settle();const html=render(FxPage);
  expect(html).toContain('لا عملات أجنبية');expect(html).not.toContain('role="alert"');
});
