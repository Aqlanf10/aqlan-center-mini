from pathlib import Path
import subprocess, hashlib, json

ROOT=Path(subprocess.check_output(['git','rev-parse','--show-toplevel']).decode().strip())
OUT=Path(__file__).resolve().parent
WORK='93b54b12069e927afa2e9969adc717b0d9c8ff00'
MAIN='6a6bdc0cc705874fd4ff6d0f0ddc3fdcd314e9e6'
def git(*args): return subprocess.check_output(['git', '-C', str(ROOT), *args])
def blob(rev,path): return git('show',rev+':'+path)
def sha(data): return hashlib.sha256(data).hexdigest()
def files(rev,path): return git('ls-tree','-r','--name-only',rev,'--',path).decode().splitlines()
checks=[]
assert not git('ls-files','-u').strip(), 'Unresolved merge index'
merge_head=subprocess.run(['git','-C',str(ROOT),'rev-parse','--verify','MERGE_HEAD'],capture_output=True,text=True)
if merge_head.returncode==0:
    assert merge_head.stdout.strip()==MAIN
else:
    assert subprocess.run(['git','-C',str(ROOT),'merge-base','--is-ancestor',MAIN,'HEAD']).returncode==0
conflicts=(OUT/'main-integration-conflicts.txt').read_text().splitlines()
for path in conflicts:
    if not path.strip(): continue
    data=(ROOT/path).read_bytes()
    assert not any(line.startswith((b'<<<<<<< ',b'>>>>>>> ')) for line in data.splitlines()),path
    checks.append({'file':path,'check':'resolved conflict markers absent','sha256':sha(data)})
work=set(files(WORK,'migrations')); main=set(files(MAIN,'migrations'))
work={p for p in work if p.endswith('.sql') and Path(p).parent==Path('migrations')}
main={p for p in main if p.endswith('.sql') and Path(p).parent==Path('migrations')}
current={str(p.relative_to(ROOT)) for p in (ROOT/'migrations').glob('*.sql')}
assert current==work|main
assert len(current)==71
migrations=[]
for path in sorted(current):
    data=(ROOT/path).read_bytes()
    for rev,paths in [(WORK,work),(MAIN,main)]:
        if path in paths: assert data==blob(rev,path),(rev,path)
    migrations.append({'file':path,'sha256':sha(data),'inWork':path in work,'inMain':path in main})
assert not any(Path(p).name.startswith(('0090','0091','0092','0093')) for p in current)
for path in files(WORK,'migrations/proposals'):
    assert (ROOT/path).read_bytes()==blob(WORK,path),path
    checks.append({'file':path,'check':'unactivated WORK proposal byte-identical','sha256':sha((ROOT/path).read_bytes())})
protected=[]
for path in files(WORK,'lib'):
    if Path(path).name.startswith(('canonical-','staff-')):
        assert (ROOT/path).read_bytes()==blob(WORK,path),path
        protected.append(path)
for path in ['app/api/display/route.ts','app/display/page.tsx','lib/patient-access.ts','lib/billing-classification.ts','package-lock.json']:
    assert (ROOT/path).read_bytes()==blob(WORK,path),path
    protected.append(path)
for path in protected:
    checks.append({'file':path,'check':'WORK protections byte-identical','sha256':sha((ROOT/path).read_bytes())})
for path in ['app/api/branding/login-photo/route.ts','app/api/settings/login-photo/route.ts','components/settings/LoginPhotoEditor.tsx','lib/restore/login-photo.ts']:
    assert (ROOT/path).read_bytes()==blob(MAIN,path),path
    checks.append({'file':path,'check':'reviewed main component byte-identical; no new canonical admission','sha256':sha((ROOT/path).read_bytes())})
a=json.loads(blob(WORK,'package.json'));b=json.loads((ROOT/'package.json').read_text())
for key in ['dependencies','devDependencies','overrides','engines']:
    assert a[key]==b[key],key
history=[]
for manifest in sorted((ROOT/'docs/review/evidence').glob('work-*/manifest.json')):
    value=json.loads(manifest.read_text());rev=value.get('sourceRevision')
    hashes=value.get('sourceSha256',value.get('sourceFilesSha256',{}))
    if not rev or not hashes: continue
    for path,digest in hashes.items():
        assert sha(blob(rev,path))==digest,(str(manifest),rev,path)
        history.append({'manifest':str(manifest.relative_to(ROOT)),'revision':rev,'file':path,'sha256':digest})
mapping=json.loads((ROOT/'docs/security/staff-cutover/M2_ROUTE_CAPABILITY_MAP.json').read_text())
counts={s:sum(e['status']==s for e in mapping) for s in sorted({e['status'] for e in mapping})}
assert counts['canonical-done']==59 and counts['existing']==285 and counts['owner-only']==23
result={'workParent':WORK,'mainParent':MAIN,'checks':checks,'migrations':migrations,
        'sharedMigrations':len(work&main),'historicalSourceHashes':history,'mapCounts':counts,
        'limits':['Static preservation witnesses are not runtime acceptance.','No new migration allocation or pending M4 activation.','Docker remains blocked by enforced Alpine network policy.']}
(OUT/'main-integration-source-proof.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'sourceChecks':len(checks),'immutableMigrations':len(migrations),'sharedMigrations':len(work&main),'historicalSourceHashes':len(history),'mapCounts':counts}))
