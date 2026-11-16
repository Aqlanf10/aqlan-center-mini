import pathlib,json,hashlib,subprocess,sys
r=pathlib.Path(sys.argv[1]);base='985352177f0d3a552bd1c6df4ec478cd8ea5c015'
def old(p):return subprocess.check_output(['git','show',base+':'+p],cwd=r).decode()
def now(p):return (r/p).read_text()
a,b=old('lib/db.ts'),now('lib/db.ts');anchor='export async function listPendingOrthoDecisions(';checks={'legacy_queue_and_decision_and_db_tail':a.split(anchor,1)[1]==b.split(anchor,1)[1],'db_prefix_before_bounded_reader':a.split(anchor,1)[0]==b.split('/** Already admitted, bounded pending-review summary.',1)[0]}
a,b=old('app/api/ortho/billing-decisions/route.ts'),now('app/api/ortho/billing-decisions/route.ts');checks['legacy_route_body_unchanged']=a.split('  const session = await requireSession();',1)[1]==b.split('  const session = await requireSession();',1)[1]
for p in ['lib/staff-operation-runtime.ts','lib/staff-capability-catalogue.ts','lib/canonical-read-snapshot.ts','lib/canonical-ortho-followups.ts','components/CanonicalOrthoFollowups.tsx','components/OrthoPendingDecisions.tsx','lib/canonical-proposals.ts','lib/canonical-proposal-contact-command.ts','lib/ortho-followup-coverage-db.ts','lib/commission.ts','lib/fullBackup.ts','lib/restore/staging.ts','app/api/ortho/adjustments/[id]/billing-decision/route.ts']:
 checks[p]=old(p)==now(p)
checks['immutable_migrations']=not subprocess.check_output(['git','diff',base,'--','migrations'],cwd=r).strip();assert all(checks.values()),checks
historical=0
for p in (r/'docs/review/evidence').glob('**/manifest.json'):
 d=json.loads(p.read_text());rev=d.get('sourceRevision')
 if not rev:continue
 for f,h in (d.get('sourceSha256') or d.get('sourceFilesSha256') or {}).items():
  assert hashlib.sha256(subprocess.check_output(['git','show',rev+':'+f],cwd=r)).hexdigest()==h,(p,f);historical+=1
print(json.dumps({'baseRevision':base,'checks':checks,'passed':len(checks),'historicalSourceHashes':historical},indent=2))
