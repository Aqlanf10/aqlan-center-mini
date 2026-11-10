import { beforeAll, afterAll, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ALL_SETTING_KEYS, type SettingsMap } from '../../lib/settings';
import { CASE_LAYOUTS } from '../../lib/ortho-case-template';
import { fullStudyProjectionHash, fullStudyTablePages, FULL_STUDY_BODY } from '../../lib/ortho-study-full-layout';
import { prepareFullStudyPrint, type FullStudyPrintPresentation } from '../../lib/ortho-study-full-print';
import { OrthoFullStudyPrintPages } from '../../components/OrthoFullStudyPrintPages';
import { full, imageFixture } from '../fixtures/ortho-full-study-print';
const output=resolve(process.env.ORTHO_PRINT_ARTIFACT_DIR||'.settings-ui-artifacts/ortho-full-print');
const settings={...Object.fromEntries(ALL_SETTING_KEYS.map(key=>[key,''])),
 'clinic.name':'مركز الاختبار الاصطناعي لتقويم الأسنان', 'clinic.lead_doctor':'الطبيب الاصطناعي',
 'clinic.lead_doctor_title':'اختصاصي تقويم الأسنان', 'clinic.lead_doctor_credentials':'مؤهل الاختبار الاصطناعي — كلية الاختبار'} as SettingsMap;
