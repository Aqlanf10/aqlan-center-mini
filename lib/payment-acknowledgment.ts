import {CLINIC_BASE_CURRENCY,isCurrency,toBaseAmount,type Currency} from "./money";

/** Additive response-only evidence. It does not authorize a payment or override
 * its stored base amount. The server proves the request hash, PostgreSQL cast,
 * refund membership, audit pair and invoice lineage before emitting it. */
export interface PaymentCalculationEvidence {
  kind:"generic-v1-request-rate";
  paymentId:number;amountMinor:number;currency:Currency;baseCurrency:Currency;
  exchangeRate:number;baseAmountMinor:number;calculationRate:number;
}
export interface PaymentReplacementLineageEvidence {
  kind:"reclassified-original-target";
  patientId:number;originalPaymentId:number;sourceInvoiceId:number;targetInvoiceId:number;
  documentId:number;correctionId:number;sourceInvoiceIds:number[];
  documentOriginalInvoiceId:number;documentCorrectedInvoiceId:number;
  path:Array<{correctionId:number;originalInvoiceId:number;correctedInvoiceId:number}>;
}
export interface CorrectionAcknowledgmentEvidence {
  pair:{auditId:number;originalId:number;reversalId:number;replacementId:number|null;actor:string;reason:string;keyedPaymentId:number};
  origin:{id:number;receiptNumber:string;amountMinor:number;baseAmountMinor:number;currency:Currency;baseCurrency:Currency;
    exchangeRate:number;method:string;invoiceId:number|null;planId:number|null;openingCurrency:Currency|null};
  closingRefund:{reversalId:number;otherRefunds:Array<{id:number;amountMinor:number;baseAmountMinor:number}>};
  replacementCalculation?:PaymentCalculationEvidence;
  replacementLineage?:PaymentReplacementLineageEvidence;
}
export type AcknowledgmentEvidence =
  | {version:1;status:"unconfirmed"}
  | {version:1;operation:"payment";requestKey:string;calculation:PaymentCalculationEvidence}
  | {version:1;operation:"correct"|"void";requestKey:string;correction:CorrectionAcknowledgmentEvidence};

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const id=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>0;
const amount=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
const rate=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value)&&value>0;
const nonempty=(value:unknown):value is string=>typeof value==="string"&&!!value.trim();
const nullableId=(value:unknown)=>value===null||id(value);
const keys=(value:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[])=>
  required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));

