/** Literal presentation of two already decoded, currently authorized case entries.
 * Case binding here is not new server authority or cryptographic verification.
 * Entries may be partial and patient-wide version numbers need not be adjacent. */
export interface DiagnosisComparisonEntry {
  id:number; version:number; orthoCaseId:number; content:Record<string,string|null>;
  label:string|null; createdBy:string; createdAt:string;
}
export type DiagnosisComparisonCell = {state:'absent'} | {state:'null'} | {state:'empty'} | {state:'text';value:string};
export type DiagnosisPairComparison = {ok:false;code:'invalid_diagnosis_comparison'} | {
  ok:true; orthoCaseId:number; left:DiagnosisComparisonEntry; right:DiagnosisComparisonEntry;
  fields:{key:string;left:DiagnosisComparisonCell;right:DiagnosisComparisonCell;comparison:'same'|'different'}[];
};
const validId=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
function validEntry(value:unknown,caseId:number):value is DiagnosisComparisonEntry {
  if(!plain(value)||!validId(value.id)||!validId(value.version)||value.orthoCaseId!==caseId
    ||(value.label!==null&&typeof value.label!=='string')||typeof value.createdBy!=='string'
    ||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||!plain(value.content)) return false;
  // Own enumerable data properties only. Never interpret prototypes as findings.
  return Reflect.ownKeys(value.content).every(key=>{
    if(typeof key!=='string')return false;
    const descriptor=Object.getOwnPropertyDescriptor(value.content,key)!;
    return descriptor.enumerable&&Object.hasOwn(descriptor,'value')&&(descriptor.value===null||typeof descriptor.value==='string');
  });
}
function cell(content:Record<string,string|null>,key:string):DiagnosisComparisonCell {
  if(!Object.hasOwn(content,key))return {state:'absent'};
  const value=content[key];
  return value===null?{state:'null'}:value===''?{state:'empty'}:{state:'text',value};
}
function detached(entry:DiagnosisComparisonEntry):DiagnosisComparisonEntry {
  // JSON.parse preserves '__proto__' as an ordinary own key, not a setter.
  return {id:entry.id,version:entry.version,orthoCaseId:entry.orthoCaseId,label:entry.label,
    createdBy:entry.createdBy,createdAt:entry.createdAt,content:JSON.parse(JSON.stringify(entry.content))};
}
export function compareSavedDiagnoses(history:readonly DiagnosisComparisonEntry[], expected:{orthoCaseId:number;leftId:number;rightId:number}):DiagnosisPairComparison {
  const invalid:DiagnosisPairComparison={ok:false,code:'invalid_diagnosis_comparison'};
  try {
    if(!expected||![expected.orthoCaseId,expected.leftId,expected.rightId].every(validId)||expected.leftId===expected.rightId||!Array.isArray(history))return invalid;
    const ids=new Set<number>();
    for(const row of history){if(!validEntry(row,expected.orthoCaseId)||ids.has(row.id))return invalid;ids.add(row.id);}
    const left=history.find(row=>row.id===expected.leftId),right=history.find(row=>row.id===expected.rightId);
    if(!left||!right)return invalid;
    const keys=[...new Set([...Object.keys(left.content),...Object.keys(right.content)])].sort();
    return {ok:true,orthoCaseId:expected.orthoCaseId,left:detached(left),right:detached(right),fields:keys.map(key=>{
      const a=cell(left.content,key),b=cell(right.content,key);
      const same=a.state===b.state&&(a.state!=='text'||b.state==='text'&&a.value===b.value);
      return {key,left:a,right:b,comparison:same?'same':'different'};
    })};
  }catch{return invalid;}
}
