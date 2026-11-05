import { describe, expect, it } from 'vitest';
import {
  angleBetween, cephHandedness, computeAll, computeMmPerPixel, enrichWithRefs, getClinicalInterpretation,
  MEASUREMENTS, measure, missingFor, pixelsToMm, projectOnLine,
  type LandmarkCode, type LandmarkMap, type Pt,
} from '../lib/ceph';
import { comparable, compareAnalyses } from '../lib/cephCompare';
import { superimposeOnSN } from '../lib/cephSuperimpose';

// Synthetic, anatomically ordered fixtures. Expectations come from explicit
// angles/dot products, not from the implementation or population means.
const radians = (degrees: number) => degrees * Math.PI / 180;
const direction = (degrees: number, length: number): Pt =>
  ({ x: length * Math.cos(radians(degrees)), y: length * Math.sin(radians(degrees)) });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const fixture: LandmarkMap = {
  S: { x: 0, y: 100 }, N: { x: 100, y: 100 },
  A: add({ x: 100, y: 100 }, direction(98, 60)),
  B: add({ x: 100, y: 100 }, direction(100, 90)),
  Po: { x: 0, y: 120 }, Or: { x: 60, y: 120 },
  Go: { x: 0, y: 200 }, Me: add({ x: 0, y: 200 }, direction(25, 100)),
  Gn: add({ x: 0, y: 200 }, direction(20, 100)),
  U1A: { x: 70, y: 150 }, U1: add({ x: 70, y: 150 }, direction(65, 40)),
  L1A: { x: 75, y: 230 }, L1: add({ x: 75, y: 230 }, direction(-60, 40)),
  OcclP: { x: 0, y: 170 }, OcclA: { x: 100, y: 170 },
  Pog: { x: 95, y: 230 }, D: { x: 90, y: 235 }, Co: { x: -10, y: 155 },
  PNS: { x: 0, y: 160 }, ANS: { x: 70, y: 150 },
  Prn: { x: 115, y: 140 }, Sn: { x: 105, y: 160 }, Ls: { x: 110, y: 170 },
  Li: { x: 108, y: 195 }, PogS: { x: 100, y: 235 },
  Ar: { x: -15, y: 165 }, Ba: { x: -15, y: 145 },
};
const kim: LandmarkMap = {
  S: { x: 0, y: -20 }, N: { x: 100, y: -20 },
  Po: { x: 0, y: 0 }, Or: { x: 100, y: 0 },
  A: { x: 80, y: 40 }, B: { x: 80, y: 100 },
  Go: { x: 0, y: 100 }, Me: { x: 100, y: 100 },
  PNS: { x: 0, y: 30 }, ANS: { x: 100, y: 20 },
};
const m = (code: string, points = fixture, scale = 0.1) => measure(code, points, scale);
const row = (code: string, points = fixture) => computeAll(points, 0.1).find(r => r.code === code)!;
const transform = (points: LandmarkMap, degrees: number, scale: number, mirror: boolean): LandmarkMap =>
  Object.fromEntries(Object.entries(points).map(([code, p]) => {
    const x = (mirror ? -1 : 1) * p!.x;
    const y = p!.y;
    return [code, {
      x: 350 + scale * (x * Math.cos(radians(degrees)) - y * Math.sin(radians(degrees))),
      y: 700 + scale * (x * Math.sin(radians(degrees)) + y * Math.cos(radians(degrees))),
    }];
  }));

