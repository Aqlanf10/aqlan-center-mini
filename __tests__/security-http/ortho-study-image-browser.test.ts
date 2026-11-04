import {createHash,randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import sharp from 'sharp';
import {Client} from 'pg';
import {chromium,type Browser} from 'playwright';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {baseUrl,harness,authedMutation,authedGet} from './_server';
import {defaultOrthoMediaRecipe} from '../../lib/ortho-study-media';
let h:Awaited<ReturnType<typeof harness>>,db:Client,browser:Browser;
beforeAll(async()=>{h=await harness();expect(new URL(h.seeded.dbUrl).pathname).toBe('/aqlan_sec_http');db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});await mkdir('.settings-ui-artifacts',{recursive:true});});
afterAll(async()=>{await browser?.close();await db?.end();});
async function setup(){
 const patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'دراسة صور اصطناعية') RETURNING id",[`SYN-IMAGE-${randomUUID()}`])).rows[0].id;
 const opened=await authedMutation('/api/ortho/intake',h.sessions.admin,'POST',JSON.stringify({patientId,command:{schemaVersion:1,clientRequestId:randomUUID(),reason:'Synthetic image study'}}));expect(opened.status).toBe(201);const {orthoCaseId}=await opened.json();
 const bytes=await sharp({create:{width:80,height:120,channels:3,background:'#336699'}}).png().toBuffer(),sha256=createHash('sha256').update(bytes).digest('hex');
 const command={schemaVersion:1,clientRequestId:randomUUID(),title:'Synthetic study image',photoView:'extraoral_frontal',photoStage:null,occurrence:{state:'unknown',takenOn:null,sourceNote:'Synthetic unknown date'},file:{sha256,mimeType:'image/png',sizeBytes:bytes.length}};
 const form=new FormData();form.set('patientId',String(patientId));form.set('command',JSON.stringify(command));form.set('file',new Blob([new Uint8Array(bytes)],{type:'image/png'}),'synthetic.png');
 const uploaded=await fetch(`${baseUrl}/api/ortho/${orthoCaseId}/record-uploads`,{method:'POST',headers:{Cookie:h.sessions.admin.cookie,Origin:baseUrl,'Sec-Fetch-Site':'same-origin'},body:form,redirect:'manual'});expect(uploaded.status).toBe(201);
 const documentId=(await db.query('SELECT id FROM patient_documents WHERE patient_id=$1',[patientId])).rows[0].id;
 return {patientId,orthoCaseId,documentId,sha256,bytes};
}
it('checks private image scope, role, hash, orientation and CSRF on the built route',async()=>{
 const p=await setup(),url=`/api/ortho/${p.orthoCaseId}/case-study/media`;
 const query=`?patientId=${p.patientId}&documentId=${p.documentId}&sha256=${p.sha256}`;
 const basis=await authedGet(url+query,h.sessions.admin);expect(basis.status).toBe(200);expect(await basis.json()).toMatchObject({documentId:p.documentId,basis:{orientedWidth:80,orientedHeight:120,exifOrientation:1}});
 expect((await authedGet(url+query,h.sessions.accountant)).status).toBe(403);
 const command={patientId:p.patientId,documentId:p.documentId,sha256:p.sha256,useId:'test_use',purpose:'selected-use',recipe:defaultOrthoMediaRecipe(80,120,1),frame:{width:80,height:120}};
 const png=await authedMutation(url,h.sessions.admin,'POST',JSON.stringify(command));expect(png.status).toBe(200);expect(png.headers.get('cache-control')).toContain('private');expect(png.headers.get('cache-control')).toContain('no-store');expect(png.headers.get('x-study-source-sha256')).toBe(p.sha256);
 expect((await sharp(Buffer.from(await png.arrayBuffer())).metadata()).channels).toBe(3);
 expect((await authedMutation(url,h.sessions.admin,'POST',JSON.stringify({...command,sha256:'a'.repeat(64)}))).status).toBe(409);
 expect((await authedMutation(url,h.sessions.admin,'POST',JSON.stringify({...command,recipe:defaultOrthoMediaRecipe(120,80,1)}))).status).toBe(409);
 const csrf=await fetch(baseUrl+url,{method:'POST',headers:{Cookie:h.sessions.admin.cookie,'Content-Type':'application/json',Origin:'https://foreign.invalid'},body:JSON.stringify(command),redirect:'manual'});expect(csrf.status).toBe(403);
 const original=await authedGet(`/api/documents/${p.documentId}`,h.sessions.admin);expect(Buffer.from(await original.arrayBuffer())).toEqual(p.bytes);
});
it.each([390,1280])('selects, previews, rotates, saves and reloads the same image use at %ipx without changing its original',async width=>{
 const p=await setup(),context=await browser.newContext({viewport:{width,height:1000},locale:'ar-YE'});
 const [name,...value]=h.sessions.admin.cookie.split('=');await context.addCookies([{name,value:value.join('='),url:baseUrl}]);const page=await context.newPage(),errors:string[]=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(`${baseUrl}/patients/${p.patientId}?tab=treatment&sub=ortho&orthoCaseId=${p.orthoCaseId}&pillar=diagnostics#ortho-assessment/${p.patientId}/${p.orthoCaseId}/records`);
  await page.getByRole('button',{name:/عرض الحالة/}).click();const study=page.getByRole('region',{name:'دراسة حالة التقويم',exact:true});
  await study.getByLabel('إضافة المرجع إلى القسم',{exact:true}).selectOption('section_3');await study.getByLabel('نوع مصدر الدراسة',{exact:true}).selectOption('document');
  const choice=study.getByRole('group',{name:'اختيار مصدر حقيقي',exact:true}).getByRole('button',{name:'اختيار',exact:true});await expect.poll(()=>choice.count()).toBe(1);await choice.click();
  await study.getByRole('button',{name:'إضافة الصورة إلى الإطار',exact:true}).click();const editor=study.getByRole('region',{name:'محرر استخدام الصورة',exact:true});
  await editor.getByAltText('معاينة استخدام الصورة',{exact:true}).waitFor();
  await editor.getByRole('button',{name:'تدوير +90° وإعادة القص',exact:true}).click();await editor.getByAltText('معاينة استخدام الصورة',{exact:true}).waitFor();
  expect(await editor.getByLabel('زاوية الميل بالدرجات',{exact:true}).inputValue()).toBe('90');
  await editor.getByLabel('اليسار %',{exact:true}).fill('10');await editor.getByRole('button',{name:'تطبيق حدود القص',exact:true}).click();await editor.getByRole('button',{name:'إطار العرض',exact:true}).click();await editor.getByAltText('معاينة استخدام الصورة',{exact:true}).waitFor();
  await study.getByLabel('سبب حفظ النسخة',{exact:true}).fill('Synthetic image recipe reviewed');const saving=page.waitForResponse(r=>r.url().includes(`/ortho/${p.orthoCaseId}/case-study/editor`)&&r.request().method()==='POST');await study.getByRole('button',{name:'حفظ مسودة الدراسة',exact:true}).click();expect((await saving).status()).toBe(201);
  await page.reload();await page.getByRole('button',{name:/عرض الحالة/}).click();await editor.getByAltText('معاينة استخدام الصورة',{exact:true}).waitFor();expect(await editor.getByLabel('زاوية الميل بالدرجات',{exact:true}).inputValue()).toBe('90');
  expect(await editor.getByLabel('اليسار %',{exact:true}).inputValue()).toBe('10');expect(await editor.getByAltText('معاينة استخدام الصورة',{exact:true}).evaluate(el=>el.getBoundingClientRect().height)).toBeLessThanOrEqual(513);await editor.getByText('دقة الأصل أقل من حجم إطار العرض؛ قد تظهر الصورة غير واضحة. راجعها أو اختر أصلاً بدقة أعلى.',{exact:true}).waitFor();await editor.evaluate(el=>{el.scrollIntoView({block:'start',behavior:'instant'});window.scrollBy(0,-80);});await page.screenshot({path:`.settings-ui-artifacts/ortho-study-image-${width}.png`});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const saved=await authedGet(`/api/ortho/${p.orthoCaseId}/case-study/editor?patientId=${p.patientId}`,h.sessions.admin);const record=await saved.json();expect(record.revision.authored.mediaUses).toHaveLength(1);expect(record.revision.authored.mediaUses[0]).toMatchObject({documentId:p.documentId,sourceSha256:p.sha256,recipe:{rotationMilliDegrees:90000,cropPpm:{left:100000}}});
  const original=await authedGet(`/api/documents/${p.documentId}`,h.sessions.admin);expect(Buffer.from(await original.arrayBuffer())).toEqual(p.bytes);expect(errors).toEqual([]);
 }finally{await context.close();}
});
