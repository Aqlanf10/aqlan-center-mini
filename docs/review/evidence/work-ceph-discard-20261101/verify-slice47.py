import hashlib, json, pathlib, subprocess, sys
root=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve()
base='01a75969c19cdc3b935c6237ce80570077ab2c9d'
def old(path,rev=base): return subprocess.check_output(['git','show',f'{rev}:{path}'],cwd=root).decode()
def now(path): return (root/path).read_text()
a,b=old('lib/db.ts'),now('lib/db.ts')
start='export async function discardCephAnalysis('
end='\n/**\n * نسخةٌ جديدة عن تحليل معتمد'
original=a.split(start,1)[1].split(end,1)[0]
body='    const { rows }'+original.split('    const { rows }',1)[1].split('    await client.query("COMMIT");',1)[0]
body=body.replace('await client.query("ROLLBACK"); ','').replace('      await client.query("ROLLBACK");\n','')
extracted='  const { rows }'+b.split('export async function discardCephAnalysisInTransaction',1)[1].split('  const { rows }',1)[1].split('  return { ok: true };',1)[0]
norm=lambda s:'\n'.join(line.strip() for line in s.strip().splitlines())
checks={'original_draft_only_sql_and_note_rules':norm(body)==norm(extracted),'db_prefix_unchanged':a.split(start,1)[0]==b.split('/** Original draft-only status/note rule',1)[0],'db_suffix_and_correction_copy_unchanged':a.split(end,1)[1]==b.split(end,1)[1]}
wrapper=b.split(start,1)[1].split(end,1)[0]
checks['legacy_post_commit_audit_unchanged']=original.split('    await client.query("COMMIT");',1)[1].split('  } finally',1)[0]==wrapper.split('    await client.query("COMMIT");',1)[1].split('  } catch (error)',1)[0]
checks['failed_rollback_discards_lease']='catch { discardLease = true; }' in wrapper and 'client.release(discardLease)' in wrapper
route='app/api/ceph/[id]/route.ts'
checks['legacy_delete_tail_unchanged']=old(route).split('export async function DELETE',1)[1].split('  const session = await requireSession();',1)[1]==now(route).split('export async function DELETE',1)[1].split('  const session = await requireSession();',1)[1]
checks['get_and_patch_route_bodies_unchanged']=old(route).split('export async function GET',1)[1].split('export async function DELETE',1)[0]==now(route).split('export async function GET',1)[1].split('export async function DELETE',1)[0]
reads=now('lib/canonical-ceph-reads.ts').replace('import { cephDraftVersionWith } from "./canonical-ceph-draft-version";\n','').replace('...(analysis.status==="draft"?{discardVersion:await cephDraftVersionWith(q,studyId)}:{}),','')
checks['accepted_reader_changes_only_draft_observation']=old('lib/canonical-ceph-reads.ts')==reads
for path in ['lib/staff-operation-runtime.ts','lib/staff-capability-catalogue.ts','lib/canonical-record-reads.ts','lib/canonical-read-snapshot.ts','lib/canonical-ceph-copy-command.ts','lib/canonical-ceph-pair-reads.ts','lib/canonical-patient-reads.ts','lib/canonical-problem-create-command.ts','lib/canonical-plan-dependency-command.ts','lib/commission.ts','components/PatientCeph.tsx','components/CephTracer.tsx','components/CephCompareView.tsx','app/ceph/[id]/page.tsx','app/print/ceph/[id]/page.tsx']:
 checks[path]=old(path)==now(path)
checks['immutable_migrations']=not subprocess.check_output(['git','diff',base,'--','migrations'],cwd=root).strip()
assert all(checks.values()),checks
historical=0
for manifest in (root/'docs/review/evidence').glob('**/manifest.json'):
 data=json.loads(manifest.read_text());revision=data.get('sourceRevision')
 if not revision:continue
 for path,expected in (data.get('sourceSha256') or data.get('sourceFilesSha256') or {}).items():
  actual=hashlib.sha256(subprocess.check_output(['git','show',f'{revision}:{path}'],cwd=root)).hexdigest()
  assert actual==expected,(str(manifest),revision,path)
  historical+=1
print(json.dumps({'baseRevision':base,'checks':checks,'passed':len(checks),'historicalSourceHashes':historical},indent=2))
