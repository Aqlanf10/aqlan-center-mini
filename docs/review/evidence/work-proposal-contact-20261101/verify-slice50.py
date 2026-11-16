import pathlib,json,hashlib,subprocess,sys
r=pathlib.Path(sys.argv[1]);base='b49e073b5b1e9d8a92f207c44f37d7512697b84a'
def old(p):return subprocess.check_output(['git','show',base+':'+p],cwd=r).decode()
def now(p):return (r/p).read_text()
a,b=old('lib/db.ts'),now('lib/db.ts');start='export async function recordProposalContact(input:'
legacy=a.split(start,1)[1].split('\n/**',1)[0];body=legacy.split('  return withTransaction(getPool(), async (client) => {\n',1)[1].rsplit('  });',1)[0];dedented=''.join(line[2:] if line.startswith('  ') else line for line in body.splitlines(True));new=b.split('export async function recordProposalContactInTransaction(',1)[1].split('\n/**',1)[0];newbody=new.split(' {\n  const { rows: [plan] }',1)[1].rsplit('}\n',1)[0];checks={'legacy_audit_writer_body':dedented=='  const { rows: [plan] }'+newbody,'db_prefix_before_contact':a.split(start,1)[0]==b.split(start,1)[0],'remaining_db_after_contact':a.split('export async function recordPlanInstallmentReminders(',1)[1]==b.split('export async function recordPlanInstallmentReminders(',1)[1]}
a,b=old('app/api/plans/proposals/route.ts'),now('app/api/plans/proposals/route.ts');checks['get_branch_unchanged']=a.split('export async function GET',1)[1].split('export async function POST',1)[0]==b.split('export async function GET',1)[1].split('export async function POST',1)[0];checks['legacy_post_body_unchanged']=a.split('export async function POST',1)[1].split('  const session = await requireSession();',1)[1]==b.split('export async function POST',1)[1].split('  const session = await requireSession();',1)[1]
for p in ['lib/staff-operation-runtime.ts','lib/staff-capability-catalogue.ts','lib/canonical-read-snapshot.ts','lib/canonical-proposals.ts','lib/canonical-proposal-projection.ts','lib/canonical-proposal-version.ts','lib/ortho-followup-coverage-db.ts','lib/consultation-followup.ts','lib/commission.ts','lib/fullBackup.ts','lib/restore/staging.ts','__tests__/postgres/consultation-followup.test.ts','__tests__/security-http/consultation-followup-http.test.ts']:
 checks[p]=old(p)==now(p)
checks['immutable_migrations']=not subprocess.check_output(['git','diff',base,'--','migrations'],cwd=r).strip();assert all(checks.values()),checks
historical=0
for p in (r/'docs/review/evidence').glob('**/manifest.json'):
 d=json.loads(p.read_text());rev=d.get('sourceRevision')
 if not rev:continue
 for f,h in (d.get('sourceSha256') or d.get('sourceFilesSha256') or {}).items():
  assert hashlib.sha256(subprocess.check_output(['git','show',rev+':'+f],cwd=r)).hexdigest()==h,(p,f);historical+=1
print(json.dumps({'baseRevision':base,'checks':checks,'passed':len(checks),'historicalSourceHashes':historical},indent=2))