describe('independently derived clinical wedges', () => {
  it.each([125, 130, 70])('INTER retains the anatomically ordered %d degree wedge', expected => {
    const points = { ...fixture, U1: add(fixture.U1A!, direction(65, 40)),
      L1: add(fixture.L1A!, direction(65 - expected, 40)) };
    expect(m('INTER', points)).toBeCloseTo(expected, 9);
  });
  it('preserves independently correct FMA/IMPA/FMIA', () => {
    expect(m('FMA')).toBeCloseTo(25, 9);
    expect(m('IMPA')).toBeCloseTo(95, 9);
    expect(m('FMIA')).toBeCloseTo(60, 9);
  });
  it('SN-GoGn depends on Gn, not Me, including dependency metadata', () => {
    expect(m('SNGOGN')).toBeCloseTo(20, 9);
    expect(m('SNGOGN', { ...fixture, Me: { x: 999, y: 999 } })).toBeCloseTo(20, 9);
    expect(m('SNGOGN', { ...fixture, Gn: add(fixture.Go!, direction(35, 100)) })).toBeCloseTo(35, 9);
    expect(m('SNGOGN', { ...fixture, Me: undefined })).toBeCloseTo(20, 9);
    expect(m('SNGOGN', { ...fixture, Gn: undefined })).toBeNaN();
    expect(missingFor('SNGOGN', { ...fixture, Gn: undefined, Me: undefined })).toEqual(['Gn']);
  });
  it.each([-20, 0, 20])('WITS signed separation %d pixels is valid, including zero', dx => {
    const points = { A: { x: 100 + dx, y: 100 }, B: { x: 100, y: 200 },
      OcclP: { x: 0, y: 150 }, OcclA: { x: 200, y: 150 } };
    for (const rotation of [-180, -90, -20, 0, 90, 180]) {
      for (const mirror of [false, true]) {
        expect(m('WITS', transform(points, rotation, 2, mirror), 0.05)).toBeCloseTo(dx * 0.1, 9);
      }
    }
  });
  it.each([-10, 0, 10])('Kim signed palatal slope %d pixels propagates to ODI/APDI/CF', dy => {
    const points = { ...kim, ANS: { x: 100, y: 30 + dy } };
    const tilt = Math.atan2(dy, 100) * 180 / Math.PI;
    expect(m('PP_FH', points)).toBeCloseTo(tilt, 9);
    expect(m('ODI', points)).toBeCloseTo(90 + tilt, 9);
    expect(m('APDI', points)).toBeCloseTo(90 + tilt, 9);
    expect(m('CF', points)).toBeCloseTo(180 + 2 * tilt, 9);
  });
  it.each([-10, 10])('posterior APDI/FH_AB keeps the correct Class-II/III direction (%d)', dx => {
    const points = { ...kim, ANS: { x: 100, y: 30 }, B: { x: 80 + dx, y: 100 } };
    const expected = 90 + Math.atan2(dx, 60) * 180 / Math.PI;
    expect(m('APDI', points)).toBeCloseTo(expected, 9);
    expect(m('FH_AB', points)).toBeCloseTo(expected, 9);
  });
  it('direct APDI does not need FH or orientation anchors', () => {
    const points = { A: kim.A, B: kim.B, ANS: kim.ANS, PNS: kim.PNS };
    expect(m('APDI', points)).toBeCloseTo(90 - Math.atan(0.1) * 180 / Math.PI, 9);
    expect(missingFor('APDI', points)).toEqual([]);
  });
  it.each(['APDI', 'ODI', 'CF'])('%s is unavailable for every absent true dependency', code => {
    const def = MEASUREMENTS.find(d => d.code === code)!;
    expect(def.needs).toContain('ANS');
    expect(def.needs).toContain('PNS');
    for (const missing of def.needs) {
      const points = { ...fixture, [missing]: undefined };
      expect(m(code, points), missing).toBeNaN();
      expect(missingFor(code, points)).toContain(missing);
      expect(row(code, points)).toMatchObject({ value: null, display: '—', status: null });
    }
  });
  it('does not publish an unvalidated extraction-index formula or recommendation', () => {
    expect(m('EXT_INDEX')).toBeNaN();
    expect(row('EXT_INDEX')).toMatchObject({ value: null, display: '—', status: null });
    expect(getClinicalInterpretation('EXT_INDEX', 140).en).not.toMatch(/recommend|indicated|extraction/i);
  });
});

