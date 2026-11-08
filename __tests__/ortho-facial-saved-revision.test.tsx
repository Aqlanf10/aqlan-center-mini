import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrthoFacialSavedRevision } from "../components/OrthoFacialSavedRevision";
import { facialHistoryFixture } from "./fixtures/ortho-facial-history";
describe('read-only older facial revision presentation',()=>{
 it('renders exact saved values, source and recording provenance without rounding or mutation',()=>{
  const revision=facialHistoryFixture().history[35];const before=JSON.stringify(revision);
  const html=renderToStaticMarkup(createElement(OrthoFacialSavedRevision,{revision}));
  expect(html).toContain(`نسخة ${revision.version}`);expect(html).toContain(revision.createdAt);expect(html).toContain(revision.contentHash);expect(html).toContain(revision.command.content.image.sha256);
  expect(html).toContain(revision.command.reason);expect(html).toContain(revision.command.content.occurrence.sourceNote);expect(html).toContain('إحداثيات نسبية');
  for(const measure of revision.results.measures)for(const segment of measure.segments){expect(html).toContain(`${segment.percent}%`);expect(html).toContain(`${segment.pixels} px`);}
  expect(JSON.stringify(revision)).toBe(before);expect(html).not.toMatch(/<(?:button|input|select|textarea|canvas|img|form|a)\b/);
 });
 it('preserves missing/unknown/unavailable states, escaped notes and recording time separate from unknown acquisition',()=>{
  const revision=facialHistoryFixture().history[0];revision.command.content.occurrence={occurredOn:null,dateProvenance:'unknown',sourceNote:'<script>source</script>'};
  revision.command.content.landmarks={axisTop:{state:'located',x:.123456789,y:0},axisBottom:{state:'unavailable',reason:'not visible <img>'}};
  revision.results.measures=[{id:'thirds',state:'invalid_geometry',landmarks:[],segments:[],message:'Saved refusal <note>'},{id:'lower_third',state:'incomplete',landmarks:[],segments:[],message:'Saved missing landmarks'}];
  const html=renderToStaticMarkup(createElement(OrthoFacialSavedRevision,{revision}));
  expect(html).toContain('x=0.123456789, y=0');expect(html).toContain('لم يُحدّد');expect(html).toContain('غير متاح: not visible &lt;img&gt;');
  expect(html).toContain('تاريخ الصورة الموثّق: غير معلوم');expect(html).toContain(revision.createdAt);expect(html).toContain('&lt;script&gt;source');expect(html).not.toContain('<script>');
  expect(html).toContain('Saved refusal &lt;note&gt;');expect(html).toContain('Saved missing landmarks');expect(html).toContain('غير مكتملة');
 });
});
