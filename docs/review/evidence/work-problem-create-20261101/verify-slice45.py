import hashlib,json,pathlib,subprocess
root=pathlib.Path('/workspace/aqlan-main-reconcile');base='db16763d61a58289f62ffce54f44b35300afdbf1'
def old(path,rev=base):return subprocess.check_output(['git','show',f'{rev}:{path}'],cwd=root).decode()
def current(path):return (root/path).read_text()
before,after=old('lib/db.ts'),current('lib/db.ts')
checks={'db_prefix_case_status_and_responsibility_unchanged':before.split('export async function createPatientProblem(input: ProblemDraft & {')[0]==after.split('export interface CreatePatientProblemInput')[0],
 'db_suffix_problem_status_finance_dependency_writers_unchanged':before.split('export async function getPatientProblemOwner')[1]==after.split('export async function getPatientProblemOwner')[1]}
body=before.split('export async function createPatientProblem(input: ProblemDraft & {')[1].split('    const { rows: patient }')[1].split('    await client.query("COMMIT");')[0].replace('await client.query("ROLLBACK"); ','')
newbody=after.split('export async function createPatientProblemInTransaction')[1].split('  const { rows: patient }')[1].split('  return { ok: true, problemId: created.id };')[0]
norm=lambda s:'\n'.join(line.lstrip() for line in s.splitlines())
checks['exact_original_create_and_audit_body']=norm(body)==norm(newbody)
route='app/api/patients/[id]/problems/route.ts';checks['legacy_post_tail_identical']=old(route).split('export async function POST')[1].split('  if (!patientId)')[1]==current(route).split('export async function POST')[1].split('  if (!patientId)')[1]
checks['existing_get_identical']=old(route).split('export async function GET')[1].split('export async function POST')[0]==current(route).split('export async function GET')[1].split('export async function POST')[0]
for path in ['lib/cases.ts','lib/commission.ts','lib/initial-responsibility-authority.ts','lib/patient-responsibility-settings.ts','lib/staff-operation-runtime.ts','lib/canonical-case-reads.ts','lib/canonical-case-projection.ts','lib/canonical-problem-status-command.ts','lib/canonical-problem-status-version.ts','lib/canonical-case-status-command.ts','lib/canonical-case-status-version.ts','lib/canonical-plan-case-command.ts','lib/canonical-plan-dependency-command.ts','lib/canonical-plan-dependency-version.ts','components/PatientCases.tsx']:
 checks[path]=old(path)==current(path)
patient_before=old('lib/canonical-patient-reads.ts').replace('  listPatientProblemsWith, listPatientVisitsWith,','  listPatientVisitsWith,').replace('type DbClient, type PatientListRow,','type DbClient, type PatientListRow, type PatientProblem,')
patient_after=current('lib/canonical-patient-reads.ts')
checks['patient_reads_only_import_and_problem_projection_changed']=patient_before.split('export async function readCanonicalProblems')[0]==patient_after.split('export async function readCanonicalProblems')[0] and patient_before.split('/** Timeline event groups')[1]==patient_after.split('/** Timeline event groups')[1]
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
pathlib.Path('/workspace/reviews/work-batch-20261101/slice45-source-proof.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'checks':len(checks),'historicalSourceHashes':hashes}))
