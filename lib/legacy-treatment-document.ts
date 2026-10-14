import type { Service } from "./db";
import { parseInvoiceInput } from "./invoice-input";
import { checkInvoiceAuthority } from "./invoice-pricing";
import { lineLinkage, validateLineSite } from "./invoice-clinical-linkage";
import { formatAmount, isCurrency, parseAmount, type Currency } from "./money";
import { previewLegacyReconciliation } from "./legacy-reconciliation-preview";
import { validateDebtRepaymentTerms, type DebtRepaymentTerms } from "./debt-installments";
import type { LegacyTreatmentRequest } from "./legacy-treatment";
import type { LineSite } from "./invoice-clinical-linkage";

/** Exact proportional discount in minor units. Largest remainder wins; ties use
 * document order. This distributes a discount only, never historical payments. */
export function allocateHistoricalDiscount(prices: readonly number[], discountMinor: number) {
  if (!prices.length || prices.some(price => !Number.isSafeInteger(price) || price <= 0)
    || !Number.isSafeInteger(discountMinor) || discountMinor < 0) throw new Error("Invalid historical discount inputs");
  const total = prices.reduce((sum, price) => sum + BigInt(price), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(discountMinor) >= total) throw new Error("Invalid historical discount total");
  const shares = prices.map((price, index) => {
    const numerator = BigInt(price) * BigInt(discountMinor);
    return { index, discountMinor: Number(numerator / total), remainder: numerator % total };
  });
  let left = discountMinor - shares.reduce((sum, share) => sum + share.discountMinor, 0);
  for (const share of [...shares].sort((a,b) => a.remainder === b.remainder ? a.index-b.index : a.remainder>b.remainder ? -1 : 1)) {
    if (!left) break;
    share.discountMinor++; left--;
  }
  return shares.map((share,index) => ({discountMinor:share.discountMinor,netMinor:prices[index]-share.discountMinor}));
}

