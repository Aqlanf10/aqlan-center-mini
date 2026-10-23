"""Recompute nearest-rank percentiles; retain every recorded sample."""
import json, math
from pathlib import Path
raw = json.loads(Path(__file__).with_name('raw-samples.json').read_text())
for mode, versions in raw.items():
    for version, runs in versions.items():
        samples = sorted(t for run in runs for t in run['operations']['statement']['times'])
        errors = [e for run in runs for e in run['operations']['statement']['errors']]
        expected = 600 if mode == 'warm' else 52
        assert len(samples) == expected
        print(mode, version, json.dumps({'n': len(samples), 'errors': len(errors), **{
            f'p{int(p*100)}': samples[math.ceil(len(samples)*p)-1] for p in [.5,.95,.99]}}))
