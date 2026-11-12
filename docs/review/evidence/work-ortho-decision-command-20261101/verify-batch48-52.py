from pathlib import Path
import subprocess,hashlib,json
r=Path('/workspace/aqlan-next-clinical');e=Path('/workspace/reviews/work-batch-20261101');count=0
for p in (r/'docs/review/evidence').glob('**/manifest.json'):
 d=json.loads(p.read_text());rev=d.get('sourceRevision')
 if not rev:continue
 for path,h in (d.get('sourceSha256') or d.get('sourceFilesSha256') or {}).items():
  actual=hashlib.sha256(subprocess.check_output(['git','show',rev+':'+path],cwd=r)).hexdigest();assert actual==h,(str(p),rev,path);count+=1
freeze=json.loads((e/'slice52-source-freeze.json').read_text());frozen=0
for path,h in freeze['sha256'].items():assert hashlib.sha256((r/path).read_bytes()).hexdigest()==h,path;frozen+=1
changed=subprocess.check_output(['git','diff','014c6ae0456794335b15c5a471ee049584ba7d97','--name-only'],cwd=r).decode().splitlines()
assert [p for p in changed if not p.startswith('docs/')]==['__tests__/security-http/canonical-ortho-decisions-journey.test.ts'],changed
sensitive=['migrations','schema','Dockerfile','.github/workflows','package.json','package-lock.json','lib/ceph.ts','lib/commission.ts','lib/fullBackup.ts','lib/restore/staging.ts']
assert not subprocess.check_output(['git','diff','327b12fba84049e2b0f5e4e65fbd48445da42386','--',*sensitive],cwd=r).strip(),'unrelated protected source changed'
result={'publishedBase':'327b12fba84049e2b0f5e4e65fbd48445da42386','productSource':'014c6ae0456794335b15c5a471ee049584ba7d97','testOnlyRevision':'a3812c1127e41ab60a57754c0e3912f8dbff9316','historicalPinnedSourceHashes':count,'frozenFinalInputs':frozen,'onlyLaterNonDocumentationChange':'read-only principal exact403 HTTP assertion','protectedSourceUnchanged':sensitive}
(e/'batch48-52-source-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
