import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import type {Browser,Page} from "playwright";

const correct="قرار بلا رسوم مثبت للعمل المسجل";
const wrong="قرار بال رسوم مثبت للعمل المسجل";
const whitespace=(text:string)=>text.trim().replace(/\s+/g," ");
const dpi=300;
export type VisitSourceOcrDiagnostic={verdict:"inconclusive"|"correct_visible_phrase"|"wrong_visible_phrase";reason?:string;
  controls?:{correct:string;wrong:string};actual?:string;metadata?:{versions:string;modelSha256:string};
  geometry?:{page:number;x:number;y:number;width:number;height:number;dpi:number};
  calibration?:{topWidthErrorPt:number;bottomWidthErrorPt:number;xOffsetErrorPt:number;yOffsetErrorPt:number}};

/** Diagnostic only: fresh synthetic PDF, fixed OCR, no extraction-word substitutions.
 * The source cell is selected by the report's verified row ordinal and column index,
 * then two layout-neutral ASCII corner markers locate that cell in PDF coordinates.
 * Controls are independent screen rasters, not PDFs or extracted PDF text.
 */
export async function diagnoseVisitSourcePdfOcr(page:Page,browser:Browser,directory:string,rowIndex:number,rowCount:number):Promise<VisitSourceOcrDiagnostic>{
  const result:VisitSourceOcrDiagnostic={verdict:"inconclusive"};
  const markerTop=`OCRROW${rowIndex}TOP`,markerBottom=`OCRROW${rowIndex}BOTTOM`;
  let restore:(()=>Promise<void>)|undefined;
  try{
    const versions=execFileSync("dpkg-query",["-W","-f=${Package} ${Version}\\n","tesseract-ocr","tesseract-ocr-ara","poppler-utils"],{encoding:"utf8"}).trim();
    const modelPaths=execFileSync("dpkg-query",["-L","tesseract-ocr-ara"],{encoding:"utf8"}).split("\n").filter(path=>path.endsWith("/ara.traineddata"));
    if(modelPaths.length!==1)throw new Error("model_path_not_unique");
    result.metadata={versions:versions.slice(0,400),modelSha256:createHash("sha256").update(readFileSync(modelPaths[0])).digest("hex")};
    const spec=await page.evaluate(({rowIndex,rowCount,markerTop,markerBottom})=>{
      const tables=[...document.querySelectorAll<HTMLTableElement>(".report-section table.report-table")];
      if(tables.length!==1)throw new Error("table_not_unique");
      const rows=[...tables[0].querySelectorAll<HTMLTableRowElement>("tbody > tr")];
      if(rows.length!==rowCount||!rows[rowIndex]||rows[rowIndex].cells.length!==4)throw new Error("row_mapping_ambiguous");
      const cell=rows[rowIndex].cells[1]; // Requested print columns: patientNumber,workSource,invoiceText,collection.
      const range=document.createRange();range.selectNodeContents(cell);
      const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);
      if(rects.length!==1)throw new Error("source_cell_not_single_line");
      const box=cell.getBoundingClientRect(),ink=rects[0],css=getComputedStyle(cell);
      if(ink.left<box.left+2||ink.right>box.right-2||ink.top<box.top+2||ink.bottom>box.bottom-2)throw new Error("source_cell_crop_padding_insufficient");
      const before={x:box.x,y:box.y,width:box.width,height:box.height};
      cell.dataset.ocrOldStyle=cell.getAttribute("style")??"";cell.dataset.ocrTarget="true";cell.style.position="relative";
      for(const [text,edge] of [[markerTop,"top"],[markerBottom,"bottom"]] as const){
        const span=document.createElement("span");span.dataset.ocrMarker=text;span.textContent=text;
        Object.assign(span.style,{position:"absolute",fontFamily:"monospace",fontSize:"8px",lineHeight:"8px",direction:"ltr",whiteSpace:"nowrap",padding:"0",margin:"0",[edge]:"0",left:"0"});cell.append(span);
      }
      const after=cell.getBoundingClientRect();
      if(after.x!==before.x||after.y!==before.y||after.width!==before.width||after.height!==before.height)throw new Error("markers_changed_layout");
      const marker=(name:string)=>{const element=cell.querySelector(`[data-ocr-marker="${name}"]`)!;const r=document.createRange();r.selectNodeContents(element);const b=r.getBoundingClientRect();return {width:b.width,height:b.height,x:b.x-box.x,y:b.y-box.y};};
      return {box:before,top:marker(markerTop),bottom:marker(markerBottom),font:{fontFamily:css.fontFamily,fontSize:css.fontSize,fontWeight:css.fontWeight,fontStyle:css.fontStyle,letterSpacing:css.letterSpacing,lineHeight:css.lineHeight}};
    },{rowIndex,rowCount,markerTop,markerBottom});
    restore=async()=>{await page.evaluate(()=>{for(const cell of document.querySelectorAll<HTMLElement>('[data-ocr-target="true"]')){for(const marker of cell.querySelectorAll("[data-ocr-marker]"))marker.remove();const old=cell.dataset.ocrOldStyle??"";if(old)cell.setAttribute("style",old);else cell.removeAttribute("style");delete cell.dataset.ocrTarget;delete cell.dataset.ocrOldStyle;}});};
    const diagnosticPdf=`${directory}/fresh-ocr-diagnostic.pdf`;
    writeFileSync(diagnosticPdf,await page.pdf({preferCSSPageSize:true,printBackground:true}));
    const xml=execFileSync("pdftotext",["-bbox-layout","-enc","UTF-8",diagnosticPdf,"-"],{encoding:"utf8",maxBuffer:4*1024*1024});
    const geometry=await page.evaluate(({xml,markerTop,markerBottom})=>{
      const doc=new DOMParser().parseFromString(xml,"application/xml");if(doc.querySelector("parsererror"))throw new Error("invalid_bbox_xml");
      const pages=[...doc.getElementsByTagName("page")];
      const matches=pages.flatMap((p,index)=>[...p.getElementsByTagName("word")].filter(w=>w.textContent===markerTop||w.textContent===markerBottom).map(w=>({marker:w.textContent,page:index+1,pageWidth:Number(p.getAttribute("width")),pageHeight:Number(p.getAttribute("height")),x1:Number(w.getAttribute("xMin")),x2:Number(w.getAttribute("xMax")),y1:Number(w.getAttribute("yMin")),y2:Number(w.getAttribute("yMax"))})));
      if(matches.length!==2)throw new Error("markers_not_unique");
      const top=matches.find(m=>m.marker===markerTop),bottom=matches.find(m=>m.marker===markerBottom);
      if(!top||!bottom||top.page!==bottom.page)throw new Error("markers_cross_pages");return {top,bottom};
    },{xml,markerTop,markerBottom});
    const scale=72/96,{top,bottom}=geometry;
    // One PDF point allows glyph bbox rounding, not a tunable image-similarity threshold.
    // Report numerical offsets from both independent anchors instead of
    // labeling the original PDF text wrong when only the crop registration failed.
    result.calibration={
      topWidthErrorPt:Number(((top.x2-top.x1)-spec.top.width*scale).toFixed(3)),
      bottomWidthErrorPt:Number(((bottom.x2-bottom.x1)-spec.bottom.width*scale).toFixed(3)),
      xOffsetErrorPt:Number(((bottom.x1-top.x1)-(spec.bottom.x-spec.top.x)*scale).toFixed(3)),
      yOffsetErrorPt:Number(((bottom.y1-top.y1)-(spec.bottom.y-spec.top.y)*scale).toFixed(3)),
    };
    if(Object.values(result.calibration).some(delta=>Math.abs(delta)>1))
      throw new Error("pdf_dom_geometry_not_calibrated");
    const left=top.x1-spec.top.x*scale,upper=top.y1-spec.top.y*scale;
    const crop={page:top.page,x:Math.ceil((left+2*scale)*dpi/72),y:Math.ceil((upper+2*scale)*dpi/72),width:Math.floor((spec.box.width-4)*scale*dpi/72),height:Math.floor((spec.box.height-4)*scale*dpi/72),dpi};
    if(crop.x<0||crop.y<0||crop.width<=0||crop.height<=0||crop.x+crop.width>top.pageWidth*dpi/72||crop.y+crop.height>top.pageHeight*dpi/72)throw new Error("crop_outside_page");
    result.geometry=crop;
    execFileSync("pdftoppm",["-f",String(crop.page),"-l",String(crop.page),"-r",String(dpi),"-x",String(crop.x),"-y",String(crop.y),"-W",String(crop.width),"-H",String(crop.height),"-png","-singlefile",diagnosticPdf,`${directory}/actual-source-cell`],{maxBuffer:1024*1024});
    const controls=await browser.newContext({viewport:{width:1000,height:200},deviceScaleFactor:dpi/96});
    try{
      const controlPage=await controls.newPage();await controlPage.setContent('<html dir="rtl"><body style="margin:0;background:white"><span id="line" style="display:inline-block;white-space:nowrap;padding:2px;color:black;background:white"></span></body></html>');
      for(const [name,text] of [["correct",correct],["wrong",wrong]] as const){
        await controlPage.locator("#line").evaluate((element,{text,font})=>{Object.assign((element as HTMLElement).style,font);element.textContent=text;},{text,font:spec.font});
        await controlPage.evaluate(()=>document.fonts.ready);
        await controlPage.locator("#line").screenshot({path:`${directory}/${name}-ocr-control.png`});
      }
    }finally{await controls.close();}
    const ocr=(name:string)=>whitespace(execFileSync("tesseract",[`${directory}/${name}.png`,"stdout","-l","ara","--oem","1","--psm","7"],{encoding:"utf8",maxBuffer:64*1024,stdio:["ignore","pipe","pipe"]}));
    const correctRead=ocr("correct-ocr-control"),wrongRead=ocr("wrong-ocr-control");
    result.controls={correct:correctRead.slice(0,180),wrong:wrongRead.slice(0,180)};
    if(correctRead!==correct||wrongRead!==wrong)throw new Error("controls_not_exactly_discriminated");
    const actual=ocr("actual-source-cell");result.actual=actual.slice(0,180);
    result.verdict=actual===correct?"correct_visible_phrase":actual===wrong?"wrong_visible_phrase":"inconclusive";
    if(result.verdict==="inconclusive")result.reason="actual_cell_not_exactly_recognized";
  }catch(error){
    // Never expose subprocess stdout, raw XML, files or arbitrary exception bodies.
    const message=error instanceof Error?error.message:"unknown";
    result.reason=/^[a-z_]+$/.test(message)?message:"diagnostic_tool_or_geometry_failure";
  }finally{await restore?.().catch(()=>{});}
  return result;
}
