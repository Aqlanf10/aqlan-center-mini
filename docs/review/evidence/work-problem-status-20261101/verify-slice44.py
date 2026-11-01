import hashlib,json,pathlib,subprocess
root=pathlib.Path('/workspace/aqlan-next-clinical');base='f28cc7ce69f887b6b75e7848a64086090b70bd40'
def old(path,rev=base):return subprocess.check_output(['git','show',f'{rev}:{path}'],cwd=root).decode()
def current(path):return (root/path).read_text()
before,after=old('lib/db.ts'),current('lib/db.ts')
checks={'db_prefix_and_creation_case_status_authority_unchanged':before.split('export async function changePatientProblemStatus(input: {')[0]==after.split('export interface ChangePatientProblemStatusInput')[0],
 'db_suffix_finance_dependency_writers_unchanged':before.split('/** بنود خطط المريض')[1]==after.split('/** بنود خطط المريض')[1]}
body=before.split('export async function changePatientProblemStatus(input: {')[1].split('    const { rows }')[1].split('    await client.query("COMMIT");')[0].replace('await client.query("ROLLBACK"); ','')
newbody=after.split('export async function changePatientProblemStatusInTransaction')[1].split('  const { rows }')[1].split('  return { ok: true };')[0]
norm=lambda s:'\n'.join(line.lstrip() for line in s.splitlines())
checks['exact_original_transition_and_audit_body']=norm(body)==norm(newbody)
route='app/api/problems/[id]/route.ts';checks['legacy_route_tail_identical']=old(route).split('  if (!id)')[1]==current(route).split('  if (!id)')[1]
for path in ['lib/cases.ts','lib/commission.ts','lib/initial-responsibility-authority.ts','lib/patient-responsibility-settings.ts','lib/canonical-case-status-command.ts','lib/canonical-case-status-version.ts','lib/canonical-plan-case-command.ts','lib/canonical-plan-dependency-command.ts','lib/canonical-plan-dependency-version.ts','components/PatientCases.tsx']:
 checks[path]=old(path)==current(path)
checks['runtime_adds_only_mapped_document_action']=old('lib/staff-operation-runtime.ts')==current('lib/staff-operation-runtime.ts').replace(', \"clinical.visits.document\"]',']').replace(',\"clinical.visits.document\"]',']')
checks['no_migration_changes']=not subprocess.check_output(['git','diff',base,'--','migrations'],cwd=root).strip()
hashes=0
for p in sorted((root/'docs/review/evidence').glob('**/manifest.json')):
 j=json.loads(p.read_text());revision=j.get('sourceRevision')
 if not revision:continue
 for path,expected in (j.get('sourceSha256') or j.get('sourceFilesSha256') or {}).items():
  assert hashlib.sha256(subprocess.check_output(['git','show',f'{revision}:{path}'],cwd=root)).hexdigest()==expected,(str(p),revision,path)
  hashes+=1
assert all(checks.values()),checks
result={'baseRevision':base,'checks':checks,'passed':len(checks),'historicalSourceHashes':hashes}
pathlib.Path('/workspace/reviews/work-batch-20261101/slice44-source-proof.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'checks':len(checks),'historicalSourceHashes':hashes}))
