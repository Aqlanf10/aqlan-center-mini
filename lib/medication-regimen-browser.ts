import { DOSE_REFERENCES } from './medication-dose-profiles';

/** Display taxonomy only: filters never infer patient eligibility or choose a dose. */
export const REGIMEN_GROUP_LABELS:Readonly<Record<string,string>>=Object.freeze({analgesic:'مسكنات الألم',antibiotic:'مضادات بكتيرية — باستطباب',antiseptic:'مطهرات الفم',antifungal:'مضادات الفطريات','local-analgesic':'تسكين موضعي','caries-prevention':'الوقاية بالفلورايد'});
const names:Readonly<Record<string,string>>={paracetamol:'باراسيتامول أسيتامينوفين',ibuprofen:'إيبوبروفين بروفين',amoxicillin:'أموكسيسيلين',penicillin:'بنسلين في فينوكسي ميثيل بنسلين',metronidazole:'ميترونيدازول',coamoxiclav:'أموكسيسيلين كلافولانات كو أموكسيكلاف',azithromycin:'أزيثروميسين',clarithromycin:'كلاريثروميسين',chlorhexidine:'كلورهكسيدين',nystatin:'نيستاتين',miconazole:'ميكونازول',fluconazole:'فلوكونازول',benzydamine:'بنزيدامين',fluoride:'فلورايد'};
const adultOnly=new Set(['paracetamol-adult-sdcep','ibuprofen-adult-sdcep','amoxicillin-adult-ada','coamoxiclav-adult-ada-escalation','azithromycin-adult-ada']);
const childOnly=new Set(['paracetamol-child-aapd','paracetamol-adolescent-sdcep','ibuprofen-child-sdcep','amoxicillin-child-aapd-q8','amoxicillin-child-aapd-q12','coamoxiclav-child-label-q12','azithromycin-child-aapd']);
const bothPopulations=new Set(['amoxicillin-sdcep','penicillin-v-sdcep','metronidazole-sdcep','clarithromycin-sdcep','chlorhexidine-02-label','nystatin-sdcep-label','miconazole-oralgel-label','fluconazole-sdcep','benzydamine-rinse-label','fluoride-toothpaste2800','fluoride-toothpaste5000','fluoride-rinse005']);
const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').trim();
export function filterDoseReferences(query:string,group:string,population:string){
 if(group!=='all'&&!(group in REGIMEN_GROUP_LABELS)||!['all','adult','child'].includes(population))return [];
 const term=normalize(query);
 return DOSE_REFERENCES.filter(p=>(group==='all'||p.class_group===group)
  &&(population==='all'||population==='adult'&&(adultOnly.has(p.id)||bothPopulations.has(p.id))||population==='child'&&(childOnly.has(p.id)||bothPopulations.has(p.id)))
  &&normalize(`${p.generic_name} ${p.id} ${names[p.id.split('-')[0]]??''} ${p.indication_reference}`).includes(term));
}
