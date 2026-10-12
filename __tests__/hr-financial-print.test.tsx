import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatAmount, type Currency } from "../lib/money";
const mocks = vi.hoisted(() => ({ session:vi.fn(),run:vi.fn(),items:vi.fn(),contract:vi.fn() }));
vi.mock("@/lib/session",()=>({ requireSession:mocks.session }));
vi.mock("@/lib/db",()=>({ getSettingsSafe:async()=>({}) }));
vi.mock("@/lib/hr",()=>({ canManageStaff:(role:string)=>role === "admin" }));
vi.mock("@/lib/hr-payroll",()=>({ getPayrollRunById:mocks.run,listPayrollItems:mocks.items }));
vi.mock("@/lib/hr-contracts-attendance",()=>({ getContractById:mocks.contract,listContractAddenda:async()=>[] }));
vi.mock("@/components/PrintHeader",()=>({ PrintHeader:()=>null,PrintFooter:()=>null }));
vi.mock("@/components/PrintButton",()=>({ PrintButton:()=>null }));
import PayrollPage from "../app/print/hr/payroll/[id]/page";
import ContractPage from "../app/print/hr/contracts/[id]/page";
beforeEach(()=>{ vi.clearAllMocks();mocks.session.mockResolvedValue({ role:"admin" }); });
describe("HR print uses actual monetary units and every row",()=>{
  it.each(["YER","SAR","USD"] as Currency[])("payroll rows and totals retain %s units",async(currency)=>{
    mocks.run.mockResolvedValue({ id:1,currency,status:"approved",periodKey:"2026-10",totalBaseSalaryMinor:125000,totalAllowancesMinor:12300,totalCommissionsMinor:4500,totalDeductionsMinor:300,totalNetDueMinor:141500,totalPaidMinor:20000 });
    mocks.items.mockResolvedValue(Array.from({length:42},(_,i)=>({ id:i,staffName:`HR-ROW-${i}`,baseSalaryMinor:125000,allowancesMinor:12300,commissionsMinor:4500,deductionsMinor:300,netDueMinor:141500,paidMinor:20000,status:"partially_paid" })));
    const html = renderToStaticMarkup(await PayrollPage({params:Promise.resolve({id:"1"})}));
    for(const minor of [125000,12300,4500,300,141500,20000]) expect(html).toContain(formatAmount(minor,currency));
    for(let i=0;i<42;i++) expect(html).toContain(`HR-ROW-${i}`);
  });
  it.each(["YER","SAR","USD"] as Currency[])("contract salary retains %s units without inventing signatures",async(currency)=>{
    mocks.contract.mockResolvedValue({ id:1,templateKind:"support_staff",status:"active",contractNumber:"CTR-TEST",title:"HR-SALARY",salaryCurrency:currency,baseSalaryMinor:125000,termsPayload:{},signedByStaff:false,signedByCenter:false });
    const html = renderToStaticMarkup(await ContractPage({params:Promise.resolve({id:"1"})}));
    expect(html).toContain(formatAmount(125000,currency));
  });
  it("non-admin print never loads payroll or contract data",async()=>{
    mocks.session.mockResolvedValue({role:"doctor"});
    await PayrollPage({params:Promise.resolve({id:"1"})});await ContractPage({params:Promise.resolve({id:"1"})});
    expect(mocks.run).not.toHaveBeenCalled();expect(mocks.items).not.toHaveBeenCalled();expect(mocks.contract).not.toHaveBeenCalled();
  });
});
