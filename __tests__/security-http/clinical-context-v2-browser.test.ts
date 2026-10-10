import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { baseUrl, harness } from "./_server";
import { assertStrategyCiBoundary, createStrategyFixture, type StrategyFixture } from "./_ortho-strategy-live-fixture";

/** Actual Next pages/components on the built app. Data is explicitly synthetic SQL graph fixtures.
 * One pending-Ceph test holds/aborts POST transport before the server: UI refusal evidence only.
 * This suite is not a Ceph writer or clinical completion journey. */
let browser: Browser, fixture: StrategyFixture;
let newerId = 0, visitId = 0;
const studies: number[] = [];
beforeAll(async () => {
  assertStrategyCiBoundary(); const h = await harness();
  fixture = await createStrategyFixture(h, "V2 native navigation", { status: "completed", permissions: { canViewXrays: true, canUploadXrays: true } });
  newerId = (await fixture.db.query<{ id: number }>(`INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,$2,'active') RETURNING id`, [fixture.patientId, fixture.username])).rows[0].id;
  await fixture.db.query(`INSERT INTO clinical_cases(patient_id,specialty,title,site,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic later case','upper and lower',$2,$3)`, [fixture.patientId, newerId, fixture.username]);
  visitId = (await fixture.db.query<{ id: number }>(`INSERT INTO visits(patient_id,patient_name,doctor_id,status) VALUES($1,'Synthetic unrecorded visit',$2,'done') RETURNING id`, [fixture.patientId, fixture.partyId])).rows[0].id;
  for (const tooth of [36,46]) {
    const clinical = (await fixture.db.query<{ id: number }>(`INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by) VALUES($1,'endodontics',$2,$3,$4) RETURNING id`, [fixture.patientId, `Synthetic Endo ${tooth}`, String(tooth), fixture.username])).rows[0].id;
    await fixture.db.query("INSERT INTO endo_treatments(patient_id,case_id,tooth_code,created_by) VALUES($1,$2,$3,$4)", [fixture.patientId,clinical,tooth,fixture.username]);
  }
  await fixture.db.query("INSERT INTO services(name,category,price_minor) VALUES($1,'filling',1000),($2,'filling',2000)", [`Synthetic A ${fixture.uuid}`,`Synthetic B ${fixture.uuid}`]);
  const documentId = (await fixture.db.query<{ id: number }>(`INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
    VALUES($1,'xray','Synthetic UI image metadata','image/png',1,$2,$3,$4) RETURNING id`, [fixture.patientId,'0'.repeat(64),`synthetic-${fixture.uuid}.png`,fixture.username])).rows[0].id;
  for (let index=0;index<2;index++) {
    const analysisId = (await fixture.db.query<{ id: number }>(`INSERT INTO ceph_analyses(patient_id,document_id,ortho_case_id,status,created_by,completed_by,completed_at,phase)
      VALUES($1,$2,$3,'completed',$4,$4,NOW(),'pretreatment') RETURNING id`, [fixture.patientId,documentId,fixture.orthoCaseId,fixture.username])).rows[0].id;
    studies.push(Number(analysisId));
    await fixture.db.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'ANB',3)", [analysisId]);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
},120000);
afterAll(async()=>{await browser?.close();await fixture?.close();});
const href = (sub: string, extra: string) => `${baseUrl}/patients/${fixture.patientId}?tab=treatment&sub=${sub}&${extra}`;
async function mount() {
  const context = await browser.newContext({ viewport:{width:390,height:900},locale:"ar-YE" });
  const [name,...rest]=fixture.session.cookie.split("=");await context.addCookies([{name,value:rest.join("="),url:baseUrl}]);
  const page=await context.newPage();page.setDefaultTimeout(20000);return {context,page};
}
const ready = (page: Page) => page.locator('[data-testid="patient-ortho-workspace"][data-read-state="ready"]').waitFor();
describe("V2 exact native traversal and dirty/pending guards",()=>{
  it("real Back/Forward retains the requested closed/new case without a latest-case fallback",async()=>{
    const {page,context}=await mount();try{
      await page.goto(href("ortho",`orthoCaseId=${fixture.orthoCaseId}&pillar=diagnostics`));await ready(page);
      await page.goto(href("ortho",`orthoCaseId=${newerId}&pillar=wires`));await ready(page);
      await page.goBack();await page.getByTestId(`ortho-case-${fixture.orthoCaseId}`).waitFor();
      expect(await page.getByTestId(`ortho-case-${newerId}`).count()).toBe(0);
      expect(new URL(page.url()).searchParams.get("pillar")).toBe("diagnostics");
      await page.goForward();await page.getByTestId(`ortho-case-${newerId}`).waitFor();
      expect(await page.getByTestId(`ortho-case-${fixture.orthoCaseId}`).count()).toBe(0);
    }finally{await context.close();}
  },120000);
  it("service-only and billing-rule-only plan drafts block tab departure",async()=>{
    const {page,context}=await mount();try{
      await page.goto(href("plans",`planId=${fixture.planId}`));
      const service=page.getByLabel("خدمة الخطة",{exact:true});await service.waitFor();
      await expect.poll(()=>service.locator("option").count()).toBeGreaterThan(2);
      const original=await service.inputValue();
      const other=await service.locator("option").evaluateAll((options,original)=>options.map((node)=>(node as HTMLOptionElement).value).find((value)=>value!==""&&value!==original)!,original);
      await service.selectOption(other);
      let dialogs=0;page.on("dialog",async dialog=>{dialogs++;await dialog.dismiss();});
      await page.getByTestId("patient-subtab-cases").click();
      expect(dialogs).toBe(1);expect(await service.inputValue()).toBe(other);
      await service.selectOption(original);
      const billing=page.getByLabel("قاعدة فوترة البند",{exact:true});
      const alternative=await billing.locator("option").evaluateAll(options=>options.map(node=>(node as HTMLOptionElement).value).find(value=>value!=="on_completion")!);
      await billing.selectOption(alternative);await page.getByTestId("patient-subtab-cases").click();
      expect(dialogs).toBe(2);expect(await billing.inputValue()).toBe(alternative);
      expect(new URL(page.url()).searchParams.get("sub")).toBe("plans");
    }finally{await context.close();}
  },120000);
  it("plan-only and visit-only Endo entries require a deliberate episode choice",async()=>{
    const {page,context}=await mount();try{
      for(const query of [`planId=${fixture.planId}`,`visitId=${visitId}`]){
        await page.goto(href("endo",query));await page.getByTestId("endo-context-selection").waitFor();
        expect(await page.getByTestId("endo-strip-status").count()).toBe(0);
        expect(await page.getByTestId("endo-record").count()).toBe(0);
      }
    }finally{await context.close();}
  },120000);
  it("all three actual Next Ceph links honor dirty and pending creation guards",async()=>{
    const {page,context}=await mount();let held:Route|undefined;try{
      await page.goto(href("ortho",`orthoCaseId=${fixture.orthoCaseId}&pillar=diagnostics`));await ready(page);
      await page.getByTestId("ceph-open-latest").waitFor();
      for(const id of studies)await page.getByLabel(`تحديد ${id} للمقارنة`,{exact:true}).check();
      await page.getByRole("button",{name:"+ دراسة سيفالومترية جديدة",exact:true}).click();
      let dialogs=0;page.on("dialog",async dialog=>{dialogs++;await dialog.dismiss();});
      const starting=page.url();
      const links=[page.getByTestId("ceph-open-latest"),page.getByTestId("ceph-open-comparison"),page.getByTestId(`ceph-open-study-${studies[0]}`)];
      for(const link of links){await link.click();expect(page.url()).toBe(starting);}
      expect(dialogs).toBe(3);
      await page.route(`**/api/patients/${fixture.patientId}/ceph`,route=>{
        if(route.request().method()==="POST"){held=route;return;}return route.continue();
      });
      await page.getByRole("button",{name:"📐 افتح مساحة التتبع والتحليل",exact:true}).click();
      await expect.poll(()=>held!==undefined).toBe(true);
      for(const link of links){await link.click();expect(page.url()).toBe(starting);}
      expect(dialogs).toBe(3); // Pending commands block, with no discard confirmation.
      await held!.abort();held=undefined;
    }finally{if(held)await held.abort();await context.close();}
  },120000);
});
