import { ensureSchema, getPool, getPayment, getSettingsInTransaction, insertAuditRow, writeDebtCollectionReceipt } from "./db";
import type { SessionPayload } from "./auth";
import { CLINIC_BASE_CURRENCY, isCurrency, settlePaymentMinor, toBaseAmount, type Currency } from "./money";
import { rateFromSettings } from "./settings";
import { assertDebtSession, DebtRepaymentError, debtRequestHash, readDebtPosition, type DebtTarget } from "./debt-installments-db";

import { debtAccountDue } from "./debt-account-position";
import {debtRevisionSourceMatches} from "./debt-source-proof";
import {assertSimilarCollectionReviewed,type SimilarCollectionReview} from "./similar-collection";
export async function collectDebtInstallment(input: {
  patientId:number;arrangementId:number;expectedVersion:number;amountMinor:number;currency:Currency;
  method:"cash"|"transfer";note:string|null;idempotencyKey:string;session:SessionPayload;
},options:{similarityReview?:SimilarCollectionReview}={}) {
  if(![input.patientId,input.arrangementId,input.expectedVersion,input.amountMinor].every(value=>Number.isSafeInteger(value)&&value>0)
    ||!isCurrency(input.currency)||!["cash","transfer"].includes(input.method)||!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey))
    throw new DebtRepaymentError("invalid","بيانات التحصيل غير صالحة.");
  const hash=debtRequestHash({purpose:"debt-collection-v1",...input,session:{id:input.session.userId,username:input.session.username,role:input.session.role}});
  await ensureSchema();const client=await getPool().connect();
  let paymentId=0;let replayed=false;
  try{
    await client.query("BEGIN");await assertDebtSession(client,input.session);
    const replay=async()=>{
      const {rows:[prior]}=await client.query<{id:number;patient_id:number;created_by:string;idempotency_request_hash:string}>("SELECT id,patient_id,created_by,idempotency_request_hash FROM payments WHERE idempotency_key=$1",[input.idempotencyKey]);
      if(!prior)return null;
      if(prior.idempotency_request_hash!==hash||prior.patient_id!==input.patientId||prior.created_by!==input.session.username)
        throw new DebtRepaymentError("conflict","مفتاح الإعادة مستعمل بتحصيل مختلف.");
      await assertDebtSession(client,input.session);return prior.id;
    };
    const early=await replay();
    if(early){paymentId=early;replayed=true;await client.query("COMMIT");}
    else{
      // Same financial order as canonical recovery: patient FK fence -> shift ->
      // linked visits -> opening-table fence -> sorted invoices -> sorted plans -> arrangement.
      // No original-receipt lock is acquired: this path creates only new payments.
      await client.query("SELECT id FROM patients WHERE id=$1 FOR KEY SHARE",[input.patientId]);
      const {rows:shifts}=await client.query("SELECT id FROM cashier_shifts WHERE status='open' FOR UPDATE");
      const waited=await replay();
      if(waited){paymentId=waited;replayed=true;await client.query("COMMIT");}
      else{
        if(!shifts.length)throw new DebtRepaymentError("stale","لا توجد وردية مفتوحة؛ افتح الوردية قبل التحصيل.");
        // Advisory review under the shift lock and after exact-key replay; a throw rolls back.
        await assertSimilarCollectionReviewed(client,{patientId:input.patientId,amountMinor:input.amountMinor,currency:input.currency,review:options.similarityReview});
        await client.query("SELECT id FROM visits WHERE patient_id=$1 AND invoice_id IS NOT NULL ORDER BY id FOR UPDATE",[input.patientId]);
        await client.query("LOCK TABLE patient_opening_balances IN SHARE MODE");
        const invoices=(await client.query<{id:number}>("SELECT id FROM invoices WHERE patient_id=$1 ORDER BY id FOR UPDATE",[input.patientId])).rows;
        const plans=(await client.query<{id:number}>("SELECT id FROM treatment_plans WHERE patient_id=$1 ORDER BY id FOR SHARE",[input.patientId])).rows;
        const {rows:[arrangement]}=await client.query<{id:number;currency:Currency;invoice_id:number|null;opening_currency:Currency|null}>(
          "SELECT * FROM debt_repayment_arrangements WHERE id=$1 AND patient_id=$2 FOR UPDATE",[input.arrangementId,input.patientId]);
        if(!arrangement)throw new DebtRepaymentError("missing","جدول السداد لا يخص هذا المريض.");
        const {rows:[revision]}=await client.query<{version:number;status:string;source_snapshot:unknown;settled_snapshot_minor:string}>("SELECT * FROM debt_repayment_revisions WHERE arrangement_id=$1 ORDER BY version DESC LIMIT 1",[arrangement.id]);
        if(!revision||revision.version!==input.expectedVersion||revision.status!=="active")throw new DebtRepaymentError("stale","تغيّر جدول السداد أو أُلغي؛ راجع النسخة الحالية.");
        const target:DebtTarget={patientId:input.patientId,currency:arrangement.currency,invoiceId:arrangement.invoice_id,openingCurrency:arrangement.opening_currency};
        const position=await readDebtPosition(client,target,true);
        if(!position.available||!debtRevisionSourceMatches(position.sourceSnapshot,revision.source_snapshot)||position.settledMinor<Number(revision.settled_snapshot_minor))
          throw new DebtRepaymentError("stale","تغيّر مصدر الدين أو رُدّ تحصيل سابق؛ راجع توزيع المتبقي قبل القبض.");
        if(input.currency!==target.currency&&target.currency!==CLINIC_BASE_CURRENCY)throw new DebtRepaymentError("invalid","حصّل الدين بعملته؛ التحويل بين عملتين أجنبيتين غير مدعوم.");
        const rate=rateFromSettings(await getSettingsInTransaction(client,{requireStoredExchangeRates:true}),input.currency,CLINIC_BASE_CURRENCY);
        if(rate===null||!Number.isFinite(rate)||rate<=0)throw new DebtRepaymentError("invalid","اضبط سعر الصرف المعتمد قبل التحصيل.");
        const baseAmount=toBaseAmount(input.amountMinor,input.currency,CLINIC_BASE_CURRENCY,rate);
        const settlement=settlePaymentMinor({amountMinor:input.amountMinor,currency:input.currency,baseAmountMinor:baseAmount},target.currency);
        const account=await debtAccountDue(client,input.patientId,target.currency);
        if(JSON.stringify(account.invoiceIds)!==JSON.stringify(invoices.map(row=>row.id))||JSON.stringify(account.planIds)!==JSON.stringify(plans.map(row=>row.id)))
          throw new DebtRepaymentError("stale","تغيّرت مستندات الحساب أثناء التحصيل؛ أعد المحاولة بالمفتاح نفسه.");
        if(!Number.isSafeInteger(baseAmount)||!Number.isSafeInteger(settlement)||settlement<=0||settlement>position.remainingMinor||settlement>Math.max(0,account.due))
          throw new DebtRepaymentError("invalid","المبلغ يتجاوز المتبقي على الدين أو المستحق الفعلي على الحساب؛ راجع التسويات.");
        await assertDebtSession(client,input.session);
        const receipt=await writeDebtCollectionReceipt(client,{patientId:input.patientId,invoiceId:target.invoiceId,openingCurrency:target.openingCurrency,
          amountMinor:input.amountMinor,currency:input.currency,exchangeRate:rate,method:input.method,note:input.note,createdBy:input.session.username,idempotencyKey:input.idempotencyKey,requestHash:hash});
        if(receipt.kind==="reason")throw new DebtRepaymentError("stale",`تعذّر التحصيل: ${receipt.reason}`);
        paymentId=receipt.paymentId;replayed=receipt.kind==="replay";
        const {rows:[stored]}=await client.query<{exchange_rate:string;base_amount_minor:string}>("SELECT exchange_rate::text,base_amount_minor::text FROM payments WHERE id=$1",[paymentId]);
        if(!stored||Number(stored.exchange_rate)<=0||Number(stored.base_amount_minor)!==baseAmount)throw new DebtRepaymentError("invalid","سعر الصرف المسجّل غير صالح؛ لم يُثبت التحصيل.");
        if(!replayed)await insertAuditRow(client,{action:"debt_repayment.collect",entity:"payment",entityId:paymentId,actor:input.session.username,actorRole:input.session.role,
          details:{arrangementId:arrangement.id,version:revision.version,target,settlementMinor:settlement,priorRemainingMinor:position.remainingMinor,newRemainingMinor:position.remainingMinor-settlement,
            currency:input.currency,amountMinor:input.amountMinor,exchangeRate:Number(stored.exchange_rate),baseAmountMinor:baseAmount,priorAccountDueMinor:account.due}});
        await assertDebtSession(client,input.session);await client.query("COMMIT");
      }
    }
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  return {payment:await getPayment(paymentId),replayed};
}
