import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ cursor: 0, role: "accountant", plans: [] as unknown[] }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
 useState: (value: unknown) => { const n=state.cursor++; return [n===0?state.plans:n===1?false:value,vi.fn()]; },
 useMemo: (fn:()=>unknown)=>fn(), useCallback:(fn:unknown)=>fn, useEffect:()=>{},
}));
vi.mock('@/components/SettingsProvider',()=>({useClinicName:()=> 'Synthetic clinic',useSetting:()=>''}));
vi.mock('@/components/SessionProvider',()=>({useSession:()=>({role:state.role})}));
vi.mock('@/components/PageHeader',()=>({PageHeader:()=>null}));
import PlansPage from '../app/finance/plans/page';
import { formatMoney } from '../lib/money';
function fixture(id:number,currency:string,amount:number){return {id,patientId:id,patientName:`Synthetic ${currency}`,patientPhone:null,title:`PLAN-${currency}`,baseCurrency:currency,totalMinor:amount,status:'active',progress:{totalMinor:amount,dueToDateMinor:amount,paidMinor:0,remainingMinor:amount,overdueMinor:amount,nextDueDate:'2026-01-01',nextDueAmountMinor:amount,paidCount:0,count:1}};}
beforeEach(()=>{state.cursor=0;state.role="accountant";state.plans=[fixture(1,'SAR',10000),fixture(2,'YER',2500)];});
function render(){const html=renderToStaticMarkup(PlansPage());return html;}
it('keeps native amounts and separates currency totals',()=>{
 const html=render();expect(html).toContain(formatMoney(10000,'SAR'));expect(html).toContain(formatMoney(2500,'YER'));
 expect(html).not.toContain(formatMoney(12500,'YER'));expect(html).not.toContain(formatMoney(10000,'YER'));
});it('uses the plan currency in reminder text without opening an external service',()=>{
 const open=vi.fn();vi.stubGlobal('window',{open});vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({})}));
 state.role='admin';state.plans=[{...fixture(1,'SAR',10000),patientPhone:'777123456'}];
 // This test only observes the client event; neither timestamp writes nor
 // WhatsApp navigation leave the test process.
 const find=(node:unknown):{props:{onClick:()=>void}}|undefined=>{
  if(Array.isArray(node)){for(const child of node){const result=find(child);if(result)return result;}return;}
  if(node&&typeof node==='object'&&'props' in node){const element=node as {props:{id?:string;children?:unknown;onClick:()=>void}};if(element.props.id==='plan-reminder-btn-1')return element;return find(element.props.children);}
 };
 const button=find(PlansPage());
 expect(button).toBeDefined();button!.props.onClick();
 const message=new URL(open.mock.calls[0][0]).searchParams.get("text");
 expect(message).toContain(formatMoney(10000,"SAR"));expect(message).not.toContain(formatMoney(10000,"YER"));vi.unstubAllGlobals();
});
