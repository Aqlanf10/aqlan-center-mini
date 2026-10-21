import type { WrongCurrencyIntent } from './invoice-currency-intent';
import { isCurrency, type Currency } from './money';

export const UNPAID_CURRENCY_KIND = 'invoice-currency-correction' as const;
export interface UnpaidCurrencyRequest {
  version: 1; kind: typeof UNPAID_CURRENCY_KIND; evidenceKind: 'unpaid_root_v1';
  invoiceId: number; patientId: number; idempotencyKey: string; expectedSourceHash: string;
  discountReason: string; intent: WrongCurrencyIntent;
}
export interface UnpaidCurrencyAcknowledgement {
  version: 1; kind: typeof UNPAID_CURRENCY_KIND; evidenceKind: 'unpaid_root_v1';
  correctionId: number; patientId: number; currency: Currency; originalCurrency: Currency;
  idempotencyKey: string; requestHash: string; createdBy: string; actorUserId: number;
  effectiveAt: string; amountMode: WrongCurrencyIntent['mode']; settledMinor: 0;
  sourcePrincipalMinor: number; targetPrincipalMinor: number;
  original: { id: number; patientId: number; baseCurrency: Currency; invoiceNumber: string; createdAt: string };
  corrected: { id: number; patientId: number; baseCurrency: Currency; invoiceNumber: string; createdAt: string };
}
export class UnpaidCurrencyContractError extends Error {
  constructor() { super('إقرار تصحيح العملة أو طلبه غير مطابق؛ احتفظ بالطلب نفسه للمراجعة.'); }
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  && Reflect.ownKeys(v).every(k => typeof k === 'string' && Object.getOwnPropertyDescriptor(v,k)?.enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!, 'value'));
const keys = (v: Record<string,unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v,k));
const id = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const minor = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v,-0);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const time = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,23)===v.slice(0,23);
export function parseUnpaidCurrencyRequest(value: unknown): UnpaidCurrencyRequest {
  if (!record(value) || !keys(value,['version','kind','evidenceKind','invoiceId','patientId','idempotencyKey','expectedSourceHash','discountReason','intent'])
    || value.version !== 1 || value.kind !== UNPAID_CURRENCY_KIND || value.evidenceKind !== 'unpaid_root_v1'
    || !id(value.invoiceId) || !id(value.patientId) || !hash(value.expectedSourceHash)
    || typeof value.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value.idempotencyKey)
    || typeof value.discountReason !== 'string' || value.discountReason.length > 300 || !record(value.intent)
    || value.intent.version !== 1 || value.intent.purpose !== 'wrong-currency'
    || !isCurrency(value.intent.fromCurrency) || !isCurrency(value.intent.toCurrency)
    || value.intent.fromCurrency === value.intent.toCurrency
    || (value.intent.mode!=='preserve-numerals' && value.intent.mode!=='reviewed-target-amounts')
    || typeof value.intent.reason !== 'string' || value.intent.reason.trim().length < 3 || value.intent.reason.trim().length > 300)
    throw new UnpaidCurrencyContractError();
  const intent=value.intent;
  const shared=['version','purpose','fromCurrency','toCurrency','reason','mode'];
  if (!keys(intent,intent.mode==='preserve-numerals'?shared:[...shared,'lines','discount'])) throw new UnpaidCurrencyContractError();
  if (intent.mode==='reviewed-target-amounts') {
    if (!Array.isArray(intent.lines) || Object.getPrototypeOf(intent.lines)!==Array.prototype
      || intent.lines.length<1 || intent.lines.length>200 || Reflect.ownKeys(intent.lines).length!==intent.lines.length+1
      || typeof intent.discount!=='string' || intent.discount.length>128) throw new UnpaidCurrencyContractError();
    for (let i=0;i<intent.lines.length;i++) {
      const property=Object.getOwnPropertyDescriptor(intent.lines,String(i));
      if (!property?.enumerable || !Object.hasOwn(property,'value')) throw new UnpaidCurrencyContractError();
      const line=property.value;
      if (!record(line) || !keys(line,['itemId','unitPrice']) || !id(line.itemId)
        || typeof line.unitPrice!=='string' || line.unitPrice.length>128) throw new UnpaidCurrencyContractError();
    }
    if (new Set(intent.lines.map(line=>line.itemId)).size!==intent.lines.length) throw new UnpaidCurrencyContractError();
  }
  // Complete amount/identity validation is deliberately performed against the
  // fresh locked DB source, using evaluateWrongCurrencyAmounts, not this parser.
  return value as unknown as UnpaidCurrencyRequest;
}
/** New kind only: never upgrade a legacy unresolved command or reserialize its
 * payload. Store these exact bytes in the shared actor+patient unresolved slot. */
export function freezeUnpaidCurrencyRequest(value: unknown): string {
  const request = parseUnpaidCurrencyRequest(value);
  return JSON.stringify(request);
}
export function restoreUnpaidCurrencyRequest(body: string, patientId: number): UnpaidCurrencyRequest {
  const request = parseUnpaidCurrencyRequest(JSON.parse(body));
  if (request.patientId !== patientId || JSON.stringify(request) !== body) throw new UnpaidCurrencyContractError();
  return request;
}
export function parseUnpaidCurrencyAcknowledgement(value: unknown, expected: {
  request: UnpaidCurrencyRequest; requestHash: string; actorUserId: number; createdBy: string;
}): UnpaidCurrencyAcknowledgement {
  if (!record(value) || !keys(value,['version','kind','evidenceKind','correctionId','patientId','currency','originalCurrency','idempotencyKey','requestHash','createdBy','actorUserId','effectiveAt','amountMode','settledMinor','sourcePrincipalMinor','targetPrincipalMinor','original','corrected'])
    || value.version!==1 || value.kind!==UNPAID_CURRENCY_KIND || value.evidenceKind!=='unpaid_root_v1'
    || !id(value.correctionId) || value.patientId!==expected.request.patientId
    || value.currency!==expected.request.intent.toCurrency || value.originalCurrency!==expected.request.intent.fromCurrency
    || value.idempotencyKey!==expected.request.idempotencyKey || value.requestHash!==expected.requestHash
    || value.actorUserId!==expected.actorUserId || value.createdBy!==expected.createdBy
    || !time(value.effectiveAt) || value.amountMode!==expected.request.intent.mode || value.settledMinor!==0
    || !minor(value.sourcePrincipalMinor) || !minor(value.targetPrincipalMinor)) throw new UnpaidCurrencyContractError();
  for (const field of ['original','corrected'] as const) {
    const invoice=value[field];
    if (!record(invoice) || !keys(invoice,['id','patientId','baseCurrency','invoiceNumber','createdAt'])
      || !id(invoice.id) || invoice.patientId!==value.patientId || typeof invoice.invoiceNumber!=='string' || !invoice.invoiceNumber
      || !time(invoice.createdAt) || invoice.baseCurrency!==(field==='original'?value.originalCurrency:value.currency)
      || field==='original' && invoice.id!==expected.request.invoiceId
      || field==='corrected' && (invoice.id===expected.request.invoiceId || invoice.createdAt!==value.effectiveAt))
      throw new UnpaidCurrencyContractError();
  }
  return value as unknown as UnpaidCurrencyAcknowledgement;
}