describe('finite and nondegenerate geometry', () => {
  it.each([
    ['AB_PLANE', 'A', 'B'], ['AB_PLANE', 'N', 'Pog'], ['SNA', 'S', 'N'],
    ['PP_FH', 'Po', 'Or'], ['PP_FH', 'ANS', 'PNS'], ['APDI', 'A', 'B'],
    ['APDI', 'ANS', 'PNS'], ['ODI', 'Go', 'Me'], ['INTER', 'U1A', 'U1'],
    ['INTER', 'L1A', 'L1'], ['WITS', 'OcclP', 'OcclA'],
  ])('%s rejects coincident %s/%s reference points', (code, a, b) => {
    expect(m(code, { ...fixture, [b]: fixture[a as LandmarkCode] })).toBeNaN();
  });
  it.each([Infinity, -Infinity, NaN])('no measurement accepts nonfinite required coordinates (%s)', value => {
    for (const def of MEASUREMENTS) {
      for (const code of def.needs) {
        expect(m(def.code, { ...fixture, [code]: { x: value, y: 100 } }), `${def.code}/${code}`).toBeNaN();
      }
    }
  });
  it.each(['OVERJET', 'OVERBITE'])('%s rejects a finite-input overflowing reference length', code => {
    expect(m(code, { ...fixture, OcclP: { x: -6.5e307, y: -6.5e307 },
      OcclA: { x: 6.5e307, y: 6.5e307 } })).toBeNaN();
  });
  it('zero-length projections are undefined, not fabricated endpoints', () => {
    const p = projectOnLine({ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 3, y: 4 });
    expect(Number.isFinite(p.x) || Number.isFinite(p.y)).toBe(false);
  });
  it('handles finite large/small direction vectors without overflow or underflow', () => {
    for (const magnitude of [1e-200, 1e200]) {
      expect(angleBetween({ x: magnitude, y: 0 }, { x: 0, y: magnitude })).toBeCloseTo(90, 9);
      expect(angleBetween({ x: magnitude, y: magnitude }, { x: magnitude, y: magnitude })).toBe(0);
    }
  });
  it('calibration rejects invalid endpoints and finite-input underflow/overflow', () => {
    expect(computeMmPerPixel({ x: 0, y: 0 }, { x: Infinity, y: 0 }, 50)).toBeNaN();
    expect(computeMmPerPixel({ x: 0, y: 0 }, { x: 1e200, y: 0 }, 1e-200)).toBeNaN();
    expect(computeMmPerPixel({ x: 0, y: 0 }, { x: 1e-200, y: 0 }, 1e200)).toBeNaN();
    for (const scale of [0, -1, Infinity, NaN]) expect(pixelsToMm(100, scale)).toBeNaN();
    expect(pixelsToMm(1e200, 1e200)).toBeNaN();
    expect(pixelsToMm(1e-200, 1e-200)).toBeNaN();
    expect(pixelsToMm(0, 0.1)).toBe(0);
  });
});

