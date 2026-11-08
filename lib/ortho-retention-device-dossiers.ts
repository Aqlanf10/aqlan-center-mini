import type {RetentionLedgerRead,RetentionRevision} from './ortho-retention-client';
import type {RetentionDeviceProjection} from './ortho-retention-event-history';
import {readSavedRetentionLedgerContext} from './ortho-retention-saved-context';
export interface RetentionDeviceDossier {
 device:RetentionDeviceProjection;previousDeviceId:number|null;nextDeviceId:number|null;
 events:{revision:RetentionRevision;current:boolean;relation:'delivery'|'device_reference'|'replacement_out'}[];
 sourceMatches:RetentionLedgerRead['sourceMatches'];
}
export type SavedRetentionDeviceDossiers={ok:true;scope:RetentionLedgerRead['scope'];actorId:number;headId:number|null;headVersion:number|null;headHash:string|null;unassignedEntryIds:number[];devices:RetentionDeviceDossier[]}|{ok:false;code:'retention_device_history_invalid'};
/** Documentary navigation only. Full verified case history is validated once,
 * then associated solely by correction roots and explicit saved device IDs.
 * No arch/date/text matching, filtered-history re-projection or recall engine.
 * A replacement is delivery for its new root AND outgoing evidence for its old
 * root. All correction versions stay visible, ordered by case version. */
export function buildSavedRetentionDeviceDossiers(data:RetentionLedgerRead):SavedRetentionDeviceDossiers{
 const invalid:SavedRetentionDeviceDossiers={ok:false,code:'retention_device_history_invalid'};
 try{
  const context=readSavedRetentionLedgerContext(data);if(!context)return invalid;
  const devices:RetentionDeviceDossier[]=context.projection.devices.map(device=>({device:structuredClone(device),previousDeviceId:device.replacedDeviceId,nextDeviceId:null,events:[],sourceMatches:[]}));
  const byDevice=new Map(devices.map(d=>[d.device.deviceId,d]));
  for(const d of devices)if(d.previousDeviceId!==null){const previous=byDevice.get(d.previousDeviceId);if(!previous||previous.nextDeviceId!==null)return invalid;previous.nextDeviceId=d.device.deviceId;}
  const currentIds=new Set(context.projection.currentEvents.map(r=>r.id));
  const sources=new Map<number,RetentionLedgerRead['sourceMatches']>();
  for(const source of context.binding.sourceMatches){const group=sources.get(source.entryId)??[];group.push(source);sources.set(source.entryId,group);}
  const roots=new Map<number,number>(),unassignedEntryIds:number[]=[];
  for(const revision of [...data.history].reverse()){
   const content=revision.content,event=content.payload,root=content.supersedesEntryId===null?revision.id:roots.get(content.supersedesEntryId);
   if(root===undefined)return invalid;roots.set(revision.id,root);
   const memberships:{id:number;relation:RetentionDeviceDossier['events'][number]['relation']}[]=[];
   if(event.kind==='device_delivery'||event.kind==='device_replacement')memberships.push({id:root,relation:'delivery'});
   if(event.kind==='device_replacement')memberships.push({id:event.replaces.deviceId,relation:'replacement_out'});
   else if('device' in event&&event.device)memberships.push({id:event.device.deviceId,relation:'device_reference'});
   if(!memberships.length)unassignedEntryIds.push(revision.id);
   for(const member of memberships){const dossier=byDevice.get(member.id);if(!dossier)return invalid;dossier.events.push({revision:structuredClone(revision),current:currentIds.has(revision.id),relation:member.relation});dossier.sourceMatches.push(...(sources.get(revision.id)??[]).map(source=>({...source})));}
  }
  return {ok:true,scope:context.binding.scope,actorId:context.binding.actorId,headId:context.binding.headId,headVersion:context.binding.headVersion,headHash:context.binding.headHash,unassignedEntryIds,devices};
 }catch{return invalid;}
}
