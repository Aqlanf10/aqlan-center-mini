import { describe, expect, it } from 'vitest';
import { computeAll, enrichWithRefs, getClinicalInterpretation, interpret, MEASUREMENTS,
  measure, missingFor, type LandmarkMap, type Pt } from '../lib/ceph';
import { comparable, compareAnalyses } from '../lib/cephCompare';

const CODE = 'EI_KIM_1996';
const scale = 0.1;
const radians = (angle: number) => angle * Math.PI / 180;
const vector = (angle: number, length: number): Pt => ({ x: length * Math.cos(radians(angle)), y: length * Math.sin(radians(angle)) });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
// Explicit independent geometry: FH/PP horizontal, AB vertical, MP24 degrees.
// Therefore AB-MP66, APDI90, PP-FH0, ODI66 and CF156. The E-line is vertical,
// giving signed lip offsets exactly UL/LL mm at 0.1 mm/pixel. No Sn is needed.
const fixture = (iia = 130, ulMm = 0, llMm = 0): LandmarkMap => ({
  S: { x: 0, y: -20 }, N: { x: 100, y: -20 },
  Po: { x: 0, y: 0 }, Or: { x: 100, y: 0 },
  A: { x: 80, y: 30 }, B: { x: 80, y: 90 },
  Go: { x: 0, y: 100 }, Me: add({ x: 0, y: 100 }, vector(24, 100)),
  PNS: { x: 0, y: 20 }, ANS: { x: 100, y: 20 },
  U1A: { x: 60, y: 30 }, U1: add({ x: 60, y: 30 }, vector(65, 20)),
  L1A: { x: 60, y: 120 }, L1: add({ x: 60, y: 120 }, vector(65 - iia, 20)),
  Prn: { x: 150, y: 20 }, PogS: { x: 150, y: 150 },
  Ls: { x: 150 + ulMm / scale, y: 60 }, Li: { x: 150 + llMm / scale, y: 100 },
});
const result = (points: LandmarkMap, calibration = scale) => computeAll(points, calibration).find(row => row.code === CODE);
const transform = (points: LandmarkMap, rotation: number, resize: number, mirror: boolean): LandmarkMap =>
  Object.fromEntries(Object.entries(points).map(([code, p]) => {
    const x = p!.x * (mirror ? -1 : 1), y = p!.y;
    return [code, { x: 300 + resize * (x * Math.cos(radians(rotation)) - y * Math.sin(radians(rotation))),
      y: 500 + resize * (x * Math.sin(radians(rotation)) + y * Math.cos(radians(rotation))) }];
  }));

