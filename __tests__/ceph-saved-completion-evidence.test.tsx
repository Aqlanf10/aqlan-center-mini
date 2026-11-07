import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CephSavedCompletionEvidence } from "../components/CephSavedCompletionEvidence";
import { completionEvidence } from "./fixtures/ceph-completion-evidence";

const render = (witness = completionEvidence()) => renderToStaticMarkup(createElement(CephSavedCompletionEvidence, { witness }));
describe("saved completion evidence presentation", () => {
  it("preserves exact source coordinates, declared length, stored scale and seal identity", () => {
    const witness = completionEvidence(), before = structuredClone(witness), html = render(witness);
    expect(html).toContain('(0, 12.5) px'); expect(html).toContain('(80, 12.5) px');
    expect(html).toContain('10 mm'); expect(html).toContain('0.125 mm/px'); expect(html).not.toContain('8 px/mm');
    expect(html).toContain('800 px'); expect(html).toContain('600 px');
    expect(html).toContain('SAVED_SEAL_ACTOR'); expect(html).toContain('2026-11-05T12:34:56.000Z');
    expect(html).toContain('ليس وقت التقاط الصورة'); expect(html).toContain('ليست توقيعًا رقميًا');
    expect(html).toContain('ليس تحققًا سريريًا مستقلًا'); expect(witness).toEqual(before);
    expect(html).not.toMatch(/<(?:button|input|select|textarea|form|a)\b/);
  });
  it("does not round or invert stored numbers and isolates numeric units LTR", () => {
    const witness = completionEvidence();
    // Pure presenter behavior: no claim these altered numbers passed admission.
    witness.snapshot.mmPerPixel = 1e-7;
    witness.snapshot.calibration = { x1: 0.123456789, y1: 0, x2: 80, y2: 0, mm: 0.000008 };
    const html = render(witness);
    expect(html).toContain('<bdi dir="ltr">1e-7 mm/px</bdi>');
    expect(html).toContain('(0.123456789, 0) px'); expect(html).toContain('0.000008 mm');
  });
  it("keeps missing source dimensions unknown rather than zero", () => {
    const witness = completionEvidence(); witness.image.width = null; witness.image.height = null;
    const html = render(witness); expect(html.match(/غير موثّق/g)).toHaveLength(2); expect(html).not.toContain('0 px');
  });
  it("distinguishes v1 server capture from v2 identity match without viewing assurance", () => {
    const v1 = render(completionEvidence(1)), v2 = render(completionEvidence(2));
    expect(v1).toContain('v1:'); expect(v1).toContain('لم يؤكد السجل'); expect(v1).not.toContain('v2:');
    expect(v2).toContain('v2:'); expect(v2).toContain('طابقت هوية المصادر');
    expect(v2).toContain('ليس دليلًا على المشاهدة البشرية'); expect(v2).not.toContain('v1:');
  });
  it("escapes recorded actor text without adding links", () => {
    const witness = completionEvidence(); witness.actor.username = '<img src=x onerror=alert(1)>';
    const html = render(witness); expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
  });
});
