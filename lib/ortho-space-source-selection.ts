import type {SpacePlan} from './ortho-space-ledger';
/** A replay may repeat a historical plan. Resource admission counts distinct
 * versioned sources, not the extra command being re-presented for recovery. */
export function selectSpaceBaselineRefs(plans:readonly SpacePlan[]){
 return [...new Map(plans.map(p=>[JSON.stringify([p.baseline.kind,p.baseline.id,p.baseline.member,p.baseline.version]),{...p.baseline}])).values()];
}
