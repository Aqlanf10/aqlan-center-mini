import type { RxItem } from './prescription';
export const MEDICATION_CATALOG_KEY = 'clinical.medication_catalog' as const;
export interface CatalogMedication {
  id: string; revision: number; enabled: boolean;
  name: string; arabicName: string; form: string; strength: string;
  population: 'adult' | 'child' | 'both';
  amount: string; frequency: string; duration: string;
  instructionsAr: string; instructionsEn: string;
  indication: string; cautions: string; sourceUrl: string;
}
export interface MedicationCatalog { schemaVersion: 1; entries: CatalogMedication[] }
export const EMPTY_MEDICATION_CATALOG = '{"schemaVersion":1,"entries":[]}';
export const validCatalogId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const fields = ['id','revision','enabled','name','arabicName','form','strength','population','amount','frequency','duration','instructionsAr','instructionsEn','indication','cautions','sourceUrl'].sort();
const strings = ['name','arabicName','form','strength','amount','frequency','duration','instructionsAr','instructionsEn','indication','cautions','sourceUrl'] as const;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const reject = () => ({ok:false as const, message:'دليل الأدوية غير صالح؛ راجع الحقول والهوية والإصدار وحدود الحجم.'});
/** No clinical approval or executable dose profile can be supplied by this JSON. */
export function parseMedicationCatalog(raw: string): {ok:true; value:MedicationCatalog} | {ok:false;message:string} {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 40000) return reject();
  let value: unknown; try { value = JSON.parse(raw); } catch { return reject(); }
  if (!record(value) || Object.keys(value).sort().join() !== 'entries,schemaVersion' || value.schemaVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > 60) return reject();
  const ids = new Set<string>(); const entries: CatalogMedication[] = [];
  for (const e of value.entries) {
    if (!record(e) || Object.keys(e).sort().join() !== fields.join() || !validCatalogId(e.id) || ids.has(e.id)
      || !Number.isSafeInteger(e.revision) || (e.revision as number) < 1 || typeof e.enabled !== 'boolean'
      || !['adult','child','both'].includes(String(e.population))) return reject();
    for (const key of strings) {
      const s=e[key], limit=['instructionsAr','instructionsEn','cautions'].includes(key)?1000:200;
      // eslint-disable-next-line no-control-regex
      if (typeof s !== 'string' || s !== s.trim() || s.length > limit || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(s)) return reject();
    }
    if (!(e.name as string).length || !/[A-Za-z]/.test(e.name as string) || !e.form || !e.strength || !e.indication) return reject();
    if (e.sourceUrl) { try { const url=new URL(e.sourceUrl as string); if(url.protocol!=='https:' || url.username || url.password) return reject(); } catch {return reject();} }
    ids.add(e.id); entries.push({...e} as unknown as CatalogMedication);
  }
  return {ok:true,value:{schemaVersion:1,entries}};
}
/** Preserve identifiers: removal is disabling, not deletion. Every edit increments revision. */
export function catalogTransitionProblem(before:MedicationCatalog, after:MedicationCatalog): string|null {
  for (const old of before.entries) {
    const next=after.entries.find(e=>e.id===old.id);
    if (!next) return 'عطّل الدواء بدل حذفه للحفاظ على هويته وسجل تعديلاته.';
    const changed=fields.filter(k=>k!=='revision').some(k=>old[k as keyof CatalogMedication]!==next[k as keyof CatalogMedication]);
    if(next.revision !== old.revision + (changed?1:0)) return 'إصدار الدواء غير مطابق؛ حدّث الدليل ثم أعد المحاولة.';
  }
  if(after.entries.some(e=>!before.entries.some(old=>old.id===e.id)&&e.revision!==1)) return 'الدواء الجديد يبدأ بالإصدار الأول.';
  return null;
}
export function catalogMedicationToDraft(e:CatalogMedication): RxItem|null {
  if(!e.enabled) return null;
  return {name:e.name,dose:e.strength,form:e.form,frequency:e.frequency,duration:e.duration,instructions:e.instructionsAr,instructionsEn:e.instructionsEn,
    selection:{id:'manual',amount:e.amount,confirmed:false,catalog:{id:e.id,revision:e.revision}}};
}
/** New issuance only. History/replay must continue using the immutable saved snapshot. */
export function catalogSelectionProblem(items: readonly RxItem[], catalog:MedicationCatalog):string|null {
  for(const item of items) {
    const ref=item.selection?.catalog; if(!ref) continue;
    const e=catalog.entries.find(e=>e.id===ref.id);
    if(!e || !e.enabled || e.revision!==ref.revision) return 'تغيّر دواء مختار من الدليل أو عُطّل؛ أعد اختياره وراجع الجرعة قبل الإصدار.';
  }
  return null;
}