export interface HistoricalDocumentLine {
  serviceId:number;description:string;category:string;doctorId:number|null;unitPriceMinor:number;
  priceReason:string|null;site:LineSite;caseId:number|null;sessions:number|null;
}
export interface HistoricalDocumentInput {
  patientId:number;currency:Currency;idempotencyKey:string;lines:HistoricalDocumentLine[];
  totalMinor:number;discountMinor:number;discountReason:string|null;agreedMinor:number;
  previouslyPaidMinor:number;remainingMinor:number;historicalAsOf:string;note:string|null;
  repaymentTerms:DebtRepaymentTerms;repaymentRemainingMinor:number;repaymentVersion:number;repaymentSourceHash:string|null;
}
export function parseHistoricalDocument(source:Record<string,unknown>, services:ReadonlyMap<number,Service>, doctors:ReadonlySet<number>,
  context:{today:string;role:string;maxDiscountPercent:number}):{ok:true;value:HistoricalDocumentInput}|{ok:false;message:string} {
  if(Object.keys(source).some(key=>!["patientId","currency","items","discount","discountReason","previouslyPaidAmount","historicalAsOf","note","idempotencyKey","repaymentTerms","repaymentRemainingMinor","repaymentVersion","repaymentSourceHash"].includes(key)))
    return {ok:false,message:"بيانات الاتفاق التاريخي غير صالحة؛ لا يُقبل قالب أو هوية مالية بديلة ضمن هذا الطلب."};
  if(!isCurrency(source.currency))return {ok:false,message:"اختر عملة الاتفاق."};
  const parsed=parseInvoiceInput(source,services,doctors);
  if(!parsed.ok)return parsed;
  if(!parsed.idempotencyKey)return {ok:false,message:"مفتاح الاتفاق إلزامي لاستعادة الطلب نفسه."};
  const lines:HistoricalDocumentLine[]=[];
  for(const item of parsed.items){
    const service=item.serviceId===null?null:services.get(item.serviceId);
    if(!service||lineLinkage(item).kind!=="clinical"||item.quantity!==1||item.unitPriceMinor<=0||item.planItemId!==null)
      return {ok:false,message:"كل بند تاريخي خدمة علاجية واحدة بموضعها وسعرها؛ قسّم خدمات كل سن إلى بنود مستقلة، واجعل التقويم والجسر بندًا واحدًا للمجموعة."};
    const site=validateLineSite(item);if(!site.ok)return {ok:false,message:"راجع موضع العلاج والأسنان لكل بند تاريخي."};
    lines.push({serviceId:service.id,description:service.name,category:service.category!,doctorId:item.doctorId??null,unitPriceMinor:item.unitPriceMinor,
      priceReason:parsed.authorityLines[lines.length].reason,site:site.site,caseId:item.caseId??null,sessions:item.sessions??null});
  }
  const totalMinor=lines.reduce((sum,line)=>sum+line.unitPriceMinor,0);
  if(!Number.isSafeInteger(totalMinor)||totalMinor<=0||parsed.discountMinor>=totalMinor)return {ok:false,message:"راجع مجموع الاتفاق والخصم؛ المتفق عليه يجب أن يكون موجبًا."};
  const discountReason=typeof source.discountReason==="string"?source.discountReason.trim()||null:null;
  const authority=checkInvoiceAuthority({lines:parsed.authorityLines,currency:parsed.baseCurrency,rates:{},role:context.role,
    maxDiscountPercent:context.maxDiscountPercent,totalMinor,discountMinor:parsed.discountMinor,discountReason});
  if(!authority.ok)return authority;
  const agreedMinor=totalMinor-parsed.discountMinor;
  const preview=previewLegacyReconciliation({draft:{currency:parsed.baseCurrency,agreedAmount:formatAmount(agreedMinor,parsed.baseCurrency),
    previouslyPaidAmount:typeof source.previouslyPaidAmount==="string"?source.previouslyPaidAmount:"",historicalAsOf:typeof source.historicalAsOf==="string"?source.historicalAsOf:""},today:context.today});
  if(preview.draftState!=="valid"||!preview.historical)return {ok:false,message:preview.message??"راجع المدفوع السابق وتاريخ المعلومات."};
  if(typeof source.repaymentRemainingMinor!=="number"||!Number.isSafeInteger(source.repaymentRemainingMinor)||source.repaymentRemainingMinor<0
    ||typeof source.repaymentVersion!=="number"||!Number.isSafeInteger(source.repaymentVersion)||source.repaymentVersion<0
    ||source.repaymentSourceHash!==null&&(typeof source.repaymentSourceHash!=="string"||!/^[a-f0-9]{64}$/.test(source.repaymentSourceHash)))
    return {ok:false,message:"راجع نسخة الرصيد السابق والمبلغ المطلوب جدولته."};
  const repayment=validateDebtRepaymentTerms(source.repaymentTerms,source.repaymentRemainingMinor);if(!repayment.ok)return repayment;
  return {ok:true,value:{patientId:parsed.patientId,idempotencyKey:parsed.idempotencyKey,lines,totalMinor,
    discountMinor:parsed.discountMinor,discountReason,...preview.historical,note:parsed.note,
    repaymentTerms:repayment.value,repaymentRemainingMinor:source.repaymentRemainingMinor,repaymentVersion:source.repaymentVersion,repaymentSourceHash:source.repaymentSourceHash as string|null}};
}

/** A document line supplies a clinical value only. Its historical paid/remaining
 * facts remain on the document; the transactional writer stores NULL on lines. */
