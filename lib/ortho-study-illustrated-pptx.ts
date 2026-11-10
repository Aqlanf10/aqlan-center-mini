import { studyPageNotes, validateStudyNotesProjection } from "./ortho-study-presentation-notes";
import { checkedStudyPageNotes } from "./ortho-study-model-analysis-evidence";
import { isolateStudyDateTokens } from "./ortho-study-display";
import pptxgen from 'pptxgenjs';
import {STUDY_ILLUSTRATED_RENDERER,type StudyIllustratedPresentation} from './ortho-study-illustrated';
/** Native editable text and PNG renditions; no original is embedded behind crops. */
export async function renderIllustratedStudyPptx(value:StudyIllustratedPresentation){
 value=structuredClone(value); validateStudyNotesProjection(value);
 const notes=checkedStudyPageNotes(value.pages.map(page=>({...studyPageNotes(value,page,STUDY_ILLUSTRATED_RENDERER),
  image:page.image?{use:page.image.use,group:page.image.group,frame:page.image.frame,sourceSha256:page.image.sourceSha256,recipeSha256:page.image.recipeSha256,geometrySha256:page.image.geometrySha256,renditionSha256:page.image.renditionSha256,processorVersion:page.image.processorVersion}:null})));
 const pptx=new pptxgen();pptx.layout='LAYOUT_WIDE';pptx.author='Aqlan Center';pptx.title=`Ortho case ${value.caseId} — revision ${value.version}`;pptx.rtlMode=true;
 const base={fontFace:'Arial',rtlMode:true,lang:'ar-SA',align:'right' as const,margin:0};
 for(const [index,page] of value.pages.entries()){
  const slide=pptx.addSlide();slide.background={color:'FFFFFF'};
  slide.addText(page.title,{...base,x:.5,y:.3,w:12.3,h:.6,fontSize:25,bold:true,color:'17324D'});
  slide.addText(`نسخة سريرية مصورة • الحالة ${value.caseId} • الإصدار ${value.version} • ${value.kind==='draft'?'مسودة':'نسخة موثقة'}`,{...base,x:.5,y:1,w:12.3,h:.35,fontSize:13,color:'526579'});
  const img=page.image;
  if(img){
   const scale=Math.min(12.3/img.frame.width,4.7/img.frame.height),w=img.frame.width*scale,h=img.frame.height*scale;
   slide.addImage({data:`image/png;base64,${Buffer.from(img.png).toString('base64')}`,x:(13.333333-w)/2,y:1.55,w,h,altText:`Saved image use ${img.use.useId}`});
   slide.addText(page.lines.join(' • '),{...base,x:.5,y:6.3,w:12.3,h:.3,fontSize:10});
   if(img.resolutionWarning)slide.addText('دقة الأصل أقل من حجم الإطار؛ راجع وضوح الصورة.',{...base,x:.5,y:6.65,w:12.3,h:.25,fontSize:10,color:'92400E'});
  }else page.lines.forEach((text,line)=>slide.addText(isolateStudyDateTokens(text),{...base,x:.5,y:1.65+line*.38,w:12.3,h:.36,fontSize:16,color:'182B3A'}));
  slide.addText(`${index+1}/${value.pages.length} • ${value.revisionHash.slice(0,16)} • ${STUDY_ILLUSTRATED_RENDERER}`,{...base,x:.5,y:7,w:12.3,h:.25,fontSize:9,color:'526579'});
  slide.addNotes(notes[index]);
 }
 return new Uint8Array(await pptx.write({outputType:'arraybuffer',compression:true}) as ArrayBuffer);
}
