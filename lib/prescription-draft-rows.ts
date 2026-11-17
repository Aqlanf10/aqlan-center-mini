import { isDoseReferenceAcceptedForNewIssue } from './medication-dose-compatibility';
import { MAX_ITEMS, type RxItem } from './prescription';
/** Visible writing space, never a default medicine or clinical decision. */
export function blankPrescriptionRow(): RxItem {
 return {selection:{id:'manual',amount:'',confirmed:false},name:'',dose:'',form:'',frequency:'',duration:'',instructions:'',instructionsEn:''};
}
/** Replace only pristine manual placeholders, never incomplete authored clinical text. */
function pristineRowIndex(rows: RxItem[]): number {
 return rows.findIndex(row=>Object.keys(row).every(key=>['selection','name','dose','form','frequency','duration','instructions','instructionsEn'].includes(key))
  && ['name','dose','form','frequency','duration','instructions','instructionsEn'].every(key=>row[key as keyof RxItem]==='')
  && row.selection?.id==='manual' && row.selection.amount==='' && row.selection.confirmed===false
  && Object.keys(row.selection).every(key=>['id','amount','confirmed'].includes(key)));
}
export function canAcceptPrescriptionSelection(rows: RxItem[]): boolean {
 return rows.length<MAX_ITEMS || pristineRowIndex(rows)>=0;
}
export function appendPrescriptionSelection(rows: RxItem[], item: RxItem): RxItem[] {
 const index=pristineRowIndex(rows);
 if(index>=0)return rows.map((row,i)=>i===index?item:row);
 return rows.length<MAX_ITEMS?[...rows,item]:rows;
}
/** Explicit user recovery only: retain authored text, remove a retired source claim,
 * and require fresh row confirmation. Historical records never call this helper. */
export function retireDraftDoseReference(row: RxItem): RxItem {
 if(!row.selection?.doseReview || isDoseReferenceAcceptedForNewIssue(row.selection.doseReview.profileId,row.selection.doseReview.referenceVersion))return row;
 const {doseReview: _retired,...selection}=row.selection;
 return {...row,selection:{...selection,confirmed:false}};
}

/** Refuse a callback whose rendered row has since moved, been edited or replaced. */
export function retireDraftDoseReferenceAt(rows: RxItem[], index: number, renderedRow: RxItem): RxItem[] {
 if(rows[index]!==renderedRow)return rows;
 const retired=retireDraftDoseReference(renderedRow);
 return retired===renderedRow?rows:rows.map((row,i)=>i===index?retired:row);
}
