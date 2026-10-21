import {describe,it,expect} from 'vitest';
import {freezeUnpaidCurrencyRequest,restoreUnpaidCurrencyRequest,parseUnpaidCurrencyAcknowledgement,parseUnpaidCurrencyRequest,
  type UnpaidCurrencyRequest} from '../lib/invoice-unpaid-currency-contract';
const request:UnpaidCurrencyRequest={version:1,kind:'invoice-currency-correction',evidenceKind:'unpaid_root_v1',invoiceId:1,patientId:2,
  idempotencyKey:'u0-frozen-request',expectedSourceHash:'a'.repeat(64),discountReason:'',intent:{version:1,purpose:'wrong-currency',fromCurrency:'SAR',toCurrency:'USD',reason:'Wrong selected currency',mode:'preserve-numerals'}};
const ack={version:1,kind:'invoice-currency-correction',evidenceKind:'unpaid_root_v1',correctionId:7,patientId:2,currency:'USD',originalCurrency:'SAR',
  idempotencyKey:request.idempotencyKey,requestHash:'b'.repeat(64),createdBy:'admin',actorUserId:3,effectiveAt:'2026-10-21T00:00:00.123456Z',amountMode:'preserve-numerals',settledMinor:0,
  sourcePrincipalMinor:100,targetPrincipalMinor:100,original:{id:1,patientId:2,baseCurrency:'SAR',invoiceNumber:'INV-1',createdAt:'2025-01-01T00:00:00.987654Z'},
  corrected:{id:4,patientId:2,baseCurrency:'USD',invoiceNumber:'INV-2',createdAt:'2026-10-21T00:00:00.123456Z'}};
const expected={request,requestHash:'b'.repeat(64),actorUserId:3,createdBy:'admin'};
describe('independent frozen U0 command/ack contract',()=>{
  it('restores exact original bytes and preserves microsecond acknowledgement times',()=>{
    const body=freezeUnpaidCurrencyRequest(request);
    expect(freezeUnpaidCurrencyRequest(restoreUnpaidCurrencyRequest(body,2))).toBe(body);
    expect(parseUnpaidCurrencyAcknowledgement(ack,expected)).toEqual(ack);
  });
  it.each(['invoice-correction','invoice','debt','unknown'])('never upgrades old or unknown kind %s',kind=>{
    expect(()=>parseUnpaidCurrencyRequest({...request,kind})).toThrow();
  });
  it.each([{version:2},{evidenceKind:'legacy_v1'},{patientId:3},{requestHash:'c'.repeat(64)},{actorUserId:4},{createdBy:'other'},
    {currency:'YER'},{originalCurrency:'USD'},{settledMinor:1},{sourcePrincipalMinor:-1},{effectiveAt:'2026-10-21T00:00:00.123Z'},
    {extra:true},{amountMode:'exchange'}])('rejects mismatched acknowledgement %j',change=>{
    expect(()=>parseUnpaidCurrencyAcknowledgement({...ack,...change},expected)).toThrow();
  });
  it('refuses saved body normalization and another patient',()=>{
    const body=freezeUnpaidCurrencyRequest(request);
    expect(()=>restoreUnpaidCurrencyRequest(' '+body,2)).toThrow();
    expect(()=>restoreUnpaidCurrencyRequest(body,3)).toThrow();
  });
  it.each(['exchangeRate','fx','lines'])('rejects mixed/FX/implicit preserve intent field %s',field=>{
    expect(()=>freezeUnpaidCurrencyRequest({...request,intent:{...request.intent,[field]:1}})).toThrow();
  });
  it('does not invoke a nested accessor while freezing reviewed target prices',()=>{
    let called=false;const lines=[{itemId:1,unitPrice:'1'}];
    Object.defineProperty(lines,'0',{enumerable:true,get(){called=true;return {itemId:1,unitPrice:'1'};}});
    expect(()=>freezeUnpaidCurrencyRequest({...request,intent:{...request.intent,mode:'reviewed-target-amounts',lines,discount:'0'}})).toThrow();
    expect(called).toBe(false);
  });
  it('rejects changed target identity/time independently of echoed key',()=>{
    expect(()=>parseUnpaidCurrencyAcknowledgement({...ack,corrected:{...ack.corrected,id:1}},expected)).toThrow();
    expect(()=>parseUnpaidCurrencyAcknowledgement({...ack,corrected:{...ack.corrected,createdAt:'2026-10-21T00:00:00.123457Z'}},expected)).toThrow();
  });
});
