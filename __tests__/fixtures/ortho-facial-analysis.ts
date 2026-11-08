import { createHash } from 'node:crypto';
import { blankFacialContent, type FacialContent, type FacialLandmark } from '../../lib/ortho-facial-analysis';
/** Independently authored analytic diagram, not a patient image or clinical norm.
 * Binary-grid units make normalization exact. Vertical thirds are 3*192 px;
 * horizontal fifths are 5*128 px; lower-third divisions are 64 and 128 px.
 * The digest is a generated test descriptor marker, not a real-image claim. */
export function syntheticFace(): FacialContent {
  const side = 1024, unit = side / 16, center = side / 2;
  const sha256 = createHash('sha256').update('SYNTHETIC FACIAL GRID V1; NO PATIENT IMAGE').digest('hex');
  const content = blankFacialContent({ sha256, width: side, height: side, exifOrientation: 1 });
  content.occurrence.sourceNote = 'SYNTHETIC ANALYTIC GRID; NOT A PATIENT OBSERVATION';
  const pixels: Record<FacialLandmark, [number, number]> = {
    axisTop: [center, unit], axisBottom: [center, 15 * unit],
    tr: [center, 2 * unit], gl: [center, 5 * unit],
    sn: [center, 8 * unit], me: [center, 11 * unit], sto: [center, 9 * unit],
    paImageLeft: [3 * unit, 5 * unit], exImageLeft: [5 * unit, 5 * unit],
    enImageLeft: [7 * unit, 5 * unit], enImageRight: [9 * unit, 5 * unit],
    exImageRight: [11 * unit, 5 * unit], paImageRight: [13 * unit, 5 * unit],
  };
  for (const [key, [x, y]] of Object.entries(pixels))
    content.landmarks[key as FacialLandmark] = { state: 'located', x: x / side, y: y / side };
  return content;
}