export function historicalLineRequest(document:HistoricalDocumentInput,line:HistoricalDocumentLine):LegacyTreatmentRequest {
  return {serviceId:line.serviceId,toothCode:line.site.toothCode,surfaces:line.site.surfaces,episodeTeeth:line.site.episodeTeeth,scope:line.site.scope,
    caseId:line.caseId,sessions:line.sessions,currency:document.currency,agreedMinor:line.unitPriceMinor,previouslyPaidMinor:0,remainingMinor:0,
    historicalAsOf:document.historicalAsOf,note:document.note,idempotencyKey:null};
}
export interface HistoricalDocumentReceipt {
  id:number;version:number;revisionId:number;patientId:number;currency:Currency;createdBy:string;idempotencyKey:string;
  totalMinor:number;discountMinor:number;discountReason:string|null;agreedMinor:number;previouslyPaidMinor:number;remainingMinor:number;
  historicalAsOf:string;note:string|null;reason:string;
  lines:{agreementId:number;planItemId:number;planId:number;caseId:number|null;serviceId:number;doctorId:number|null;description:string;toothCode:number|null;site:LineSite;unitPriceMinor:number;discountMinor:number;netMinor:number}[];
  repayment:{arrangementId:number;revisionId:number;version:number;terms:DebtRepaymentTerms}|null;
}
export function parseHistoricalCorrection(source:Record<string,unknown>,current:HistoricalDocumentReceipt,today:string) {
  const bad=(message:string)=>({ok:false as const,message});
  if(["lines","serviceId","doctorId","toothCode","surfaces","site","caseId","planItemId"].some(key=>Object.hasOwn(source,key)))
    return bad("العلاج التاريخي بدأ قبل النظام؛ تغيير خدمته أو طبيبه أو موضعه قد يعيد كتابة علاج منفّذ. تبقى هويته الأصلية محفوظة ويلزم تصحيح سريري مستقل؛ لم يُغيّر الاتفاق.");
  if(Object.keys(source).some(key=>!["idempotencyKey","expectedVersion","expectedSourceHash","prices","discount","discountReason","previouslyPaidAmount","historicalAsOf","note","reason","repaymentTerms","repaymentRemainingMinor","repaymentVersion"].includes(key)))return bad("حقول التصحيح غير صالحة.");
  if(typeof source.idempotencyKey!=="string"||!/^[A-Za-z0-9._:-]{8,128}$/.test(source.idempotencyKey)||source.expectedVersion!==current.version
    ||typeof source.expectedSourceHash!=="string"||!/^[a-f0-9]{64}$/.test(source.expectedSourceHash))return bad("تغيّر الاتفاق؛ أعد قراءة النسخة الحالية قبل التصحيح.");
  if(typeof source.reason!=="string"||source.reason.trim().length<3||source.reason.trim().length>300)return bad("اكتب سبب التصحيح من ٣ إلى ٣٠٠ حرف.");
  if(!Array.isArray(source.prices)||source.prices.length!==current.lines.length)return bad("التصحيح المالي يحفظ جميع هويات العلاج؛ راجع أسعار البنود نفسها.");
  const prices=source.prices.map(value=>typeof value==="string"?parseAmount(value,current.currency):null);
  if(prices.some(value=>value===null||value<=0))return bad("كل بند يحتاج سعرًا موجبًا؛ حذف العلاج يحتاج مراجعة سريرية ومالية مستقلة.");
  const totalMinor=prices.reduce<number>((sum,value)=>sum+(value??0),0);
  const discountMinor=typeof source.discount==="string"?parseAmount(source.discount||"0",current.currency):null;
  const discountReason=typeof source.discountReason==="string"?source.discountReason.trim()||null:null;
  if(!Number.isSafeInteger(totalMinor)||discountMinor===null||discountMinor>=totalMinor||discountMinor>0&&(!discountReason||discountReason.length<3||discountReason.length>300))return bad("راجع الخصم وسببه ومجموع الاتفاق.");
  const preview=previewLegacyReconciliation({draft:{currency:current.currency,agreedAmount:formatAmount(totalMinor-discountMinor,current.currency),
    previouslyPaidAmount:typeof source.previouslyPaidAmount==="string"?source.previouslyPaidAmount:"",historicalAsOf:typeof source.historicalAsOf==="string"?source.historicalAsOf:""},today});
  if(preview.draftState!=="valid"||!preview.historical)return bad(preview.message??"راجع الحقائق المالية التاريخية.");
  if(typeof source.repaymentRemainingMinor!=="number"||!Number.isSafeInteger(source.repaymentRemainingMinor)||source.repaymentRemainingMinor<0
    ||typeof source.repaymentVersion!=="number"||!Number.isSafeInteger(source.repaymentVersion)||source.repaymentVersion<0)return bad("راجع الدين المتبقي ونسخة جدول السداد.");
  const repayment=validateDebtRepaymentTerms(source.repaymentTerms,source.repaymentRemainingMinor);if(!repayment.ok)return repayment;
  return {ok:true as const,value:{idempotencyKey:source.idempotencyKey,reason:source.reason.trim(),expectedSourceHash:source.expectedSourceHash,
    prices:prices as number[],totalMinor,discountMinor,discountReason,...preview.historical,
    note:typeof source.note==="string"?source.note.trim().slice(0,300)||null:null,repaymentTerms:repayment.value,repaymentRemainingMinor:source.repaymentRemainingMinor,repaymentVersion:source.repaymentVersion}};
}
