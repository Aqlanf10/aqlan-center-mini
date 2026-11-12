import pathlib,json,hashlib,subprocess,sys
r=pathlib.Path(sys.argv[1]);base='f864e07c629c51ad411c50dc3f3554ec935f6878'
def old(p):return subprocess.check_output(['git','show',base+':'+p],cwd=r).decode()
def now(p):return (r/p).read_text()
a,b=old('lib/db.ts'),now('lib/db.ts');legacy='export async function listPendingProposals('
checks={'legacy_proposal_and_contact_and_db_tail':a.split(legacy,1)[1]==b.split(legacy,1)[1],'db_before_bounded_reader':a.split('/**\n * (P1-E) عروض العلاج',1)[0]==b.split('/**\n * (P1-E) عروض العلاج',1)[0]}
a,b=old('app/api/plans/proposals/route.ts'),now('app/api/plans/proposals/route.ts');checks['legacy_get_and_post_unchanged']=a.split('  const session = await requireSession();',1)[1]==b.split('  const session = await requireSession();',1)[1]
for p in ['lib/staff-operation-runtime.ts','lib/staff-capability-catalogue.ts','lib/canonical-read-snapshot.ts','lib/canonical-patient-reads.ts','lib/ortho-followup-coverage-db.ts','lib/consultation-followup.ts','lib/commission.ts','lib/fullBackup.ts','lib/restore/staging.ts','__tests__/postgres/consultation-followup.test.ts','__tests__/security-http/consultation-followup-http.test.ts','__tests__/reports-generated-time-route.test.ts']:
 checks[p]=old(p)==now(p)
checks['immutable_migrations']=not subprocess.check_output(['git','diff',base,'--','migrations'],cwd=r).strip()
assert all(checks.values()),checks
historical=0
for p in (r/'docs/review/evidence').glob('**/manifest.json'):
 d=json.loads(p.read_text());rev=d.get('sourceRevision')
 if not rev:continue
 for f,h in (d.get('sourceSha256') or d.get('sourceFilesSha256') or {}).items():
  assert hashlib.sha256(subprocess.check_output(['git','show',rev+':'+f],cwd=r)).hexdigest()==h,(p,f)
  historical+=1
print(json.dumps({'baseRevision':base,'checks':checks,'passed':len(checks),'historicalSourceHashes':historical},indent=2))