const css=readFileSync(resolve('components/print-document.css'),'utf8')+readFileSync(resolve('app/print/print.css'),'utf8');
const logo=readFileSync(resolve('public/logo.png'));
let browser:Browser, script:string;
beforeAll(async()=>{
 mkdirSync(output,{recursive:true});
 const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import {hydrateRoot} from 'react-dom/client';import {OrthoFullStudyPrintReadiness} from './components/OrthoFullStudyPrintReadiness';hydrateRoot(document.querySelector('[data-print-readiness-host]'),<OrthoFullStudyPrintReadiness />);`},bundle:true,write:false,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'}});
 script=bundle.outputFiles[0].text;browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
});
afterAll(async()=>{await browser?.close();});
async function mount(page:Page,value:FullStudyPrintPresentation,identity=settings,hydrate=true){
 await page.route('**/logo.png',route=>route.fulfill({contentType:'image/png',body:logo}));
 const html=renderToStaticMarkup(<OrthoFullStudyPrintPages value={value} settings={identity} />);
 await page.setContent(`<!doctype html><html lang="ar"><head><base href="http://synthetic.invalid/"><style>body{margin:0}*{box-sizing:border-box}${css}</style></head><body><div class="print-root">${html}</div></body></html>`);
 if(hydrate)await page.addScriptTag({content:script});
}
async function geometry(page:Page){return page.evaluate(()=>[...document.querySelectorAll<HTMLElement>('[data-print-sheet]')].map((sheet,index)=>({index,sheet:sheet.getBoundingClientRect().toJSON(),regions:[...sheet.querySelectorAll<HTMLElement>('[data-print-region]')].map(region=>({kind:region.dataset.printRegion,box:region.getBoundingClientRect().toJSON(),height:region.clientHeight,scroll:region.scrollHeight,children:[...region.querySelectorAll<HTMLElement>('[data-print-content]')].map(child=>({box:child.getBoundingClientRect().toJSON(),height:child.clientHeight,scroll:child.scrollHeight}))}))})));}
async function provePdf(page:Page,value:FullStudyPrintPresentation,name:string){
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()));});
 try{await expect.poll(()=>page.locator('[data-full-study-print]').getAttribute('data-print-ready'),{timeout:6000}).toBe('true');}
 catch(error){writeFileSync(resolve(output,`${name}-geometry-failure.json`),JSON.stringify(await geometry(page),null,2));await page.screenshot({path:resolve(output,`${name}-failure.png`),fullPage:true});throw error;}
 await page.emulateMedia({media:'print'});await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));
 expect(await page.locator('[data-full-study-print]').getAttribute('data-print-ready')).toBe('true');
 const pdf=resolve(output,`${name}.pdf`);await page.pdf({path:pdf,preferCSSPageSize:true,printBackground:true});
 const count=Number(execFileSync('pdfinfo',[pdf],{encoding:'utf8'}).match(/^Pages:\s+(\d+)/m)?.[1]);expect(count).toBe(value.sheets.length);
 for(let index=0;index<count;index++){
  const text=execFileSync('pdftotext',['-f',String(index+1),'-l',String(index+1),'-layout',pdf,'-'],{encoding:'utf8'}).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'');
  expect(text).toContain(value.capturedAt);expect(text).toContain(value.revisionHash);
  expect(text).not.toContain('لم تصبح الدراسة جاهزة');
  const expected=value.sheets[index].elements.flatMap(element=>element.kind==='text'?[element.text]:element.kind==='table'?element.rows.flat():[]).join(' ');
  for(const token of new Set(expected.match(/ROW_\d+_FIELD_\d+|[a-f0-9]{64}/g)||[])) expect(text.replace(/\s/g,'')).toContain(token);
  const size=execFileSync('pdfinfo',['-f',String(index+1),'-l',String(index+1),pdf],{encoding:'utf8'});expect(size).toMatch(/841\.\d+ x 594\.\d+ pts/);
 }
 writeFileSync(resolve(output,`${name}-geometry.json`),JSON.stringify(await geometry(page),null,2));
 writeFileSync(resolve(output,`${name}-mapping.json`),JSON.stringify({pages:count,sourceProjectionHash:value.sourceProjectionHash,sheets:value.sheets.map(sheet=>({sourcePageIndex:sheet.sourcePageIndex,title:sheet.title,continuation:sheet.continuation,continuationCount:sheet.continuationCount}))},null,2));
 await page.screenshot({path:resolve(output,`${name}-first.png`)});
}
it('prints all27 layouts and repeated visits with complete actual PrintHeader identity and exact physical sheet count',async()=>{
 const value=prepareFullStudyPrint(await full([...CASE_LAYOUTS.map(layout=>layout.key),'visit']));const page=await browser.newPage({viewport:{width:1280,height:1000}});
 try{await mount(page,value);await provePdf(page,value,'all-layouts');}finally{await page.close();}
});
it('prints a verified crop collage, long Arabic notes and wide clinical tables with readable continuation',async()=>{
 const {full:original}=await imageFixture();
 const tables=fullStudyTablePages(Array.from({length:12},(_,i)=>`الحقل ${i}`),Array.from({length:2},(_,r)=>Array.from({length:12},(_,c)=>c===10?`ROW_${r}_FIELD_${c} `+'ملاحظة اصطناعية طويلة مع 2.5 mm و2020-02-29. '.repeat(18):`ROW_${r}_FIELD_${c} 2.5 mm`)),FULL_STUDY_BODY,[]);
 original.pages.push(...tables.map(table=>({...original.pages.at(-1)!,title:'جدول سريري اصطناعي طويل',elements:[table]})));original.projectionHash=fullStudyProjectionHash(original);
 const value=prepareFullStudyPrint(original),page=await browser.newPage({viewport:{width:1280,height:1000}});
 try{await mount(page,value);await provePdf(page,value,'collage-wide');}finally{await page.close();}
});
it('direct print stays fail-closed without hydration, with overlong identity, broken images and pending fonts',async()=>{
 const value=prepareFullStudyPrint(await full(['interview']));
 for(const scenario of ['no-hydration','long-identity','broken-image','pending-font','failed-font'] as const){
  const page=await browser.newPage({viewport:{width:1280,height:1000}});
  try{
   await mount(page,value,scenario==='long-identity'?{...settings,'clinic.lead_doctor_credentials':'مؤهل اصطناعي طويل '.repeat(120)}:settings,scenario!=='no-hydration');
   if(scenario==='broken-image'){await page.evaluate(()=>{const image=document.querySelector<HTMLImageElement>('[data-print-sheet] img')!;image.src='data:image/png;base64,INVALID';});}
   if(scenario==='pending-font'){
    await page.route('**/pending.woff2',()=>new Promise(()=>{}));
    await page.evaluate(()=>{const style=document.createElement('style');style.textContent='@font-face{font-family:SyntheticPending;src:url(http://synthetic.invalid/pending.woff2)}.full-study-print{font-family:SyntheticPending,Arial!important}';document.head.append(style);});
    await expect.poll(()=>page.evaluate(()=>document.fonts.status)).toBe('loading');
   }
   if(scenario==='failed-font'){
    await page.route('**/failed.woff2',route=>route.fulfill({status:404,body:''}));
    await page.evaluate(()=>{const style=document.createElement('style');style.textContent='@font-face{font-family:SyntheticFailed;src:url(http://synthetic.invalid/failed.woff2)}.full-study-print{font-family:SyntheticFailed,Arial!important}';document.head.append(style);});
    await expect.poll(()=>page.evaluate(()=>[...document.fonts].some(font=>font.family==='SyntheticFailed'&&font.status==='error'))).toBe(true);
    expect(await page.evaluate(()=>document.fonts.status)).toBe('loaded');
   }
   await page.emulateMedia({media:'print'});await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));
   await expect.poll(()=>page.locator('[data-full-study-print]').getAttribute('data-print-ready')).toBe('false');
   expect(await page.locator('.full-print-sheets').isVisible()).toBe(false);expect(await page.locator('.study-print-not-ready').isVisible()).toBe(true);
   if(scenario!=='pending-font'){
    const pdf=resolve(output,`${scenario}-refused.pdf`);await page.pdf({path:pdf,preferCSSPageSize:true,printBackground:true});
    const text=execFileSync('pdftotext',[pdf,'-'],{encoding:'utf8'});expect(text).not.toContain(value.revisionHash);
   }
  }finally{await page.close();}
 }
});
