import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { computeAll, type LandmarkMap } from "../../lib/ceph";
import { baseUrl, harness, authedMutation } from "./_server";

// Real built application, isolated PostgreSQL and synthetic rows. No response or CSS replacement.
let browser: Browser, db: Client, h: Awaited<ReturnType<typeof harness>>, patientId: number, orthoId: number;
const evidence = process.env.PATIENT_VISUAL_OUTPUT ?? ".settings-ui-artifacts/patient-premium";
beforeAll(async () => {
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = (await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  patientId = (await db.query(`INSERT INTO patients (patient_number,full_name,phone,gender,birth_date,primary_doctor_id,medical_alert)
    VALUES ($1,'أحمد محمد — ملف اصطناعي','777123456','male','1998-01-15',$2,'حساسية بنسلين — تنبيه اختبار اصطناعي') RETURNING id`, [`VISUAL-${Date.now()}`, doctor])).rows[0].id;
  for (const [title, currency, total] of [["خطة ترميم الأسنان", "YER", 30000000], ["خطة متابعة مستقلة", "SAR", 300000], ["خطة مستقلة بالدولار", "USD", 20000]] as const) {
    const plan = (await db.query(`INSERT INTO treatment_plans (patient_id,title,total_minor,base_currency,status,consent_at) VALUES ($1,$2,$3,$4,'active',NOW()) RETURNING id`, [patientId,title,total,currency])).rows[0].id;
    await db.query(`INSERT INTO plan_items (plan_id,service_name,tooth_code,unit_price_minor,status) VALUES ($1,'حشوة تجريبية',26,$2,'done'),($1,'متابعة تجريبية',36,$2,'planned')`,[plan,total / 2]);
  }
  await db.query(`INSERT INTO visits (patient_name,patient_id,doctor_id,status) VALUES ('أحمد محمد — ملف اصطناعي',$1,$2,'in_chair')`,[patientId,doctor]);
  for (const [currency, amount] of [["YER",2500000],["SAR",15000],["USD",5000]] as const) {
    await db.query(`INSERT INTO invoices (invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES ($1,$2,$3,0,$4,'secadmin')`,[`VISUAL-INV-${currency}-${Date.now()}`,patientId,amount,currency]);
  }
  const caseId = (await db.query(`INSERT INTO clinical_cases (patient_id,specialty,title,responsible_party_id,created_by) VALUES ($1,'endodontics','حالة عصب اصطناعية — سن 36',$2,'secadmin') RETURNING id`,[patientId,doctor])).rows[0].id;
  await db.query(`INSERT INTO endo_treatments (patient_id,case_id,tooth_code,created_by) VALUES ($1,$2,36,'secadmin')`,[patientId,caseId]);
  orthoId = (await db.query(`INSERT INTO ortho_cases (patient_id,created_by,bracket_system,upper_wire,lower_wire) VALUES ($1,'secadmin','SYNTHETIC','014 NiTi','012 NiTi') RETURNING id`,[patientId])).rows[0].id;
  await db.query(`INSERT INTO appointments (patient_id,scheduled_date,scheduled_time,duration_minutes,status,doctor_id) VALUES ($1,CURRENT_DATE + 4,'18:00',30,'booked',$2)`,[patientId,doctor]);
  await db.query(`INSERT INTO lab_orders (patient_id,lab_name,work_type,due_date,status) VALUES ($1,'مختبر اصطناعي','تاج اصطناعي — سن 26',CURRENT_DATE + 7,'sent')`,[patientId]);
  const history = await authedMutation(`/api/patients/${patientId}/medical-history`,h.sessions.admin,"POST",JSON.stringify({answers:{},allergies:[{substance:"بنسلين — اصطناعي",reaction:"تنبيه اختبار",severity:"severe"}],medications:[],asaClass:"II",bloodGroup:null,patientConfirmed:false,notes:"سجل اصطناعي للمراجعة البصرية"}));
  expect(history.status,await history.text()).toBe(201);
  const imageBytes = await readFile("__tests__/fixtures/patient-premium-synthetic.png");
  let xrayId = 0;
  for (const kind of ["xray","photo"]) {
    const form = new FormData(); form.set("file",new Blob([imageBytes],{type:"image/png"}),`synthetic-${kind}.png`); form.set("kind",kind); form.set("title",kind === "xray" ? "ملف اختبار اصطناعي — ليس أشعة تشخيصية" : "صورة اصطناعية للمعاينة");
    const response = await fetch(`${baseUrl}/api/patients/${patientId}/documents`,{method:"POST",headers:{Cookie:h.sessions.admin.cookie,Origin:baseUrl},body:form});
    const uploaded = await response.json(); expect(response.status,JSON.stringify(uploaded)).toBe(201);
    if (kind === "xray") xrayId = uploaded.id;
  }
  const points: LandmarkMap = {
    S:{x:0,y:0},N:{x:69,y:-8},A:{x:67.57,y:51.98},B:{x:63.84,y:79.85},
    Pog:{x:64.03,y:86.87},Me:{x:60,y:105},Gn:{x:61.5,y:95.5},Go:{x:-17.03,y:69.08},
    Or:{x:60,y:-25},Po:{x:0,y:-25},U1A:{x:60,y:34},U1:{x:74.08,y:71.44},
    L1A:{x:68,y:64},L1:{x:49,y:99.2},OcclA:{x:70,y:48},OcclP:{x:0,y:35.3},
    D:{x:62,y:95},Co:{x:-45,y:38},ANS:{x:78,y:44},PNS:{x:-5,y:36},
  };
  await db.query("BEGIN");
  try {
    const study=(await db.query(`INSERT INTO ceph_analyses (patient_id,document_id,ortho_case_id,status,phase,created_by,completed_by,completed_at,cal_x1,cal_y1,cal_x2,cal_y2,cal_mm,mm_per_pixel)
      VALUES ($1,$2,$3,'completed','pretreatment','secdoctora','secdoctora',NOW(),0,0,100,0,100,1) RETURNING id`,[patientId,xrayId,orthoId])).rows[0].id;
    for (const [code,point] of Object.entries(points)) if(point) await db.query(`INSERT INTO ceph_landmarks (analysis_id,code,x,y,source,confirmed_by) VALUES ($1,$2,$3,$4,'manual','secdoctora')`,[study,code,point.x,point.y]);
    for (const row of computeAll(points,1)) if(row.value !== null) await db.query("INSERT INTO ceph_measurements (analysis_id,code,value) VALUES ($1,$2,$3)",[study,row.code,row.value]);
    await db.query(`INSERT INTO ceph_diagnoses (analysis_id,final_dx,created_by) VALUES ($1,'استنتاج اصطناعي لا يُستخدم للتشخيص','secdoctora')`,[study]);
    await db.query("COMMIT");
  } catch(error) {await db.query("ROLLBACK");throw error;}
  const referral=await authedMutation(`/api/patients/${patientId}/referrals`,h.sessions.doctorA,"POST",JSON.stringify({kind:"external",toName:"جهة اختبار اصطناعية",toSpecialty:"oral_surgery",reason:"تقييم اصطناعي للسن 36 — لا ترسل خارج البيئة",teeth:"36",urgency:"routine"}));
  expect(referral.status,await referral.text()).toBe(201);
  const item=(await db.query(`INSERT INTO inventory_items (name,unit,created_by) VALUES ('مادة اصطناعية للتجربة','وحدة','secadmin') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO inventory_movements (item_id,kind,qty,reason,created_by) VALUES ($1,'in',10,'رصيد اختبار معزول','secadmin')`,[item]);
  const material=await authedMutation(`/api/inventory/${item}/movements`,h.sessions.admin,"POST",JSON.stringify({kind:"out",qty:1,reason:"استهلاك اصطناعي — لا شراء حقيقي",patientId}));
  expect(material.status,await material.text()).toBe(201);
  await mkdir(evidence,{recursive:true});
  browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
},240_000);
afterAll(async()=>{ await browser?.close(); await db?.end(); });

describe("patient premium real application evidence",()=>{
  it.each([1448,1280,390])("captures all 15 reference scenes and real file-preview interaction at %ipx",async width=>{
    const context=await browser.newContext({viewport:{width,height:1024},locale:"ar-YE",serviceWorkers:"block"});
    const [name,...value]=h.sessions.admin.cookie.split("=");
    await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage(); const errors:string[]=[];
    page.on("pageerror",e=>errors.push(e.message));
    // Block external services without substituting any application response.
    await context.route("**/*",async route=>new URL(route.request().url()).origin===baseUrl ? route.continue() : route.abort());
    try {
      const scenes = [
        {name:"summary",tab:"summary"}, {name:"account",tab:"account"}, {name:"treatment",tab:"treatment",sub:"chart"},
        {name:"today",tab:"today"}, {name:"files",tab:"files"},
        ...["plans","cases","endo","ortho","lab","referrals","materials"].map(sub=>({name:sub,tab:"treatment",sub})),
        {name:"personal-details",tab:"summary"}, {name:"medical-history",tab:"summary"}, {name:"cephalometric",tab:"treatment",sub:"ortho"},
      ];
      for(const scene of scenes){
        const {tab,name:sceneName}=scene;
        const extra = "sub" in scene ? `&sub=${scene.sub}` : "";
        const ceph = sceneName === "cephalometric" ? `&orthoCaseId=${orthoId}&pillar=diagnostics` : "";
        await page.goto(`${baseUrl}/patients/${patientId}?tab=${tab}${extra}${ceph}`,{waitUntil:"networkidle"});
        await page.getByTestId(`patient-tab-${tab}`).waitFor();
        await page.evaluate(async()=>{await document.fonts.ready;});
        expect(await page.getByTestId(`patient-tab-${tab}`).getAttribute("aria-current")).toBe("page");
        expect(await page.getByTestId("patient-medical-alert-banner").isVisible()).toBe(true);
        expect(await page.getByTestId("patient-medical-alert-banner").count()).toBe(1);
        const warnings=page.getByTestId("patient-medical-alert-banner");
        expect(await warnings.innerText()).toContain("تنبيه اختبار اصطناعي");
        expect(await page.getByTestId("patient-readiness-alerts").innerText()).toContain("شديدة");
        expect(await page.getByTestId("patient-readiness-alerts").innerText()).not.toContain("تنبيه اختبار اصطناعي");
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
        if(sceneName === "personal-details") await page.getByRole("navigation",{name:"تفاصيل الملخص"}).getByRole("button",{name:"البيانات الشخصية",exact:true}).click();
        if(sceneName === "lab") await page.getByRole("button",{name:"+ طلب معمل جديد",exact:true}).click();
        if(sceneName === "referrals") await page.getByRole("button",{name:"+ إحالة جديدة",exact:true}).click();
        if(sceneName === "materials") await page.getByRole("button",{name:"+ صرف مادة من المخزن",exact:true}).first().click();
        if(sceneName === "medical-history") await page.getByRole("navigation",{name:"تفاصيل الملخص"}).getByRole("button",{name:"التاريخ الطبي",exact:true}).click();
        if(sceneName === "files") {
          expect(await page.getByTestId("patient-document-gallery").count()).toBe(1);
          expect(await page.getByTestId("patient-document-card").count()).toBe(2);
          if(width === 390) {
            const sizes=await page.getByRole("region",{name:"تصنيفات المستندات"}).getByRole("button").evaluateAll(buttons=>buttons.map(button=>button.getBoundingClientRect().height));
            expect(sizes.every(height=>height >= 44)).toBe(true);
            const actionSizes=await page.getByRole("group",{name:"إجراءات المستند المحدد"}).getByRole("button").evaluateAll(buttons=>buttons.map(button=>button.getBoundingClientRect().height));
            expect(actionSizes.every(height=>height >= 44)).toBe(true);
          }
          const preview=page.getByRole("region",{name:"معاينة المستند المحدد"});
          await expect.poll(()=>preview.locator("img").evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBe(900);
          await preview.getByRole("button",{name:"عرض بالحجم الكامل",exact:true}).click();
          expect(await page.getByRole("dialog").isVisible()).toBe(true);
          await page.keyboard.press("Escape"); expect(await page.getByRole("dialog").count()).toBe(0);
          expect(await preview.getByRole("button",{name:"عرض بالحجم الكامل",exact:true}).evaluate(el=>el===document.activeElement)).toBe(true);
        }
        await page.evaluate(()=>window.scrollTo(0,0));
        await page.screenshot({path:`${evidence}/${sceneName}-${width}.png`});
        await page.screenshot({path:`${evidence}/${sceneName}-${width}-full.png`,fullPage:true});
        await writeFile(`${evidence}/${sceneName}-${width}-geometry.json`,JSON.stringify(await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,headings:[...document.querySelectorAll("h1,h2,h3")].map(el=>({text:el.textContent,y:el.getBoundingClientRect().y})), tabs:document.querySelector('[aria-label="أقسام ملف المريض"]')?.getBoundingClientRect().toJSON()})),null,2));
        // Preserve a full-frame comparison and separately prove the deeper canonical workspace.
        const detail = sceneName === "cephalometric" ? page.getByTestId("patient-ceph-summary")
          : sceneName === "ortho" ? page.getByTestId("patient-ortho-workspace").locator(":scope > ul")
          : sceneName === "plans" ? page.getByTestId("patient-plans-content").locator(":scope > ul")
          : sceneName === "endo" ? page.getByTestId("endo-strip") : null;
        if(detail) {
          await detail.waitFor();
          await detail.evaluate(el=>el.scrollIntoView({block:"start"}));
          await page.evaluate(()=>window.scrollBy(0,-80));
          if(sceneName === "cephalometric") {
            expect(await detail.innerText()).toContain("ANB");
            await expect.poll(()=>detail.locator("img").evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBe(900);
          }
          await page.screenshot({path:`${evidence}/${sceneName}-${width}-detail.png`});
        }
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});

describe("premium UI authority and draft ownership",()=>{
  it.each([1448,1280,390])("retains upload draft after refused navigation and preserves preview focus at %ipx",async width=>{
    const context=await browser.newContext({viewport:{width,height:1024},locale:"ar-YE",serviceWorkers:"block"});
    const [name,...value]=h.sessions.admin.cookie.split("="); await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage();
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=files`,{waitUntil:"networkidle"});
      await page.getByRole("button",{name:"رفع ملف جديد",exact:true}).click();
      await page.getByLabel("وصف المستند",{exact:true}).fill("مسودة رفع اصطناعية محفوظة");
      const refused=page.waitForEvent("dialog").then(async dialog=>{expect(dialog.type()).toBe("confirm");await dialog.dismiss();});
      await page.getByTestId("patient-tab-summary").click(); await refused;
      expect(await page.getByTestId("patient-tab-files").getAttribute("aria-current")).toBe("page");
      expect(await page.getByLabel("وصف المستند",{exact:true}).inputValue()).toBe("مسودة رفع اصطناعية محفوظة");
      const accepted=page.waitForEvent("dialog").then(dialog=>dialog.accept());
      await page.getByTestId("patient-tab-summary").click(); await accepted;
      await page.getByTestId("summary-current-work").waitFor();
      const currencies=page.getByRole("group",{name:"عملات ملخص الحساب"});
      for(const label of ["ريال سعودي","دولار","ريال يمني"]) {
        await currencies.getByRole("button",{name:label,exact:true}).click();
        expect(await currencies.getByRole("button",{name:label,exact:true}).getAttribute("aria-pressed")).toBe("true");
      }
      const account=page.getByRole("region",{name:"الحساب",exact:true});
      expect(await page.getByRole("button",{name:"تحصيل دفعة",exact:true}).count()).toBe(1);
      const disclosures=account.locator("details");
      expect(await disclosures.count()).toBe(3);
      for(const disclosure of await disclosures.all()) {
        expect(await disclosure.getAttribute("open")).toBeNull();
        await disclosure.locator("summary").click();
        expect(await disclosure.getByText("تم فوترة",{exact:true}).isVisible()).toBe(true);
        expect(await disclosure.getByText("المديونية الحالية",{exact:true}).isVisible()).toBe(true);
        await disclosure.locator("summary").click();
        expect(await disclosure.getAttribute("open")).toBeNull();
      }
      const select=page.getByLabel("الخطة المعروضة في الملخص",{exact:true});
      const choices=await select.locator("option").evaluateAll(options=>options.map(option=>({value:(option as HTMLOptionElement).value,title:option.textContent})));
      expect(choices.length).toBe(3);
      for(const choice of choices) {
        await select.selectOption(choice.value);
        expect(await page.getByRole("region",{name:"تقدم الخطة المختارة"}).innerText()).toContain(choice.title);
        expect(await page.getByRole("progressbar",{name:"تقدم الخطة المعروضة"}).getAttribute("aria-valuenow")).toBe("50");
      }
    } finally {await context.close();}
  });
  it.each(["doctorA","reception"] as const)("keeps %s authority from the real server",async who=>{
    const context=await browser.newContext({viewport:{width:1280,height:1024},serviceWorkers:"block"});
    const [name,...value]=h.sessions[who].cookie.split("="); await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage();
    const pending=new Set<string>();
    const bookingReads:string[]=[];
    page.on("request",request=>{if(new URL(request.url()).pathname === "/api/booking-requests") bookingReads.push(request.url());});
    page.on("request",request=>pending.add(request.url()));
    page.on("requestfinished",request=>pending.delete(request.url()));
    page.on("requestfailed",request=>pending.delete(request.url()));
    try {
      try { await page.goto(`${baseUrl}/patients/${patientId}?tab=summary`,{waitUntil:"networkidle"}); }
      catch(error) { throw new Error(`Navigation pending: ${[...pending].join(", ")}; ${await page.locator("body").innerText()}`,{cause:error}); }
      await page.getByTestId("summary-current-work").waitFor();
      expect(await page.getByTestId("patient-medical-alert-banner").isVisible()).toBe(true);
      expect(await page.getByTestId("patient-premium-account-overview").count()).toBe(who === "doctorA" ? 0 : 1);
      if(who === "doctorA") expect(bookingReads).toEqual([]);
      await page.getByTestId("patient-tab-account").click();
      if(who === "doctorA") {
        await page.getByRole("alert",{name:"خطأ حساب المريض"}).waitFor();
        expect(await page.getByTestId("account-canonical-balance").count()).toBe(0);
      } else await page.getByTestId("account-canonical-balance").first().waitFor();
    } finally {await context.close();}
  });
  it.each([1448,1280,390])("saves a real medical version after protecting its draft at %ipx",async width=>{
    const context=await browser.newContext({viewport:{width,height:1024},locale:"ar-YE",serviceWorkers:"block"});
    const [name,...value]=h.sessions.admin.cookie.split("="); await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage();
    const before=(await db.query("SELECT id,total_minor,discount_minor FROM invoices WHERE patient_id=$1 ORDER BY id",[patientId])).rows;
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=summary`,{waitUntil:"networkidle"});
      await page.getByRole("navigation",{name:"تفاصيل الملخص"}).getByRole("button",{name:"التاريخ الطبي",exact:true}).click();
      const trigger=page.getByRole("button",{name:"تحديث التاريخ الطبي",exact:true}); await trigger.click();
      const dialog=page.getByRole("dialog",{name:"الاستبيان الطبي"});
      const note=`مراجعة اصطناعية محفوظة عبر المتصفح ${width}`;
      await dialog.getByLabel("ملاحظات طبية",{exact:true}).fill(note);
      const refused=page.waitForEvent("dialog").then(d=>d.dismiss()); await page.keyboard.press("Escape"); await refused;
      expect(await dialog.isVisible()).toBe(true);
      expect(await dialog.getByLabel("ملاحظات طبية",{exact:true}).inputValue()).toBe(note);
      const saved=page.waitForResponse(r=>r.url().endsWith(`/api/patients/${patientId}/medical-history`) && r.request().method()==="POST");
      await dialog.getByRole("button",{name:"حفظ نسخة جديدة",exact:true}).click(); expect((await saved).status()).toBe(201);
      await expect.poll(()=>dialog.count()).toBe(0);
      await expect.poll(()=>page.getByRole("region",{name:"التاريخ الطبي العام",exact:true}).innerText()).toContain(note);
      expect(await trigger.evaluate(el=>el===document.activeElement)).toBe(true);
      expect((await db.query("SELECT id,total_minor,discount_minor FROM invoices WHERE patient_id=$1 ORDER BY id",[patientId])).rows).toEqual(before);
      expect(await page.getByTestId("patient-medical-alert-banner").isVisible()).toBe(true);
    } finally {await context.close();}
  });
  it.each([1448,1280,390])("uploads through the original form and keeps only the selected input at %ipx",async width=>{
    const context=await browser.newContext({viewport:{width,height:1024},locale:"ar-YE",serviceWorkers:"block"});
    const [name,...value]=h.sessions.admin.cookie.split("="); await context.addCookies([{name,value:value.join("="),url:baseUrl}]);
    const page=await context.newPage();
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=files`,{waitUntil:"networkidle"});
      await page.getByRole("button",{name:"رفع ملف جديد",exact:true}).click();
      const title=`رفع من النموذج الفعلي — اصطناعي ${width}`;
      await page.getByLabel("وصف المستند",{exact:true}).fill(title);
      const file=page.getByLabel("ملف الأشعة",{exact:true}), camera=page.getByLabel("كاميرا التصوير",{exact:true});
      await file.setInputFiles("__tests__/fixtures/patient-premium-synthetic.png");
      await camera.setInputFiles("__tests__/fixtures/patient-premium-synthetic.png");
      expect(await file.evaluate(el=>(el as HTMLInputElement).files?.length)).toBe(0);
      await file.setInputFiles("__tests__/fixtures/patient-premium-synthetic.png");
      expect(await camera.evaluate(el=>(el as HTMLInputElement).files?.length)).toBe(0);
      const saved=page.waitForResponse(r=>r.url().endsWith(`/api/patients/${patientId}/documents`) && r.request().method()==="POST");
      await page.locator("form").filter({has:page.getByLabel("وصف المستند",{exact:true})}).locator('button[type="submit"]').click();
      const response=await saved; expect(response.status()).toBe(201);
      const uploaded=await response.json(); expect(uploaded.title).toBe(title);
      expect(await page.getByTestId("patient-document-gallery").count()).toBe(1);
      await expect.poll(()=>page.getByRole("button").filter({hasText:title}).count()).toBe(1);
      const item=page.getByRole("region",{name:"اختيار ملف للمعاينة"}).getByRole("button").filter({hasText:title}); await item.click();
      await expect.poll(()=>page.getByRole("region",{name:"معاينة المستند المحدد"}).locator("img").evaluate(img=>(img as HTMLImageElement).naturalWidth)).toBe(900);
      const actions=page.getByRole("group",{name:"إجراءات المستند المحدد"});
      expect(await actions.getByRole("button",{name:"اجعلها صورة المريض",exact:true}).count()).toBe(1);
      expect(await actions.getByRole("button",{name:"مقارنة",exact:true}).count()).toBe(1);
      const removal=page.waitForResponse(r=>r.url().endsWith(`/api/documents/${uploaded.id}`) && r.request().method()==="DELETE");
      const note=page.waitForEvent("dialog").then(dialog=>dialog.accept("إخفاء اصطناعي للتحقق من القائمة الموحدة"));
      await actions.getByRole("button",{name:"أخفِ",exact:true}).click(); await note;
      expect((await removal).status()).toBe(200);
      await expect.poll(()=>page.getByTestId("patient-document-gallery").getByRole("button").filter({hasText:title}).count()).toBe(0);
      await page.getByRole("region",{name:"تصنيفات المستندات"}).getByRole("button",{name:/المستندات المخفية/}).click();
      const hidden=page.getByTestId("patient-document-gallery").getByRole("button").filter({hasText:title});
      expect(await hidden.count()).toBe(1); await hidden.click();
      expect(await actions.innerText()).toContain("إخفاء اصطناعي للتحقق من القائمة الموحدة");
      expect(await actions.getByRole("button",{name:"أخفِ",exact:true}).count()).toBe(0);
      const persisted=await db.query("SELECT removed_at, removed_note FROM patient_documents WHERE id=$1 AND patient_id=$2",[uploaded.id,patientId]);
      expect(persisted.rows).toHaveLength(1); expect(persisted.rows[0].removed_at).not.toBeNull();
      await page.getByTestId("patient-tab-summary").click();
      await page.getByTestId("summary-current-work").waitFor();
    } finally {await context.close();}
  });
  it("denies an unrelated doctor's patient/documents reads",async()=>{
    for(const path of [`/api/patients/${patientId}`,`/api/patients/${patientId}/documents`]) {
      const response=await fetch(baseUrl+path,{headers:{Cookie:h.sessions.doctorB.cookie}});
      expect(response.status).toBe(403);
    }
  });
});
