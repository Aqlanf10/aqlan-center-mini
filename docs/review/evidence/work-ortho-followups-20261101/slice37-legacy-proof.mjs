import fs from 'node:fs';
import cp from 'node:child_process';
import crypto from 'node:crypto';
const base='e718e9f7fcc8eead9301ad4e8d7f6b7e3776791a';
const old=p=>cp.execFileSync('git',['show',base+':'+p],{encoding:'utf8',maxBuffer:8*1024*1024});
const hash=s=>crypto.createHash('sha256').update(s).digest('hex'); const checks=[];
for(const [file,marker] of [['app/api/ortho/followups/route.ts','  const session = await requireSession();'],['app/ortho/page.tsx','  const fallbackToday = useMemo(']]){
 const before=old(file),after=fs.readFileSync(file,'utf8'); const a=before.slice(before.indexOf(marker)),b=after.slice(after.indexOf(marker));
 if(a!==b)throw Error('legacy body changed: '+file);checks.push({file,part:'legacy body suffix',sha256:hash(a),unchanged:true});
}
const file='lib/db.ts',current=fs.readFileSync(file,'utf8');const start=current.indexOf('/** Slice 37: scope before'),end=current.indexOf('/** M2 slice 30.',start);
if(start<0||end<0||current.slice(0,start)+current.slice(end)!==old(file))throw Error('db changed beyond exact identifier helper');
checks.push({file,allowedDifference:'only new listOrthoFollowupCaseIdsWith; all prior db readers and writers byte-identical',beforeSha256:hash(old(file)),afterSha256:hash(current),additionSha256:hash(current.slice(start,end))});
for(const file of ['lib/ortho-followup.ts','lib/ortho-followup-board.ts','lib/ortho-followup-booking-context.ts','lib/canonical-read-snapshot.ts','lib/staff-authority-proof-internal.ts','lib/staff-capability-catalogue.ts','lib/staff-operation-runtime.ts','lib/canonical-appointments.ts','lib/canonical-patient-reads.ts','lib/canonical-ortho-assessment.ts','lib/ortho-assessment-store.ts','lib/ortho-assessment-versioned-sources.ts','lib/canonical-plan-reads.ts','lib/canonical-plan-projection.ts','lib/canonical-ceph-reads.ts','lib/plan-payment-projection.ts','lib/approved-agreements.ts','lib/hr-payroll.ts','lib/ortho-followup-coverage-db.ts']){
 const before=old(file),after=fs.readFileSync(file,'utf8');if(before!==after)throw Error('protected file changed: '+file);checks.push({file,sha256:hash(after),unchanged:true});
}
for(const [file,addition] of [['lib/canonical-record-reads.ts','  /** GET /api/ortho/followups: clinical follow-up; appointment facts separately scoped. */\n  "read:ortho.followups": Object.freeze({ record: "patient", need: Object.freeze(["clinical.ortho.view"] as const), anyOf: Object.freeze([]) }),\n'],['lib/canonical-navigation.ts',' { href: "/ortho", label: "متابعة التقويم", anyOf: ["clinical.ortho.view"], record: "patient", exact: true, description: "حالات المتابعة ضمن نطاق مرضاك؛ تفاصيل المواعيد حسب نطاق مواعيدك المستقل." },\n']]){
 const after=fs.readFileSync(file,'utf8');if(after.replace(addition,'')!==old(file))throw Error('registry changed beyond bounded addition: '+file);checks.push({file,allowedDifference:'one exact entry',beforeSha256:hash(old(file)),afterSha256:hash(after)});
}
console.log(JSON.stringify({base,checks},null,2));
