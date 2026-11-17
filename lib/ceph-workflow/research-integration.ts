/** Synthetic workflow -> ratio-only research report. Never a patient-plane adapter. */
import { CORE_LANDMARK_IDS, type SteinerCoreStudy } from '../ceph-core/steiner-core';
import { createResearchReport } from '../ceph-core/research-report';
import { captureResearchSnapshot, validPixel, SYNTHETIC_IMAGE, type ResearchSnapshot } from './research-workflow';

export function createSyntheticWorkflowReport(snapshot: ResearchSnapshot) {
  if (snapshot.imageId !== SYNTHETIC_IMAGE.id || snapshot.calibrationScope !== 'synthetic-only' || snapshot.clinicalUseAllowed !== false) {
    throw new Error('Only synthetic research snapshots are accepted.');
  }
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || !['left', 'right'].includes(snapshot.anterior ?? '')) {
    throw new Error('Invalid research revision or orientation.');
  }
  if (!snapshot.reference || !validPixel(snapshot.reference.start) || !validPixel(snapshot.reference.end)) {
    throw new Error('Invalid synthetic reference.');
  }
  if (Object.keys(snapshot.marks).length !== CORE_LANDMARK_IDS.length || CORE_LANDMARK_IDS.some(id => !snapshot.marks[id] || snapshot.marks[id]!.reviewed !== true || !validPixel(snapshot.marks[id]!))) {
    throw new Error('All synthetic points must be valid and reviewed.');
  }
  const verified = captureResearchSnapshot(snapshot);
  if (verified.mmPerPixel !== snapshot.mmPerPixel) throw new Error('Synthetic scale does not match its reference.');
  const study: SteinerCoreStudy = {
    revision: verified.revision,
    imageGeometryRevision: verified.revision,
    projection: 'lateral-2d',
    coordinateConvention: 'pixel-column-right-row-down',
    orientation: { anterior: verified.anterior! },
    // Isotropic synthetic coordinates establish aspect only, never physical patient distance.
    calibration: { kind: 'ratio-only', rowScale: 1, columnScale: 1, imageGeometryRevision: verified.revision },
    landmarks: CORE_LANDMARK_IDS.map(id => ({ id, column: verified.marks[id]!.column, row: verified.marks[id]!.row })),
  };
  return createResearchReport(study);
}
