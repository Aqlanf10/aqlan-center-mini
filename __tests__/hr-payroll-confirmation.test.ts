import { describe, expect, it } from "vitest";
import { readPendingPayrollPayment, readPayrollDisbursement, readPayrollPaymentConfirmation, readPayrollReversalConfirmation } from "../lib/hr-payroll-confirmation";
import type { HrPayrollDisbursementView } from "../lib/hr-payroll-shared";

const item = {id:8,staffId:4,currency:"SAR" as const};
const request = {itemId:8,amountMinor:2500,remainingBefore:9000,clientRequestId:"synthetic-request-001",
  components:{salaryMinor:1500,commissionMinor:1000},paymentMethod:"cash",referenceNumber:" ref ",notes:" note "};
const receipt: HrPayrollDisbursementView = {id:12,itemId:8,staffId:4,currency:"SAR",amountMinor:2500,
  clientRequestId:request.clientRequestId,paymentMethod:"cash",referenceNumber:"ref",notes:"note",expenseId:20,
  disbursedBy:"synthetic-admin",disbursedAt:"2026-10-01T09:00:00.000Z",reversedAt:null,reversedBy:null,reversalReason:null,
  parts:[{component:"salary",amountMinor:1500,expenseId:20,payableId:30},{component:"commission",amountMinor:1000,expenseId:21,payableId:31}]};
describe("payroll receipt confirmation",()=>{
  it("requires an actual matching mixed-currency receipt and both canonical vouchers",()=>{
    expect(readPayrollPaymentConfirmation({success:true,disbursement:receipt},item,request)).toEqual(receipt);
    for(const body of [{success:true},{success:false,disbursement:receipt},null]) expect(readPayrollPaymentConfirmation(body,item,request)).toBeNull();
    for(const mutation of [{itemId:9},{staffId:5},{currency:"YER"},{amountMinor:2501},{clientRequestId:"another-request"},
      {expenseId:99},{parts:[receipt.parts[0]]},{parts:[receipt.parts[0],{...receipt.parts[1],expenseId:20}]},
      {parts:[{...receipt.parts[0],amountMinor:1000},{...receipt.parts[1],amountMinor:1500}]}]) {
      expect(readPayrollPaymentConfirmation({success:true,disbursement:{...receipt,...mutation}},item,request)).toBeNull();
    }
  });
  it("distinguishes a verified reversal from an active payment and checks the original vouchers",()=>{
    const reversed={...receipt,reversedAt:"2026-10-01T10:00:00.000Z",reversedBy:"second-admin",reversalReason:"synthetic correction"};
    expect(readPayrollDisbursement(reversed,item,request)).toEqual(reversed);
    expect(readPayrollPaymentConfirmation({success:true,disbursement:reversed},item,request)).toBeNull();
    expect(readPayrollReversalConfirmation({success:true,disbursement:reversed},receipt," synthetic correction ")).toEqual(reversed);
    for(const changed of [{id:13},{reversalReason:"other"},{reversedAt:null},{parts:[{...receipt.parts[0],payableId:90},receipt.parts[1]]}]) {
      expect(readPayrollReversalConfirmation({success:true,disbursement:{...reversed,...changed}},receipt,"synthetic correction")).toBeNull();
    }
  });
  it("rejects corrupt saved requests instead of inventing a replacement key",()=>{
    expect(readPendingPayrollPayment(request,item.id)).toEqual(request);
    for(const changed of [{itemId:9},{amountMinor:9001},{components:{salaryMinor:2500,commissionMinor:1}},
      {clientRequestId:"short"},{completed:"yes"},{notes:{}},{paymentMethod:"bank"}]) {
      expect(readPendingPayrollPayment({...request,...changed},item.id)).toBeNull();
    }
  });
  it("confirms the unchanged null identity of a legitimate keyless legacy reversal",()=>{
    const old={...receipt,clientRequestId:null};
    const reversed={...old,reversedAt:"2026-10-01T10:00:00.000Z",reversedBy:"second-admin",reversalReason:"legacy correction"};
    expect(readPayrollReversalConfirmation({success:true,disbursement:reversed},old,"legacy correction")).toEqual(reversed);
    expect(readPayrollReversalConfirmation({success:true,disbursement:{...reversed,clientRequestId:"invented-key"}},old,"legacy correction")).toBeNull();
    expect(readPayrollPaymentConfirmation({success:true,disbursement:old},item,request)).toBeNull();
    expect(readPendingPayrollPayment({...request,clientRequestId:null},item.id)).toBeNull();
    const missing={...old,clientRequestId:undefined} as unknown as HrPayrollDisbursementView;
    expect(readPayrollReversalConfirmation({success:true,disbursement:{...reversed,clientRequestId:undefined}},missing,"legacy correction")).toBeNull();
  });
});