describe('Kim EI, Shin–Chang 1996 nose-tip E-line operationalization', () => {
  it.each([
    [130, 0, 0, 156], [125, 0, 0, 155], [135, 0, 0, 157],
    [130, 2, 3, 151], [130, -2, -3, 161], [130, -2, 3, 155],
  ])('IIA%s, UL%s mm, LL%s mm produces EI%s', (iia, ul, ll, expected) => {
    const points = fixture(iia, ul, ll);
    expect(measure('CF', points, scale)).toBeCloseTo(156, 10);
    expect(measure('INTER', points, scale)).toBeCloseTo(iia, 10);
    expect(measure('E_LINE_UL', points, scale)).toBeCloseTo(ul, 10);
    expect(measure('E_LINE_LL', points, scale)).toBeCloseTo(ll, 10);
    expect(measure(CODE, points, scale)).toBeCloseTo(expected, 10);
  });

  it('is continuous at IIA130 and uses full component precision before final rounding', () => {
    for (const delta of [-1e-6, 0, 1e-6]) {
      expect(measure(CODE, fixture(130 + delta), scale)).toBeCloseTo(156 + delta / 5, 10);
    }
    const points = fixture(131.234, -1.234, 2.345);
    const expected = 156 + 1.234 / 5 + 1.234 - 2.345;
    expect(measure(CODE, points, scale)).toBeCloseTo(expected, 10);
    expect(result(points)?.value).toBe(Math.round(expected * 10) / 10);
  });

  it('each 1 mm anterior lip movement independently reduces EI by1; IIA+5 increases EI by1', () => {
    const base = measure(CODE, fixture(130, -2, 3), scale);
    expect(measure(CODE, fixture(130, -1, 3), scale)).toBeCloseTo(base - 1, 10);
    expect(measure(CODE, fixture(130, -2, 4), scale)).toBeCloseTo(base - 1, 10);
    expect(measure(CODE, fixture(135, -2, 3), scale)).toBeCloseTo(base + 1, 10);
  });

  it('retains signed offsets through rotations, reflection and reciprocal image calibration', () => {
    const points = fixture(125, -2, 3);
    for (const angle of [-180, -90, -40, 0, 35, 90, 180]) for (const resize of [0.25, 1, 4]) {
      for (const mirror of [false, true]) {
        expect(measure(CODE, transform(points, angle, resize, mirror), scale / resize)).toBeCloseTo(154, 9);
      }
    }
  });

  it('declares the full dependency and calibration contract, without Sn/Gn/hard Pog substitution', () => {
    const def = MEASUREMENTS.find(row => row.code === CODE);
    expect(def).toBeDefined();
    expect(def?.needs.slice().sort()).toEqual(Object.keys(fixture()).sort());
    expect(def).toMatchObject({ unit: '', requiresCalibration: true, descriptiveOnly: true,
      calculationVersion: 'kim-ei-shin-chang-1996-nose-tip-v1', mean: null, tol: null });
    expect(def?.needs).not.toContain('Sn');
    expect(def?.needs).not.toContain('Gn');
    expect(def?.needs).not.toContain('Pog');
  });

  it('missing any actual dependency gives unavailable, never a default or reused value', () => {
    for (const code of Object.keys(fixture())) {
      const points = { ...fixture(), [code]: undefined };
      expect(measure(CODE, points, scale), code).toBeNaN();
      expect(missingFor(CODE, points), code).toContain(code);
      expect(result(points), code).toMatchObject({ value: null, display: '—', status: null });
    }
    const absentPogS = { ...fixture(), PogS: undefined, Pog: { x: 150, y: 150 } };
    expect(measure(CODE, absentPogS, scale)).toBeNaN();
  });

  it('rejects invalid calibration and geometry but permits true zero lip offsets', () => {
    for (const calibration of [NaN, Infinity, 0, -1]) expect(measure(CODE, fixture(), calibration)).toBeNaN();
    for (const [a, b] of [['U1A', 'U1'], ['L1A', 'L1'], ['Prn', 'PogS'], ['Po', 'Or'],
      ['A', 'B'], ['Go', 'Me'], ['ANS', 'PNS'], ['S', 'N']] as const) {
      const points = fixture();
      points[b] = points[a];
      expect(measure(CODE, points, scale), `${a}/${b}`).toBeNaN();
    }
    expect(measure(CODE, { ...fixture(), Me: { x: 200, y: -20 } }, scale)).toBeNaN();
    for (const code of Object.keys(fixture())) {
      expect(measure(CODE, { ...fixture(), [code]: { x: Infinity, y: 0 } }, scale), code).toBeNaN();
    }
    expect(measure(CODE, fixture(), scale)).toBeCloseTo(156, 10);
  });

  it('uses perpendicular signed distances to a tilted E-line, not screen-x distances', () => {
    const points = { ...fixture(), Prn: { x: 100, y: 20 }, PogS: { x: 40, y: 100 },
      Ls: { x: 77.6, y: 53.2 }, Li: { x: 54.4, y: 85.8 } };
    expect(measure('E_LINE_UL', points, 1)).toBeCloseTo(2, 10);
    expect(measure('E_LINE_LL', points, 1)).toBeCloseTo(3, 10);
    expect(measure(CODE, points, 1)).toBeCloseTo(151, 10);
  });

  it('a measured CF increase of1 increases EI by1 without reference adjustment', () => {
    const points = { ...fixture(), Me: add({ x: 0, y: 100 }, vector(23, 100)) };
    expect(measure('CF', points, scale)).toBeCloseTo(157, 10);
    expect(measure(CODE, points, scale)).toBeCloseTo(157, 10);
  });

  it('does not use nasolabial angle or assume population-relative lip offsets', () => {
    expect(measure(CODE, fixture(130, -2, -3), scale)).toBeCloseTo(161, 10);
    expect(measure(CODE, { ...fixture(), Sn: { x: 120, y: 80 } }, scale)).toBeCloseTo(156, 10);
    expect(measure(CODE, { ...fixture(), Sn: { x: 50, y: -100 } }, scale)).toBeCloseTo(156, 10);
  });

  it('keeps historical unsupported EXT_INDEX separate from the versioned result', () => {
    expect(measure('EXT_INDEX', fixture(), scale)).toBeNaN();
    expect(computeAll(fixture(), scale).some(row => row.code === 'EXT_INDEX')).toBe(false);
    const original = result(fixture(135, 2, -3));
    expect(original).toBeDefined();
    expect(result(JSON.parse(JSON.stringify(fixture(135, 2, -3))))).toEqual(original);
    expect(comparable({ ...original!, code: 'EXT_INDEX', value: 140 })).toBeNull();
  });

  it('labels the study population and SD without turning them into treatment thresholds or automatic grades', () => {
    const row = result(fixture())!;
    expect(row).toBeDefined();
    expect(row).toMatchObject({ status: null, severityStars: '', mean: null, tol: null,
      requiresCalibration: true, descriptiveOnly: true,
      populationReference: { mean: 153.8, sd: 7.76, sampleSize: 153, ageMin: 11.2,
        ageMax: 14.4, meanAge: 12.7, boys: 67, girls: 86 } });
    expect(row.populationReference?.population).toMatch(/Korean.*normal occlusion/i);
    expect(row.sourceUrl).toBe('https://e-kjo.org/journal/view.html?uid=1202&vmd=Full');
    for (const value of [100, 153.8, 200]) {
      expect(getClinicalInterpretation(CODE, value).en).toBe('Descriptive composite index; treatment decisions require clinical assessment');
      expect(interpret(value, MEASUREMENTS.find(def => def.code === CODE)!)).toBeNull();
    }
    for (const refs of [null, { [CODE]: { mean: 1, sd: 1 } }]) {
      expect(enrichWithRefs([row], refs)[0]).toMatchObject({ refMean: null, refSd: null,
        diff: null, z: null, refLabel: null, refSeverity: null });
    }
    const first = comparable(row)!;
    expect(first).toMatchObject({ code: CODE, value: 156, mean: null });
    expect(compareAnalyses([{ ...first, mean: 1 }], [{ ...first, value: 157, mean: 1 }]).measurements[0])
      .toMatchObject({ delta: 1, gapBefore: null, gapAfter: null, direction: 'ungraded' });
  });
});