function calculation(value:unknown):value is PaymentCalculationEvidence {
  return record(value)&&keys(value,["kind","paymentId","amountMinor","currency","baseCurrency","exchangeRate","baseAmountMinor","calculationRate"])
    &&value.kind==="generic-v1-request-rate"&&id(value.paymentId)&&amount(value.amountMinor)&&value.amountMinor>0&&isCurrency(value.currency)
    &&value.baseCurrency===CLINIC_BASE_CURRENCY&&rate(value.exchangeRate)&&amount(value.baseAmountMinor)&&rate(value.calculationRate);
}
function lineage(value:unknown):value is PaymentReplacementLineageEvidence {
  if(!record(value)||!keys(value,["kind","patientId","originalPaymentId","sourceInvoiceId","targetInvoiceId","documentId","correctionId","sourceInvoiceIds","documentOriginalInvoiceId","documentCorrectedInvoiceId","path"])
    ||value.kind!=="reclassified-original-target"||!id(value.patientId)||!id(value.originalPaymentId)||!id(value.sourceInvoiceId)||!id(value.targetInvoiceId)
    ||!id(value.documentId)||!id(value.correctionId)||!id(value.documentOriginalInvoiceId)||!id(value.documentCorrectedInvoiceId)
    ||!Array.isArray(value.sourceInvoiceIds)||!value.sourceInvoiceIds.length||!value.sourceInvoiceIds.every(id)
    ||new Set(value.sourceInvoiceIds).size!==value.sourceInvoiceIds.length||!value.sourceInvoiceIds.includes(value.sourceInvoiceId)
    ||!value.sourceInvoiceIds.includes(value.documentOriginalInvoiceId)||!Array.isArray(value.path))return false;
  const sources=new Set(value.sourceInvoiceIds),invoices=new Set([value.documentCorrectedInvoiceId]),corrections=new Set([value.correctionId]);
  if(sources.has(value.documentCorrectedInvoiceId))return false;
  let current=value.documentCorrectedInvoiceId;
  for(const edge of value.path){
    if(!record(edge)||!keys(edge,["correctionId","originalInvoiceId","correctedInvoiceId"])
      ||!id(edge.correctionId)||!id(edge.originalInvoiceId)||!id(edge.correctedInvoiceId)||edge.originalInvoiceId!==current
      ||corrections.has(edge.correctionId)||invoices.has(edge.correctedInvoiceId)||sources.has(edge.correctedInvoiceId))return false;
    corrections.add(edge.correctionId);invoices.add(edge.correctedInvoiceId);current=edge.correctedInvoiceId;
  }
  return current===value.targetInvoiceId;
}
function correction(value:unknown):value is CorrectionAcknowledgmentEvidence {
  if(!record(value)||!keys(value,["pair","origin","closingRefund"],["replacementCalculation","replacementLineage"]))return false;
  const {pair,origin,closingRefund}=value;
  if(!record(pair)||!keys(pair,["auditId","originalId","reversalId","replacementId","actor","reason","keyedPaymentId"])
    ||![pair.auditId,pair.originalId,pair.reversalId,pair.keyedPaymentId].every(id)||!nullableId(pair.replacementId)
    ||!nonempty(pair.actor)||!nonempty(pair.reason)||pair.reason!==pair.reason.trim()||pair.reason.length<3||pair.reason.length>300
    ||pair.originalId===pair.reversalId||pair.replacementId!==null&&(pair.replacementId===pair.originalId||pair.replacementId===pair.reversalId)
    ||pair.keyedPaymentId!==(pair.replacementId??pair.reversalId))return false;
  if(!record(origin)||!keys(origin,["id","receiptNumber","amountMinor","baseAmountMinor","currency","baseCurrency","exchangeRate","method","invoiceId","planId","openingCurrency"])
    ||origin.id!==pair.originalId||!id(origin.id)||!nonempty(origin.receiptNumber)||!amount(origin.amountMinor)||origin.amountMinor===0
    ||!amount(origin.baseAmountMinor)||!isCurrency(origin.currency)||origin.baseCurrency!==CLINIC_BASE_CURRENCY||!rate(origin.exchangeRate)
    ||!nonempty(origin.method)||!nullableId(origin.invoiceId)||!nullableId(origin.planId)||origin.openingCurrency!==null&&!isCurrency(origin.openingCurrency))return false;
  if(!record(closingRefund)||!keys(closingRefund,["reversalId","otherRefunds"])||closingRefund.reversalId!==pair.reversalId||!Array.isArray(closingRefund.otherRefunds))return false;
  const ids=new Set([pair.originalId,pair.reversalId,pair.replacementId]);
  for(const refund of closingRefund.otherRefunds){
    if(!record(refund)||!keys(refund,["id","amountMinor","baseAmountMinor"])||!id(refund.id)||ids.has(refund.id)
      ||!amount(refund.amountMinor)||refund.amountMinor===0||!amount(refund.baseAmountMinor))return false;
    ids.add(refund.id);
  }
  return (!Object.hasOwn(value,"replacementCalculation")||calculation(value.replacementCalculation))
    &&(!Object.hasOwn(value,"replacementLineage")||lineage(value.replacementLineage));
}

/** A present but unrecognised/malformed proof is never equivalent to no proof. */
export function readPaymentAcknowledgmentEvidence(value:unknown):AcknowledgmentEvidence|null {
  if(!record(value)||value.version!==1)return null;
  if(value.status==="unconfirmed")return keys(value,["version","status"])?{version:1,status:"unconfirmed"}:null;
  if(!nonempty(value.requestKey))return null;
  if(value.operation==="payment")return keys(value,["version","operation","requestKey","calculation"])&&calculation(value.calculation)?value as unknown as AcknowledgmentEvidence:null;
  if((value.operation!=="correct"&&value.operation!=="void")||!keys(value,["version","operation","requestKey","correction"])||!correction(value.correction))return null;
  if(value.operation==="void"&&(value.correction.pair.replacementId!==null||Object.hasOwn(value.correction,"replacementCalculation")||Object.hasOwn(value.correction,"replacementLineage"))
    ||value.operation==="correct"&&value.correction.pair.replacementId===null)return null;
  return value as unknown as AcknowledgmentEvidence;
}

/** Validate the producer's exact String(rate)::NUMERIC(18,6) snapshot. This
 * is response validation only, never payment pricing. Positive decimal ties
 * round away from zero; BigInt avoids binary-float rounding and tolerances. */
