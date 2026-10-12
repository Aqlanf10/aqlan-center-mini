import { isCurrency, type Currency } from "./money";
import { validateDebtRepaymentTerms, type DebtRepaymentTerms, type debtInstallmentProgress } from "./debt-installments";

export interface DebtRepaymentTarget { patientId:number;currency:Currency;invoiceId:number|null;openingCurrency:Currency|null }
export interface DebtRepaymentPosition {
  target:DebtRepaymentTarget;remainingMinor:number;collectedMinor:number;principalMinor:number;sourceHash:string;accountDueMinor:number;
}
export interface DebtRepaymentView extends DebtRepaymentPosition {
  id:number;version:number;status:"active"|"cancelled";terms:DebtRepaymentTerms;revisionPrincipalMinor:number;
  available:boolean;collectibleMinor:number;requiresReview:boolean;progress:ReturnType<typeof debtInstallmentProgress>|null;
  history:{version:number;status:"active"|"cancelled";terms:DebtRepaymentTerms;principal_minor:string;reason:string;created_by:string;created_at:string}[];
}
export interface DebtRepaymentChoice extends DebtRepaymentPosition { label:string;legacyActive:boolean;arrangementId:number|null;version:number }
export interface DebtRepaymentWorkspace {arrangements:DebtRepaymentView[];targets:DebtRepaymentChoice[]}
export const debtRecord=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const integer=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value);
const positive=(value:unknown):value is number=>integer(value)&&value>0;
function position(value:unknown,patientId:number):value is DebtRepaymentPosition {
  if(!debtRecord(value)||!debtRecord(value.target)||value.target.patientId!==patientId||!isCurrency(value.target.currency))return false;
  const target=value.target;
  return (positive(target.invoiceId)&&target.openingCurrency===null||target.invoiceId===null&&target.openingCurrency===target.currency)
    && [value.remainingMinor,value.collectedMinor,value.principalMinor,value.accountDueMinor].every(integer)
    && (value.remainingMinor as number)>=0&&(value.principalMinor as number)>=0
    && typeof value.sourceHash==="string"&&/^[a-f0-9]{64}$/.test(value.sourceHash);
}
export function readDebtRepaymentWorkspace(value:unknown,patientId:number):DebtRepaymentWorkspace|null {
  if(!debtRecord(value)||!Array.isArray(value.arrangements)||!Array.isArray(value.targets))return null;
  for(const row of value.arrangements){
    if(!position(row,patientId)||!debtRecord(row)||!positive(row.id)||!positive(row.version)||!["active","cancelled"].includes(String(row.status))
      ||!integer(row.revisionPrincipalMinor)||row.revisionPrincipalMinor<0||!validateDebtRepaymentTerms(row.terms,row.revisionPrincipalMinor).ok
      ||typeof row.available!=="boolean"||typeof row.requiresReview!=="boolean"||!integer(row.collectibleMinor)||row.collectibleMinor<0||!Array.isArray(row.history))return null;
    if(row.progress!==null){
      const progress=row.progress;
      if(!debtRecord(progress)||!Array.isArray(progress.rows)||![progress.overdueMinor,progress.unallocatedMinor,progress.settledSinceRevisionMinor,progress.currentRemainingMinor].every(integer)
        ||typeof progress.requiresRevision!=="boolean"||!progress.rows.every(item=>debtRecord(item)&&typeof item.dueDate==="string"&&[item.amountMinor,item.settledMinor,item.remainingMinor].every(integer)&&["installment","down_payment"].includes(String(item.kind))))return null;
    }
    if(!row.history.every(item=>debtRecord(item)&&positive(item.version)&&["active","cancelled"].includes(String(item.status))&&typeof item.principal_minor==="string"
      &&validateDebtRepaymentTerms(item.terms,Number(item.principal_minor)).ok&&typeof item.reason==="string"&&typeof item.created_by==="string"&&typeof item.created_at==="string"))return null;
  }
  if(!value.targets.every(row=>position(row,patientId)&&debtRecord(row)&&typeof row.label==="string"&&typeof row.legacyActive==="boolean"&&(row.arrangementId===null||positive(row.arrangementId))&&integer(row.version)&&row.version>=0))return null;
  return value as unknown as DebtRepaymentWorkspace;
}
