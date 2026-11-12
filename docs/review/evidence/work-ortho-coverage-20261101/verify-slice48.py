import hashlib,json,pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1]).resolve();base='327b12fba84049e2b0f5e4e65fbd48445da42386'
def old(p):return subprocess.check_output(['git','show',f'{base}:{p}'],cwd=root).decode()
def now(p):return (root/p).read_text()
a,b=old('lib/ortho-followup-coverage-db.ts'),now('lib/ortho-followup-coverage-db.ts')
original_sql=a.split('async function sourceRows(',1)[1].split('`',1)[1].split('`,[caseId,patientId]);',1)[0]
new_sql=b.split('const FOLLOWUP_SOURCE_SQL = `',1)[1].split('`;\nasync function sourceRows',1)[0]
checks={'original_commercial_source_sql':original_sql==new_sql,'original_site_validation':a.split('  return rows.map',1)[1].split('\nconst matches=',1)[0]==b.split('  return rows.map',1)[1].split('\nconst matches=',1)[0],
'writer_and_receipt_and_signed_proof_tail_unchanged':a.split('type CoverageCommandInput=',1)[1]==b.split('type CoverageCommandInput=',1)[1],
'legacy_read_body_unchanged':a.split('export async function readFollowupCoverage(',1)[1].split('\ntype CoverageCommandInput=',1)[0]==b.split('export async function readFollowupCoverage(',1)[1].split('\n/** Already admitted caller',1)[0],
'original_fingerprint_and_lineage_helpers':a.split('const matches=',1)[1].split('export async function readFollowupCoverage(',1)[0]==b.split('const matches=',1)[1].split('export async function readFollowupCoverage(',1)[0]}
p='app/api/ortho/[id]/followup-coverage/route.ts';a,b=old(p),now(p)
checks['legacy_get_tail_and_post_put_unchanged']=a.split('  try{const a=await admit(request,context);',1)[1]==b.split('  try{const a=await admit(request,context);',1)[1]
checks['legacy_admission_unchanged']=a.split('async function admit(',1)[1].split('export async function GET',1)[0]==b.split('async function admit(',1)[1].split('export async function GET',1)[0]
for p in ['lib/db.ts','lib/staff-operation-runtime.ts','lib/staff-capability-catalogue.ts','lib/canonical-read-snapshot.ts','lib/canonical-patient-reads.ts','lib/canonical-ortho-strategy.ts','lib/canonical-ortho-assessment.ts','lib/canonical-ceph-discard-command.ts','lib/ortho-followup-coverage.ts','lib/ortho-followup-coverage-schema.ts','lib/commission.ts','lib/fullBackup.ts','lib/restore/staging.ts']:
 checks[p]=old(p)==now(p)
checks['immutable_migrations']=not subprocess.check_output(['git','diff',base,'--','migrations'],cwd=root).strip()
assert all(checks.values()),checks
historical=0
for manifest in (root/'docs/review/evidence').glob('**/manifest.json'):
 data=json.loads(manifest.read_text());revision=data.get('sourceRevision')
 if not revision:continue
 for p,expected in (data.get('sourceSha256') or data.get('sourceFilesSha256') or {}).items():
  assert hashlib.sha256(subprocess.check_output(['git','show',f'{revision}:{p}'],cwd=root)).hexdigest()==expected,(manifest,p)
  historical+=1
print(json.dumps({'baseRevision':base,'checks':checks,'passed':len(checks),'historicalSourceHashes':historical},indent=2))
