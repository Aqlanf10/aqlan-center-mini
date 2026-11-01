import hashlib, json, pathlib, subprocess
root=pathlib.Path('/workspace/aqlan-main-reconcile')
base='b21b151c504128f853f58059ddd3cf689e7f125b'
def old(path,rev=base): return subprocess.check_output(['git','show',f'{rev}:{path}'],cwd=root).decode()
def current(path): return (root/path).read_text()
before,after=old('lib/db.ts'),current('lib/db.ts')
start='export async function removePlanItemDependency(input: {'
end='// ─── (COMM-DETAIL-1)'
checks={
 'db_prefix_including_legacy_add_and_case_writers_unchanged':before.split(start)[0]==after.split('export interface RemovePlanDependencyInput')[0],
 'db_suffix_and_financial_engines_unchanged':before.split(end)[1]==after.split(end)[1],
}
body=before.split(start)[1].split('    const { rows }')[1].split('    await client.query("COMMIT");')[0]
body=body.replace('await client.query("ROLLBACK"); ','')
newbody=after.split('export async function removePlanItemDependencyInTransaction')[1].split('  const { rows }')[1].split('  return { ok: true };')[0]
norm=lambda s:'\n'.join(line.lstrip() for line in s.splitlines())
checks['delete_body_and_atomic_audit_preserved']=norm(body)==norm(newbody)
route='app/api/plan-items/[id]/dependencies/route.ts'
for method in ['POST','DELETE']:
 prior=old(route).split(f'export async function {method}')[1].split('  if (!itemId)')[1].split('export async function ')[0]
 now=current(route).split(f'export async function {method}')[1].split('  if (!itemId)')[1].split('export async function ')[0]
 checks[f'legacy_{method}_tail_identical']=prior==now
for path in ['lib/cases.ts','lib/commission.ts','lib/staff-operation-runtime.ts','lib/canonical-plan-case-command.ts','components/patient/CanonicalPlanCaseEditor.tsx','components/PatientCases.tsx','app/api/plan-items/[id]/case/route.ts']:
 checks[path]=old(path)==current(path)
checks['no_migration_changes']=not subprocess.check_output(['git','diff',base,'--','migrations'],cwd=root).strip()
hashes=0
for manifest in sorted((root/'docs/review/evidence').glob('**/manifest.json')):
 data=json.loads(manifest.read_text());revision=data.get('sourceRevision')
 if not revision:continue
 for path,expected in (data.get('sourceSha256') or data.get('sourceFilesSha256') or {}).items():
  actual=hashlib.sha256(subprocess.check_output(['git','show',f'{revision}:{path}'],cwd=root)).hexdigest()
  assert actual==expected,(str(manifest),revision,path)
  hashes+=1
assert all(checks.values()),checks
result={'baseRevision':base,'checks':checks,'passed':len(checks),'historicalSourceHashes':hashes}
pathlib.Path('/workspace/reviews/work-batch-20261101/slice42-source-proof.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'checks':len(checks),'historicalSourceHashes':hashes}))
