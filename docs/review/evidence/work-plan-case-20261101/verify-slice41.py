import hashlib, json, pathlib, re, subprocess
root = pathlib.Path('/workspace/aqlan-main-reconcile')
base = '15bacdb7a0b4de242b928545b72eb480b0212c39'
def old(path, rev=base):
    return subprocess.check_output(['git', 'show', f'{rev}:{path}'], cwd=root).decode()
def current(path): return (root/path).read_text()
checks = {}
before, after = old('lib/db.ts'), current('lib/db.ts')
start = 'export async function setPlanItemCase('
end = 'export async function addPlanItemDependencyInTransaction('
checks['db_prefix_unchanged'] = before.split(start)[0] == after.split('export interface SetPlanItemCaseInput')[0]
checks['db_suffix_unchanged'] = before.split(end)[1] == after.split(end)[1]
oldbody = before.split(start)[1].split('    const { rows: [owner] }')[1].split('    await client.query("COMMIT");')[0]
newbody = after.split('export async function setPlanItemCaseInTransaction')[1].split('  const { rows: [owner] }')[1].split('  return { ok: true };')[0]
oldbody = oldbody.replace('await client.query("ROLLBACK"); ', '')
# Only the transaction-owned rollback statements and leading indentation move.
norm = lambda x: '\n'.join(line.lstrip() for line in x.splitlines())
checks['writer_body_preserved_without_transaction_envelope'] = norm(oldbody) == norm(newbody)
route = 'app/api/plan-items/[id]/case/route.ts'
checks['legacy_route_tail_identical'] = old(route).split('  if (!itemId)')[1] == current(route).split('  if (!itemId)')[1]
for path in ['lib/commission.ts', 'lib/cases.ts', 'components/PatientCases.tsx', 'lib/canonical-case-reads.ts', 'lib/canonical-case-projection.ts', 'app/api/patients/[id]/cases/route.ts']:
    checks[path] = old(path) == current(path)
migrations = subprocess.check_output(['git','diff',base,'--','migrations'],cwd=root).decode()
checks['no_migration_changes'] = not migrations
hashes = 0
for manifest in sorted((root/'docs/review/evidence').glob('**/manifest.json')):
    data = json.loads(manifest.read_text())
    revision = data.get('sourceRevision')
    if not revision: continue
    for path, expected in (data.get('sourceSha256') or data.get('sourceFilesSha256') or {}).items():
        actual = hashlib.sha256(subprocess.check_output(['git','show',f'{revision}:{path}'],cwd=root)).hexdigest()
        assert actual == expected, (str(manifest),revision,path)
        hashes += 1
assert all(checks.values()), checks
result = {'baseRevision':base,'checks':checks,'passed':len(checks),'historicalSourceHashes':hashes}
pathlib.Path('/workspace/reviews/work-batch-20261101/slice41-source-proof.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'checks':len(checks),'historicalSourceHashes':hashes}))
