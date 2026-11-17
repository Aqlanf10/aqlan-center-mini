import { describe, expect, it } from 'vitest';
import { CORE_LANDMARK_IDS } from '../lib/ceph-core/steiner-core';
import { createSyntheticWorkflowReport } from '../lib/ceph-workflow/research-integration';
import { captureResearchSnapshot, newResearchDraft, setAnterior, setReference, setMark, reviewMark } from '../lib/ceph-workflow/research-workflow';
function snapshot(lengthMm = 10) {
  let draft = setReference(setAnterior(newResearchDraft(), 'right'), {start:{column:100,row:100},end:{column:200,row:100},lengthMm});
  const points = [[100,100],[200,100],[180,200],[190,250],[180,210],[160,140],[190,190],[170,220],[160,280],[180,230]];
  for (const [i,id] of CORE_LANDMARK_IDS.entries()) draft = reviewMark(setMark(draft,id,{column:points[i][0],row:points[i][1]}),id);
  return captureResearchSnapshot(draft);
}
describe('integrated synthetic workflow, verified engine and report', () => {
  it('computes angles while preserving the distance and clinical gates', () => {
    const report = createSyntheticWorkflowReport(snapshot());
    expect(report.analysisVersion).toBe('steiner-core-8/0.1.1-research');
    expect(report.calibration.kind).toBe('ratio-only');
    expect(report.rows.filter(r=>r.unit==='mm').every(r=>r.value===null && 'issue' in r && r.issue.code==='uncalibrated-patient-distance')).toBe(true);
    expect(report.rows.find(r=>r.id==='SNA')!.value).toBeCloseTo(78.69006752598,8);
    expect(report.clinicalUseAllowed).toBe(false);
    expect(report.diagnosticInterpretation).toBeNull();
  });
  it('does not turn synthetic mm into patient-plane calibration', () => {
    expect(createSyntheticWorkflowReport(snapshot(10))).toEqual(createSyntheticWorkflowReport(snapshot(50)));
  });
  it('does not mutate historical snapshots', () => {
    const s=snapshot(), before=JSON.stringify(s); createSyntheticWorkflowReport(s); expect(JSON.stringify(s)).toBe(before);
  });
  it('rejects unreviewed points, forged scale and a clinical flag', () => {
    const s=snapshot();
    expect(()=>createSyntheticWorkflowReport({...s,marks:{...s.marks,S:{...s.marks.S!,reviewed:false}}})).toThrow();
    expect(()=>createSyntheticWorkflowReport({...s,mmPerPixel:99})).toThrow();
    expect(()=>createSyntheticWorkflowReport({...s,clinicalUseAllowed:true as never})).toThrow();
  });
  it('rejects coordinates outside the synthetic image and invalid revisions', () => {
    const s=snapshot();
    expect(()=>createSyntheticWorkflowReport({...s,marks:{...s.marks,S:{...s.marks.S!,column:800}}})).toThrow();
    expect(()=>createSyntheticWorkflowReport({...s,revision:0})).toThrow();
  });
});
