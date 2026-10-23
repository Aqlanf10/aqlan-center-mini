import subprocess,json
from pathlib import Path
p=Path('/workspace/statement-performance-evidence/v2')
node='/workspace/.cloud-tools/node_modules/node/bin/node'
roots={'control':'/workspace/finance-synthetic-verification','opt':'/workspace/statement-read-efficiency'}
for block,order in enumerate([['control','opt'],['opt','control'],['control','opt']]):
 for v in order:
  root=roots[v];label=f'warm-{v}-{block}'
  env={'PATH':str(Path(node).parent)+':/usr/bin:/bin','HOME':'/tmp','NODE_ENV':'test','SKIP_SEED':'true','DB_POOL_MAX':'5','CLINIC_TIME_ZONE':'Asia/Aden','SESSION_SECRET':'synthetic-perf-only-0123456789abcdef','DATABASE_URL':'postgresql://ci:ci@127.0.0.1:55449/aqlan_populated_scale_test?sslmode=disable'}
  with open(p/(label+'.log'),'w')as f:subprocess.run([node,'--import',root+'/node_modules/tsx/dist/loader.mjs',str(p/'paired-read.mts'),root,str(p/(label+'.json'))],cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,check=True,timeout=180)
  print(label,'complete',flush=True)
for i in range(12):
 for v in ['control','opt'] if i%2==0 else ['opt','control']:
  root=roots[v];label=f'cold-{v}-{i}'
  env={'PATH':str(Path(node).parent)+':/usr/bin:/bin','HOME':'/tmp','NODE_ENV':'test','SKIP_SEED':'true','DB_POOL_MAX':'5','CLINIC_TIME_ZONE':'Asia/Aden','SESSION_SECRET':'synthetic-perf-only-0123456789abcdef','DATABASE_URL':'postgresql://ci:ci@127.0.0.1:55449/aqlan_populated_scale_test?sslmode=disable'}
  with open(p/(label+'.log'),'w')as f:subprocess.run([node,'--import',root+'/node_modules/tsx/dist/loader.mjs',str(p/'paired-read.mts'),root,str(p/(label+'.json')),'cold','20'],cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,check=True,timeout=60)
 print('cold pair',i,'complete',flush=True)
