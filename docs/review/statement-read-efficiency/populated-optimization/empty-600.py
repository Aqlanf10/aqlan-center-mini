import subprocess,json
from pathlib import Path
p=Path('/workspace/statement-performance-evidence/v2/empty');node='/workspace/.cloud-tools/node_modules/node/bin/node'
roots={'control':'/workspace/finance-synthetic-verification','opt':'/workspace/statement-read-efficiency'}
for block,order in enumerate([['control','opt'],['opt','control'],['control','opt']]):
 for variant in order:
  name=f'perf_candidate_statement_v2_{variant}{block}';subprocess.run(['docker','exec','aqlan-perf-synthetic-20261023','createdb','-U','ci','-T','perf_candidate_seed',name],check=True)
  root=roots[variant];env={'PATH':'/workspace/.cloud-tools/node_modules/node/bin:/usr/bin:/bin','HOME':'/tmp','NODE_ENV':'test','SKIP_SEED':'true','DB_POOL_MAX':'5','CLINIC_TIME_ZONE':'Asia/Aden','SESSION_SECRET':'synthetic-perf-only-0123456789abcdef','DATABASE_URL':f'postgresql://ci:ci@127.0.0.1:55449/{name}?sslmode=disable'}
  label=f'warm-{variant}-{block}'
  with open(p/(label+'.log'),'w') as f:
   subprocess.run([node,'--import',root+'/node_modules/tsx/dist/loader.mjs','/workspace/perf-upgrade-evidence/bench.mts',root,'candidate','warm',str(p/(label+'.json')),'statement',str(block*1000)],cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,check=True,timeout=180)
  print(label,'complete',flush=True)
