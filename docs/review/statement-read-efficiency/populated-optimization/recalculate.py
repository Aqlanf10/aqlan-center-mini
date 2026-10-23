import json,math,hashlib
from pathlib import Path
p=Path(__file__).parent
raw=json.loads((p/'raw-samples.json').read_text())
def stats(times,errors):
 t=sorted(times)
 return {'n':len(t),'errors':len(errors),**{f'p{int(q*100)}':t[math.ceil(len(t)*q)-1]for q in [.5,.95,.99]},'max':max(t)}
summary={}
for label,versions in raw.items():
 groups=[1,5,20]if label=='populatedWarm'else [20]if label=='populatedCold'else [1]if label=='smallWarm'else [None]
 summary[label]={}
 for group in groups:
  entry={}
  for v,runs in versions.items():
   rows=[r['operations']['statement']if group is None else next(x for x in r['results']if x['groups']==group)for r in runs]
   entry[v]=stats([t for r in rows for t in r['times']],[e for r in rows for e in r['errors']])
  entry['delta']={key:{'ms':entry['opt'][key]-entry['control'][key],'percent':100*(entry['opt'][key]/entry['control'][key]-1)}for key in ['p50','p95','p99']}
  summary[label][str(group*2 if group else 'fiveDraft')]=entry
summary['allEmptyCombined']={v:stats([t for label in ['emptyWarm','emptyRepeat']for r in raw[label][v]for t in r['operations']['statement']['times']],[e for label in ['emptyWarm','emptyRepeat']for r in raw[label][v]for e in r['operations']['statement']['errors']])for v in ['control','opt']}
assert summary==json.loads((p/'summary.json').read_text()), 'summary differs from complete raw samples'
for label,groups in summary.items():
 if label=='allEmptyCombined':print(label,groups);continue
 for group,x in groups.items():print(label,group,[(v,x[v]['n'],*[round(x[v][k],3)for k in ['p50','p95','p99']])for v in ['control','opt']])
