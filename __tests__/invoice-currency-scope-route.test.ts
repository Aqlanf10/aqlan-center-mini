import { beforeEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({session:vi.fn(),read:vi.fn(),write:vi.fn()}));
vi.mock("@/lib/session",()=>({requireSession:mocks.session}));
vi.mock("@/lib/invoice-revision-db",()=>({readInvoiceRevision:mocks.read,reviseInvoice:mocks.write}));
vi.mock("@/lib/debt-installments-db",()=>({DebtRepaymentError:class extends Error{constructor(public code:string,message:string){super(message);}}}));
import { GET } from "../app/api/invoices/[id]/correct/route";
const context={params:Promise.resolve({id:"12"})};
beforeEach(()=>vi.clearAllMocks());
it.each([null,"doctor","reception","accountant","cashier"])("does not disclose diagnostics to %s",async role=>{
  mocks.session.mockResolvedValue(role?{role,username:"synthetic"}:null);
  const response=await GET(new Request("http://localhost/api/invoices/12/correct"),context);
  expect(response.status).toBe(403);expect(mocks.read).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
  expect(await response.json()).not.toHaveProperty("currencyCorrection");
});
it("returns only the reader's diagnosed scope to the existing admin GET",async()=>{
  mocks.session.mockResolvedValue({role:"admin",username:"synthetic"});
  const diagnostic={currencyCorrection:{available:false,targetCurrency:"SAR",settledMinor:0,accountDueMinor:0,reasonCodes:["INDEPENDENT_ITEM_SOURCE"],message:"تصحيح هذا المصدر غير مدعوم حاليًا."}};
  mocks.read.mockResolvedValue(diagnostic);
  const response=await GET(new Request("http://localhost/api/invoices/12/correct"),context);
  expect(response.status).toBe(200);expect(await response.json()).toEqual(diagnostic);
  expect(mocks.read).toHaveBeenCalledWith(12,{role:"admin",username:"synthetic"});expect(mocks.write).not.toHaveBeenCalled();
});