export function calculationRateMatchesStoredSnapshot(calculationRate:number,storedRate:number):boolean {
  if(!rate(calculationRate)||!rate(storedRate))return false;
  function decimal(value:number):{coefficient:bigint;exponent:number}|null {
    const match=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
    if(!match)return null;
    const fraction=match[2]??"";
    return {coefficient:BigInt(match[1]+fraction),exponent:Number(match[3]??0)-fraction.length+6};
  }
  const raw=decimal(calculationRate),stored=decimal(storedRate);
  if(!raw||!stored)return false;
  function units(value:{coefficient:bigint;exponent:number},round:boolean):bigint|null {
    if(value.exponent>=0)return value.coefficient*10n**BigInt(value.exponent);
    const divisor=10n**BigInt(-value.exponent),remainder=value.coefficient%divisor;
    if(!round&&remainder!==0n)return null;
    return value.coefficient/divisor+(round&&remainder*2n>=divisor?1n:0n);
  }
  const rounded=units(raw,true),exactStored=units(stored,false);
  // The producer additionally proves that the numeric DTO's String projection
  // equals the original PostgreSQL numeric text. No approximate Number equality
  // can stand in for a six-decimal snapshot at a large-rate precision edge.
  return rounded!==null&&rounded>0n&&rounded<10n**18n&&rounded===exactStored;
}

/** Use the proven historical request rate only for arithmetic, never current FX
 * or a tolerance around the stored six-decimal receipt rate. */
export function calculationEvidenceMatchesReceipt(proof:PaymentCalculationEvidence,value:unknown):boolean {
  return calculation(proof)&&record(value)&&proof.paymentId===value.id&&proof.amountMinor===value.amountMinor&&proof.currency===value.currency
    &&proof.baseCurrency===value.baseCurrency&&proof.exchangeRate===value.exchangeRate&&proof.baseAmountMinor===value.baseAmountMinor
    &&calculationRateMatchesStoredSnapshot(proof.calculationRate,proof.exchangeRate)
    &&toBaseAmount(proof.amountMinor,proof.currency,proof.baseCurrency,proof.calculationRate)===proof.baseAmountMinor;
}
export interface OriginalAcknowledgmentContext {
  id:number;receiptNumber:string;amountMinor:number;currency:Currency;method:string;
  invoiceId:number|null;planId?:number|null;openingCurrency?:Currency|null;remainingMinor:number;
}
/** A closing refund conserves the stored origin snapshot, not a fresh standalone
 * conversion. Integer subtraction is exact even when intermediate sums overflow
 * JavaScript's safe-number range. The producer proves the complete refund set. */
export function closingRefundEvidenceMatchesReceipt(proof:CorrectionAcknowledgmentEvidence,saved:OriginalAcknowledgmentContext,value:unknown):boolean {
  if(!correction(proof)||!record(value)||!amount(value.amountMinor)||!amount(value.baseAmountMinor)||!amount(saved.remainingMinor))return false;
  const {origin,closingRefund}=proof;
  if(origin.id!==saved.id||origin.receiptNumber!==saved.receiptNumber||origin.amountMinor!==saved.amountMinor||origin.currency!==saved.currency
    ||origin.method!==saved.method||origin.invoiceId!==saved.invoiceId||origin.planId!==(saved.planId??null)||origin.openingCurrency!==(saved.openingCurrency??null)
    ||value.id!==closingRefund.reversalId||value.reversalOfId!==origin.id||value.currency!==origin.currency||value.baseCurrency!==origin.baseCurrency
    ||value.exchangeRate!==origin.exchangeRate||value.method!==origin.method||value.invoiceId!==origin.invoiceId||value.planId!==origin.planId||value.openingCurrency!==origin.openingCurrency)return false;
  let native=BigInt(origin.amountMinor),base=BigInt(origin.baseAmountMinor);
  for(const refund of closingRefund.otherRefunds){native-=BigInt(refund.amountMinor);base-=BigInt(refund.baseAmountMinor);}
  return native>0n&&base>=0n&&native===BigInt(value.amountMinor)&&native===BigInt(saved.remainingMinor)&&base===BigInt(value.baseAmountMinor);
}
export function replacementLineageEvidenceMatches(proof:PaymentReplacementLineageEvidence,context:{patientId:number;originalPaymentId:number;sourceInvoiceId:number|null;targetInvoiceId:unknown}):boolean {
  return lineage(proof)&&proof.patientId===context.patientId&&proof.originalPaymentId===context.originalPaymentId
    &&proof.sourceInvoiceId===context.sourceInvoiceId&&proof.targetInvoiceId===context.targetInvoiceId;
}