describe('anatomical orientation and downstream consistency', () => {
  it('all supported results survive full rotations, reflection, translation and calibration scaling', () => {
    for (const rotation of [-180, -90, -10, 0, 45, 90, 180]) {
      for (const scale of [0.25, 1, 4]) for (const mirror of [false, true]) {
        const points = transform(fixture, rotation, scale, mirror);
        for (const def of MEASUREMENTS) {
          const expected = m(def.code);
          const actual = m(def.code, points, 0.1 / scale);
          if (Number.isNaN(expected)) expect(actual, def.code).toBeNaN();
          else expect(actual, `${def.code}/${rotation}/${scale}/${mirror}`).toBeCloseTo(expected, 8);
        }
        const cp1 = transform({ A: { x: 20, y: 40 }, B: { x: 320, y: 440 } }, rotation, scale, mirror);
        expect(computeMmPerPixel(cp1.A!, cp1.B!, 50)).toBeCloseTo(0.1 / scale, 9);
      }
    }
  });
  it.each(['CONV', 'CONV_ANGLE', 'AB_PLANE', 'U1NA_D', 'L1NB_D', 'POG_NB_D',
    'U1_APOG', 'E_LINE_UL', 'E_LINE_LL', 'OVERBITE', 'PP_FH', 'ODI', 'CF'])('%s fails closed without a defined anatomical frame', code => {
    for (const points of [
      { ...fixture, S: undefined }, { ...fixture, N: undefined }, { ...fixture, Me: undefined },
      { ...fixture, S: fixture.N }, { ...fixture, Me: fixture.N },
      { ...fixture, Me: { x: 200, y: 100 } },
    ]) expect(m(code, points)).toBeNaN();
  });
  it('collinear orientation anchors remain unavailable after rotation and reflection', () => {
    const points = { ...fixture, S: { x: 10, y: 10 }, N: { x: 20, y: 20 }, Me: { x: 30, y: 30 } };
    for (const degrees of [-137, -83, -19, 0, 47, 101, 179]) for (const mirrored of [false, true]) {
      expect(cephHandedness(transform(points, degrees, 1, mirrored))).toBeNull();
    }
  });
  it('historical finite extraction indexes cannot re-enter graded comparisons', () => {
    const historic = { ...row('EXT_INDEX'), value: 140 };
    expect(comparable(historic)).toBeNull();
    const raw = { code: 'EXT_INDEX', name: 'Extraction Index', value: 140, mean: 153.8, unit: '' };
    expect(compareAnalyses([raw], [{ ...raw, value: 160 }]).measurements).toEqual([]);
  });
  it('serialized landmarks recompute the same live, rounded, reference and comparison values', () => {
    const original = computeAll(fixture, 0.1);
    const reloaded = computeAll(JSON.parse(JSON.stringify(fixture)), 0.1);
    expect(reloaded).toEqual(original);
    expect(row('INTER').value).toBe(125);
    expect(row('SNGOGN').value).toBe(20);
    expect(enrichWithRefs(reloaded, null).map(r => [r.code, r.value])).toEqual(original.map(r => [r.code, r.value]));
    const comparableRows = reloaded.map(comparable).filter(r => r !== null);
    const comparison = compareAnalyses(comparableRows, comparableRows);
    expect(comparison.measurements.every(r => r.delta === 0 && r.direction === 'steady')).toBe(true);
    expect(comparison.measurements.some(r => r.key === 'EXT_INDEX')).toBe(false);
  });
  it('SN overlay rejects zero/nonfinite references and nonfinite non-anchor coordinates', () => {
    const valid = { points: fixture, mmPerPixel: 0.1 };
    for (const points of [{ ...fixture, S: fixture.N }, { ...fixture, S: { x: NaN, y: 0 } },
      { ...fixture, Ls: { x: Infinity, y: 0 } }]) {
      expect(superimposeOnSN({ ...valid, points }, valid).ok).toBe(false);
      expect(superimposeOnSN(valid, { ...valid, points }).ok).toBe(false);
    }
  });
  it('SN overlay refuses opposite chirality rather than presenting a wrong mirrored overlay', () => {
    expect(superimposeOnSN({ points: fixture, mmPerPixel: 0.1 },
      { points: transform(fixture, 30, 2, true), mmPerPixel: 0.05 }).ok).toBe(false);
  });
  it('SN overlay preserves physical growth, and never rescales to equal SN length', () => {
    const base = { S: { x: 0, y: 0 }, N: { x: 100, y: 0 }, Me: { x: 100, y: 100 } };
    const result = superimposeOnSN({ points: base, mmPerPixel: 0.5 },
      { points: { ...base, N: { x: 120, y: 0 } }, mmPerPixel: 0.5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cranialBaseBefore).toBe(50);
      expect(result.value.cranialBaseAfter).toBe(60);
      expect(result.value.points.N?.x).toBe(120);
    }
  });
});
