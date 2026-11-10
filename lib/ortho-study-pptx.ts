import { studyPageNotes, validateStudyNotesProjection } from "./ortho-study-presentation-notes";
import { checkedStudyPageNotes } from "./ortho-study-model-analysis-evidence";
import pptxgen from "pptxgenjs";
import { STUDY_TEXT_RENDERER, type StudyTextPresentation } from "./ortho-study-text-export";

import { isolateStudyDateTokens } from "./ortho-study-display";
export { isolateStudyDateTokens } from "./ortho-study-display";

/** Editable native PowerPoint text, generated in memory with no external assets. */
export async function renderStudyTextPptx(value: StudyTextPresentation): Promise<Uint8Array> {
  value = structuredClone(value);
  validateStudyNotesProjection(value);
  const notes = checkedStudyPageNotes(value.pages.map(page => studyPageNotes(value, page, STUDY_TEXT_RENDERER)));
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE"; pptx.author = "Aqlan Center";
  pptx.subject = "Clinical text copy of a saved orthodontic case study";
  pptx.title = `Ortho case ${value.caseId} — revision ${value.version}`;
  pptx.rtlMode = true;
  const base = { fontFace: "Arial", rtlMode: true, lang: "ar-SA", align: "right" as const, margin: 0, breakLine: false };
  for (const [index, page] of value.pages.entries()) {
    const slide = pptx.addSlide(); slide.background = { color: "FFFFFF" };
    slide.addText(page.title, { ...base, x: 0.5, y: 0.35, w: 12.3, h: 0.6, fontSize: 25, bold: true, color: "17324D" });
    slide.addText(`نسخة نصية سريرية • الحالة ${value.caseId} • الإصدار ${value.version} • ${value.kind === "draft" ? "مسودة" : "نسخة موثقة"}`, { ...base, x: 0.5, y: 1, w: 12.3, h: 0.4, fontSize: 13, color: "526579" });
    for (const [line, text] of page.lines.entries()) slide.addText(isolateStudyDateTokens(text), { ...base, x: 0.5, y: 1.65 + line * 0.38, w: 12.3, h: 0.36, fontSize: 16, color: "182B3A" });
    slide.addText(`${index + 1}/${value.pages.length} • ${value.revisionHash.slice(0, 16)} • ${STUDY_TEXT_RENDERER}`, { ...base, x: 0.5, y: 6.85, w: 12.3, h: 0.3, fontSize: 10, color: "526579" });
    slide.addNotes(notes[index]);
  }
  return new Uint8Array(await pptx.write({ outputType: "arraybuffer", compression: true }) as ArrayBuffer);
}
