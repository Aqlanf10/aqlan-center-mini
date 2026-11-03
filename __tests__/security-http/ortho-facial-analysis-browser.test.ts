import { randomUUID,createHash } from "node:crypto";
import { mkdir,writeFile } from "node:fs/promises";
import { dirname,join } from "node:path";
import sharp from "sharp";
import { Client } from "pg";
import { chromium,type Browser } from "playwright";
import { beforeAll,afterAll,describe,it,expect } from "vitest";
import { baseUrl,harness,authedMutation,authedGet } from "./_server";
import { storageKey } from "../../lib/storage";
import { syntheticFace } from "../fixtures/ortho-facial-analysis";
let h:Awaited<ReturnType<typeof harness>>,db:Client,browser:Browser;
beforeAll(async()=>{h=await harness();expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});await mkdir(".settings-ui-artifacts",{recursive:true});});
afterAll(async()=>{await browser?.close();await db?.end();});
async function fixture(){
 const patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'حالة قياس اصطناعية') RETURNING id",[`SYN-FACE-${randomUUID()}`])).rows[0].id;
 const caseId=(await db.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id",[patientId])).rows[0].id;
 await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic')",[patientId,caseId]);
 const docs:{id:number;sha:string}[]=[];for(const color of ["#516c7a","#6f596a"]){
  const png=await sharp(Buffer.from(`<svg width="1000" height="1200"><rect width="1000" height="1200" fill="${color}"/><path d="M500 0V1200M0 600H1000" stroke="white" stroke-width="4"/><rect x="100" y="150" width="800" height="900" fill="none" stroke="white" stroke-width="3"/></svg>`)).png().toBuffer();
  const sha=createHash("sha256").update(png).digest("hex"),key=storageKey(sha,"png"),file=join(process.cwd(),".sec-http-storage/documents",key);await mkdir(dirname(file),{recursive:true});await writeFile(file,png);
  const id:number=(await db.query("INSERT INTO patient_documents(patient_id,ortho_case_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,$2,$3,'image/png',$4,$5,$6,'synthetic') RETURNING id",[patientId,caseId,`صورة اصطناعية ${docs.length+1}`,png.length,sha,key])).rows[0].id;docs.push({id,sha});
 }return {patientId,caseId,docs};
}
const counts=async()=>(await db.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM visits) visits,(SELECT count(*)::int FROM appointments) appointments")).rows;
describe("manual facial image measurements on the built app",()=>{
 it.each([390,1280])("places, corrects, saves and reloads per-image reviews at %ipx",async width=>{
  const f=await fixture(),before=await counts(),context=await browser.newContext({viewport:{width,height:1000},locale:"ar-YE"});
  const [name,...value]=h.sessions.admin.cookie.split("=");await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
  const writes:string[]=[],unexpected:string[]=[],errors:string[]=[];const endpoint=`/api/ortho/${f.caseId}/facial-analysis`;
  await context.route("**/*",async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==baseUrl){unexpected.push(req.url());return route.abort();}if(req.method()==="POST"&&url.pathname===endpoint){writes.push(req.postData()!);const response=await route.fetch();if(width===390&&writes.length===1){expect(response.status()).toBe(201);await route.abort("failed");return;}await route.fulfill({response});return;}if(!["GET","HEAD","OPTIONS"].includes(req.method())){unexpected.push(`${req.method()} ${url.pathname}`);return route.abort();}await route.continue();});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on("pageerror",e=>errors.push(e.message));
  const root=page.getByTestId("ortho-facial-workspace"),select=root.getByLabel("الصورة المرتبطة بالحالة",{exact:true});
  try{
   await page.goto(`${baseUrl}/ortho/${f.caseId}/facial?patientId=${f.patientId}`);await select.selectOption(String(f.docs[0].id));
   await root.getByRole("button",{name:"بدء قياسات هذه الصورة",exact:true}).click();
   await root.getByLabel("إحداثي X بالبكسل").fill("500");expect(await root.getByRole("button",{name:"تطبيق الإحداثيين على المعلم"}).isDisabled()).toBe(true);
   for(const [key,point] of Object.entries(syntheticFace().landmarks)){
    if(point.state!=="located")continue;await root.getByLabel("المعلم الحالي").selectOption(key);await root.getByLabel("إحداثي X بالبكسل").fill(String(point.x*1000));await root.getByLabel("إحداثي Y بالبكسل").fill(String(point.y*1200));await root.getByRole("button",{name:"تطبيق الإحداثيين على المعلم"}).click();
   }
   // Pointer correction operates in the image's displayed geometry, not CSS pixels stored as source coordinates.
   await root.getByLabel("المعلم الحالي").selectOption("tr");const board=root.getByLabel("لوحة معالم الوجه");await board.scrollIntoViewIfNeeded();const box=await board.boundingBox();if(!box)throw Error("missing image board");
   await page.mouse.move(box.x+box.width*.5,box.y+box.height*.125);await page.mouse.down();await page.mouse.move(box.x+box.width*.51,box.y+box.height*.125);await page.mouse.up();
   expect(Number(await root.getByLabel("إحداثي X بالبكسل").inputValue())).toBeCloseTo(510,0);
   await root.getByLabel("إحداثي X بالبكسل").fill("500");await root.getByRole("button",{name:"تطبيق الإحداثيين على المعلم"}).click();
   await root.getByLabel("توضيح مصدر التاريخ").fill("مصدر اصطناعي؛ تاريخ التصوير غير معلوم");
   for(const label of ["الصورة أمامية وفي وضع الراحة","راجعت وضع الرأس والميل والدوران","المعالم المستخدمة ظاهرة بوضوح","راجعت المنظور والمسافة والعدسة وحدود المقارنة"])await root.getByLabel(label,{exact:true}).check();
   await root.getByLabel("تفسير الطبيب وملاحظة المراجعة").fill("مراجعة اصطناعية للمواضع والحساب، وليست حكماً تشخيصياً");
   await root.getByLabel("راجعت المعالم والنتائج وحدود هذه الصورة بصفتي الطبيب").check();
   await root.getByLabel("توضيح مصدر التاريخ").fill("مصدر اصطناعي متحقق؛ التاريخ غير معلوم");expect(await root.getByLabel("راجعت المعالم والنتائج وحدود هذه الصورة بصفتي الطبيب").isChecked()).toBe(false);
   await root.getByLabel("راجعت المعالم والنتائج وحدود هذه الصورة بصفتي الطبيب").check();await root.getByLabel("سبب حفظ هذه المراجعة").fill("مراجعة أولى اصطناعية");
   await root.getByRole("button",{name:"حفظ مراجعة قياسات الصورة",exact:true}).click();
   if(width===390){await root.getByRole("button",{name:"التحقق بإعادة نفس طلب قياسات الصورة",exact:true}).waitFor();expect(await select.isDisabled()).toBe(true);await root.getByRole("button",{name:"التحقق بإعادة نفس طلب قياسات الصورة",exact:true}).click();expect(writes[0]).toBe(writes[1]);}
   await root.getByText("نسخة 1 محفوظة — راجعها الطبيب",{exact:true}).waitFor();
   const rows=async()=>(await db.query("SELECT version,command,results FROM ortho_facial_revisions WHERE ortho_case_id=$1 ORDER BY version",[f.caseId])).rows;
   const initial=await rows();expect(initial).toHaveLength(1);expect(initial[0].command.content.image.sha256).toBe(f.docs[0].sha);expect(initial[0].results.measures[1].segments.map((s:{percent:number})=>Math.round(s.percent))).toEqual([20,20,20,20,20]);
   await page.reload();await select.selectOption(String(f.docs[0].id));await root.getByText("نسخة 1 محفوظة — راجعها الطبيب",{exact:true}).waitFor();
   await root.getByRole("button",{name:"فتح مراجعة جديدة من آخر نسخة",exact:true}).click();await root.getByLabel("المعلم الحالي").selectOption("tr");await root.getByLabel("سبب تعذر تحديد المعلم").fill("منبت الشعر غير واضح في المثال");await root.getByRole("button",{name:"تسجيل المعلم غير متاح"}).click();
   page.once("dialog",d=>d.dismiss());await select.selectOption(String(f.docs[1].id));expect(await select.inputValue()).toBe(String(f.docs[0].id));
   await root.getByLabel("سبب حفظ هذه المراجعة").fill("تصحيح اصطناعي موثق");await root.getByRole("button",{name:"حفظ مراجعة قياسات الصورة",exact:true}).click();await root.getByText("نسخة 2 محفوظة — بانتظار مراجعة الطبيب",{exact:true}).waitFor();
   const corrected=await rows();expect(corrected).toHaveLength(2);expect(corrected[0]).toEqual(initial[0]);expect(corrected[1].results.measures[0].state).toBe("incomplete");
   await root.getByLabel("المراجعة المحفوظة").selectOption({label:(await root.getByLabel("المراجعة المحفوظة").locator("option").allTextContents())[1]});await root.getByText("نسخة 1 محفوظة — راجعها الطبيب",{exact:true}).waitFor();expect(await root.getByRole("button",{name:"فتح مراجعة جديدة من آخر نسخة",exact:true}).isDisabled()).toBe(true);
   await page.screenshot({path:`.settings-ui-artifacts/ortho-facial-saved-${width}.png`,fullPage:true});
   await select.selectOption(String(f.docs[1].id));await root.getByRole("button",{name:"بدء قياسات هذه الصورة",exact:true}).click();expect(await root.getByLabel("إحداثي X بالبكسل").inputValue()).toBe("");expect(await board.locator("circle").count()).toBe(0);
   page.once("dialog",d=>d.accept());await select.selectOption(String(f.docs[0].id));await root.getByText("نسخة 2 محفوظة — بانتظار مراجعة الطبيب",{exact:true}).waitFor();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(await counts()).toEqual(before);expect(errors).toEqual([]);expect(unexpected).toEqual([]);
  }finally{await context.close();}
 });
 it("protects original-image reads and write admission over real HTTP",async()=>{
  const f=await fixture(),g=await fixture(),path=`/api/ortho/${f.caseId}/facial-analysis`,image=`/api/ortho/${f.caseId}/facial-image?patientId=${f.patientId}&documentId=${f.docs[0].id}&sha256=${f.docs[0].sha}`;
  const response=await fetch(`${baseUrl}${image}`,{headers:{Cookie:h.sessions.admin.cookie}});expect(response.status).toBe(200);expect(response.headers.get("content-type")).toBe("image/png");expect(response.headers.get("cache-control")).toContain("no-store");
  expect((await fetch(`${baseUrl}${image}`)).status).toBe(401);
  expect((await authedGet(image,h.sessions.accountant)).status).toBe(403);
  expect((await authedGet(`${path}?patientId=${f.patientId}&documentId=${g.docs[0].id}`,h.sessions.admin)).status).toBe(404);
  for(const role of ["reception","accountant","cashier"] as const)expect((await authedMutation(path,h.sessions[role],"POST",JSON.stringify({patientId:f.patientId,command:{}}))).status).toBe(403);
  expect((await authedMutation(path,h.sessions.admin,"POST",JSON.stringify({patientId:f.patientId,command:{}}))).status).toBe(400);
  await db.query("UPDATE patient_documents SET removed_at=now() WHERE id=$1",[f.docs[0].id]);expect((await authedGet(image,h.sessions.admin)).status).toBe(404);
 });
});
