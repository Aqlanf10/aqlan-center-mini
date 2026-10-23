import subprocess
from pathlib import Path
p=Path('/workspace/statement-performance-evidence');node='/workspace/.cloud-tools/node_modules/node/bin/node';roots={'control':'/workspace/finance-synthetic-verification','opt':'/workspace/statement-read-efficiency'}

for i in range(12,52):
 for v in ['control','opt'] if i%2==0 else ['opt','control']:
  root=roots[v];env={'PATH':'/workspace/.cloud-tools/node_modules/node/bin:/usr/bin:/bin','HOME':'/tmp','NODE_ENV':'test','SKIP_SEED':'true','DB_POOL_MAX':'5','CLINIC_TIME_ZONE':'Asia/Aden','SESSION_SECRET':'synthetic-perf-only-0123456789abcdef','DATABASE_URL':f'postgresql://ci:ci@127.0.0.1:55449/perf_candidate_statement_cold_{v}?sslmode=disable'}
  with open(p/f'cold-{v}-{i}.log','w')as f:subprocess.run([node,'--import',root+'/node_modules/tsx/dist/loader.mjs','/workspace/perf-upgrade-evidence/bench.mts',root,'candidate','cold',str(p/f'cold-{v}-{i}.json'),'statement'],cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,check=True,timeout=60)
 print('cold pair',i,'complete',flush=True)
