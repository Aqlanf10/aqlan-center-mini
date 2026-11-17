import baseline from './medication-dose-legacy-baseline.json';
import {doseReference,doseCalculationRule,DOSE_REFERENCE_VERSION,DOSE_REFERENCE_SOURCES,DOSE_REFERENCE_WARNINGS} from './medication-dose-profiles';
/** Frozen PR518 evidence. Do not regenerate automatically when clinical semantics
 * change: remove the affected allowance or independently review a new contract. */
export const LEGACY_DOSE_REFERENCE_VERSION='2026-11-01.expansion.1';
export const LEGACY_DOSE_PROFILE_IDS=Object.freeze(['paracetamol-adult-sdcep','paracetamol-child-aapd','ibuprofen-adult-sdcep','ibuprofen-child-sdcep','amoxicillin-child-aapd-q8','amoxicillin-child-aapd-q12'] as const);
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export function equalDoseClinicalContract(expected:unknown,actual:unknown):boolean{return canonical(expected)===canonical(actual);}
/** Preserve every age-to-rule association, not merely the set of rule values. */
export function doseRuleRanges(resolve:(month:number)=>unknown){
 const ranges:Array<{fromMonth:number;toMonth:number;rule:unknown}>=[];
 for(let month=0;month<=1440;month++){
  const rule=resolve(month)??null,last=ranges.at(-1);
  if(last&&equalDoseClinicalContract(last.rule,rule))last.toMonth=month;
  else ranges.push({fromMonth:month,toMonth:month,rule});
 }
 return ranges;
}
function currentContract(id:string){
 const profile=doseReference(id);if(!profile)return null;
 return {profile,sources:profile.source_ids.map(id=>DOSE_REFERENCE_SOURCES.find(source=>source.id===id)),warnings:profile.warning_ids.map(id=>({id,value:DOSE_REFERENCE_WARNINGS[id as keyof typeof DOSE_REFERENCE_WARNINGS]})),defaultRule:doseCalculationRule(id)??null,ruleRanges:doseRuleRanges(month=>doseCalculationRule(id,month))};
}
// Evaluated from shipped static data/rules at module initialization, never from
// user fields or settings. Numerical/parser/projection semantics are additionally
// pinned by regression tests; this source/rule guard does not replace those tests.
const equivalentIds=new Set(baseline.entries.filter(entry=>baseline.referenceVersion===LEGACY_DOSE_REFERENCE_VERSION&&(LEGACY_DOSE_PROFILE_IDS as readonly string[]).includes(entry.profile.id)&&equalDoseClinicalContract(entry,currentContract(entry.profile.id))).map(entry=>entry.profile.id));
export function isLegacyDoseReferenceCompatible(profileId:string,referenceVersion:string):boolean {
 return referenceVersion===LEGACY_DOSE_REFERENCE_VERSION&&equivalentIds.has(profileId);
}
export function isDoseReferenceAcceptedForNewIssue(profileId:string,referenceVersion:string):boolean {
 return !!doseReference(profileId)&&(referenceVersion===DOSE_REFERENCE_VERSION||isLegacyDoseReferenceCompatible(profileId,referenceVersion));
}
