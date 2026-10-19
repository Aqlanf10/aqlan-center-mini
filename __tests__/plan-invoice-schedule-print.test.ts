import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({plan:vi.fn()}));
vi.mock('@/lib/db',()=>({CLINIC_TIME_ZONE:'Asia/Aden',getPlan:mock.plan,getSettingsSafe:async()=>({})}));
vi.mock('@/lib/session',()=>({requireSession:async()=>({role:'admin'})}));
vi.mock('@/components/PrintHeader',()=>({PrintHeader:()=>createElement('h1',null,'Synthetic print')}));
vi.mock('@/components/PrintButton',()=>({PrintButton:()=>null}));
import Page from '../app/print/plan/[id]/page';
it.each([false,true])('prints current rows only when schedule requiresReview=%s',async requiresReview=>{
 mock.plan.mockResolvedValue({id:1,patientName:'Synthetic',title:'Synthetic',baseCurrency:'SAR',items:[],invoiceFinancial:{kind:'invoice_backed',progress:{totalMinor:100000},paidMinor:0,remainingMinor:100000,schedules:[{id:1,status:'active',target:{invoiceId:1},version:1,requiresReview,progress:{rows:[{dueDate:'2026-01-01',amountMinor:12345,remainingMinor:12345}]}}]}});
 const html=renderToStaticMarkup(await Page({params:Promise.resolve({id:'1'})}));
 if(requiresReview){expect(html).toContain('يحتاج جدول السداد إلى مراجعة');expect(html).not.toContain('123.45');}
 else expect(html).toContain('123.45');
});
