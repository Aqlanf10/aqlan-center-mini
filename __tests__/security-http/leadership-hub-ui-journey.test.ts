import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import { harness } from "./_server";
import { openHrJourneyServer } from "./_hr-isolated-server";
import { leadershipFinancialFixture } from "../fixtures/leadership-financial";
let h: Awaited<ReturnType<typeof harness>>, owned: Awaited<ReturnType<typeof openHrJourneyServer>>, browser: Browser;
let patient: number, carePlan: number, day: string;
const evidenceDir="/tmp/leadership-hub-evidence";
const captureStates=["populated","day","lab","tasks","empty","error","finance-cash","finance-billing","finance-debts","finance-period"] as const;
const captureNames=new Set([1440,390].flatMap(width=>captureStates.map(state=>`leadership-hub-${state}-${width}.png`)));
captureNames.add("leadership-hub-finance-period-zoom-390.png");
captureNames.add("leadership-hub-overview-zoom-390.png");
const evidenceDescription="Owned synthetic clinic overview; typed synthetic finance transport for visual coverage; not Production performance";
beforeAll(async()=>{
 h=await harness();owned=await openHrJourneyServer(h);const db=owned.db;
 day=(await db.query("SELECT (statement_timestamp() AT TIME ZONE 'Asia/Aden')::date::text AS day")).rows[0].day;
 const admin=Number((await db.query("SELECT id FROM users WHERE username='secadmin'")).rows[0].id);
 const other=Number((await db.query("SELECT id FROM users WHERE username='secdoctora'")).rows[0].id);
 const doctor=Number((await db.query("INSERT INTO parties(name,kind) VALUES ('طبيب متابعة اصطناعي','doctor') RETURNING id")).rows[0].id);
 patient=Number((await db.query("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-LEAD-HUB','مريض متابعة اصطناعي') RETURNING id")).rows[0].id);
 await db.query("INSERT INTO visits(patient_name,patient_id,status,doctor_id,arrived_at) VALUES ('مريض متابعة اصطناعي',$1,'waiting',$2,GREATEST(statement_timestamp()-INTERVAL '45 minutes',((statement_timestamp() AT TIME ZONE 'Asia/Aden')::date)::timestamp AT TIME ZONE 'Asia/Aden'))",[patient,doctor]);
 await db.query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,doctor_id) VALUES ($1,$2,'16:00','no_show',$3),($1,$2,'17:00','cancelled',$3)",[patient,day,doctor]);
 carePlan=Number((await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,status,start_date) VALUES ($1,'خطة علاج اصطناعية متعددة الخطوات',3000,'YER','active','2000-01-01') RETURNING id",[patient])).rows[0].id);
 await db.query("INSERT INTO plan_items(plan_id,service_name,quantity,unit_price_minor,status) VALUES ($1,'حشوة اصطناعية مخططة',1,1000,'planned'),($1,'علاج اصطناعي جارٍ',1,1000,'in_progress'),($1,'علاج اصطناعي مكتمل',1,1000,'done')",[carePlan]);
 await db.query("INSERT INTO lab_orders(patient_id,lab_name,work_type,status,sent_date,due_date,received_at) VALUES ($1,'معمل اصطناعي','تاج خزفي','received','2000-01-01','2000-01-10','2000-01-11T12:00:00Z'),($1,'معمل اصطناعي','جسر خزفي','sent','2000-01-01','2000-01-10',NULL)",[patient]);
 const staff=Number((await db.query("INSERT INTO hr_staff(full_name,created_by) VALUES ('مسؤول متابعة اصطناعي','synthetic') RETURNING id")).rows[0].id);
 const task=Number((await db.query("INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by,assignee_staff_id,assignee_label,due_at,status) VALUES ('تأكيد موعد التجربة',$1,'مالك اصطناعي','synthetic',$2,'مسؤول متابعة اصطناعي','2000-01-12','blocked') RETURNING id",[admin,staff])).rows[0].id);
 await db.query("INSERT INTO hr_task_events(task_id,actor_user_id,actor_display_name,action) VALUES ($1,$2,'مسجّل إجراء مختلف','comment')",[task,other]);
 await db.query("INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by,is_private,due_at) VALUES ('OTHER-PRIVATE-HUB-TASK',$1,'خاص','synthetic',TRUE,'1999-01-01')",[other]);
 await db.query("INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by,is_private,due_at) VALUES ('OWN-PRIVATE-HUB-TASK',$1,'خاص بالإدارة','synthetic',TRUE,'1999-01-01')",[admin]);
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
},180000);
afterAll(async()=>{await browser?.close();await owned?.close();});
async function context(width:number):Promise<BrowserContext>{
 const ctx=await browser.newContext({viewport:{width,height:960},locale:"ar-YE"});const[name,...value]=h.sessions.admin.cookie.split("=");
 await ctx.addCookies([{name,value:value.join("="),url:owned.baseUrl}]);await ctx.route("**/*",route=>new URL(route.request().url()).origin===owned.baseUrl?route.continue():route.abort());return ctx;
}
async function snapshot(){const out:Record<string,unknown>={};for(const table of ["visits","appointments","treatment_plans","plan_items","lab_orders","lab_order_tracking","hr_tasks","hr_task_events","hr_task_links","payables","expenses"])out[table]=(await owned.db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;return out;}
async function usableViewport(page: Page) {
  return page.locator("header.sticky, div.sticky, nav.fixed").evaluateAll(elements => {
    let top = 0, bottom = innerHeight;
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.top <= 1 && rect.bottom > 0 && rect.height < innerHeight / 2) top = Math.max(top, rect.bottom);
      if (getComputedStyle(element).position === "fixed" && rect.bottom >= innerHeight - 1 && rect.top > 0) bottom = Math.min(bottom, rect.top);
    }
    return { top: top + 12, bottom: bottom - 12, width: innerWidth };
  });
}
/** Native input only: never scroll the DOM, hide chrome, inject styles or resize
 * the viewport to make a tall panel appear to fit. Each relevant slice must fit
 * between the real shell bars, and each visible control must be reachable. */
async function wheelIntoView(page: Page, targets: Locator[]) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const bounds = await usableViewport(page), boxes = await Promise.all(targets.map(target => target.boundingBox()));
    if (boxes.some(box => !box)) throw new Error("Viewport target has no rendered box");
    const rendered = boxes.filter(box => box !== null);
    const top = Math.min(...rendered.map(box => box.y)), bottom = Math.max(...rendered.map(box => box.y + box.height));
    expect(bottom - top, "Representative slice must fit the actual usable viewport").toBeLessThanOrEqual(bounds.bottom - bounds.top);
    if (top >= bounds.top && bottom <= bounds.bottom) return bounds;
    const delta = top < bounds.top ? top - bounds.top : bottom - bounds.bottom;
    const first = rendered[0];
    // Wheel over the real main-content gutter, never a native form field which
    // could consume the input or change its value instead of scrolling the page.
    const pointer = await targets[0].evaluate((element, y) => {
      const main = element.closest("main");
      const x = Math.max(2, Math.min(innerWidth - 2, (main?.getBoundingClientRect().left ?? 0) + 4));
      const hit = document.elementFromPoint(x, y);
      return { x, y, inMain: hit !== null && main?.contains(hit) === true,
        nativeField: hit?.closest("input, textarea, select, [contenteditable='true']")?.tagName ?? null };
    }, (bounds.top + bounds.bottom) / 2);
    expect(pointer.inMain).toBe(true); expect(pointer.nativeField).toBeNull();
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.wheel(0, Math.sign(delta) * Math.min(600, Math.max(2, Math.abs(delta))));
    await expect.poll(async () => (await targets[0].boundingBox())?.y, { timeout: 3_000 }).not.toBe(first.y);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  throw new Error("Native wheel could not reach the viewport target");
}
async function assertUnobscured(page: Page, target: Locator) {
  const bounds = await usableViewport(page);
  const result = await target.evaluate((element, viewport) => {
    const rects = Array.from(element.getClientRects()).filter(rect => rect.width && rect.height);
    return {
      inside: rects.length > 0 && rects.every(rect => rect.left >= 0 && rect.right <= viewport.width
        && rect.top >= viewport.top && rect.bottom <= viewport.bottom),
      hit: rects.length > 0 && rects.every(rect => [0.1, 0.5, 0.9].every(x => [0.1, 0.5, 0.9].every(y => {
        const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
        return hit !== null && element.contains(hit);
      }))),
    };
  }, bounds);
  if (!result.inside || !result.hit) {
    const diagnostics = await target.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return {tag:element.tagName,classes:element.className,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
        samples:[0.1,0.5,0.9].flatMap(x=>[0.1,0.5,0.9].map(y=>{
          const hit=document.elementFromPoint(rect.left+rect.width*x,rect.top+rect.height*y);
          return {x,y,tag:hit?.tagName,classes:hit?.className,inside:!!hit&&element.contains(hit)};
        }))};
    });
    await page.screenshot({path:`${evidenceDir}/leadership-hub-occlusion-diagnostic.png`,fullPage:false});
    console.log(JSON.stringify({probe:"leadership-occlusion",...diagnostics}));
  }
  expect(result, "Target must be in the usable viewport and receive actual pointer hits").toEqual({ inside: true, hit: true });
}
async function reachableClick(page: Page, target: Locator) {
 await wheelIntoView(page, [target]); await assertUnobscured(page, target); await target.click();
}
async function checkControls(page: Page, scope: Locator) {
 for (const control of await scope.locator("button, a, summary, input").all()) {
  if (!await control.isVisible()) continue;
  await wheelIntoView(page, [control]); await assertUnobscured(page, control);
 }
}
async function captureSlice(page: Page, targets: Locator[]) {
 await wheelIntoView(page, targets);
 for (const target of targets) await assertUnobscured(page, target);
 return page.screenshot({ fullPage: false });
}
it("renders a compact real-data desktop/mobile hub; defers finance; preserves sources and makes no workflow writes",async()=>{
 for (const session of [h.sessions.doctorA,h.sessions.reception]) {
  const denied=await fetch(`${owned.baseUrl}/api/executive/pulse?view=tasks`,{headers:{cookie:session.cookie}});
  expect(denied.status).toBe(403);expect(await denied.text()).not.toContain("counts");
 }
 const taskResponse=await fetch(`${owned.baseUrl}/api/executive/pulse?view=tasks`,{headers:{cookie:h.sessions.admin.cookie}});
 expect(taskResponse.status).toBe(200);
 const taskPayload=await taskResponse.json();
 expect(taskPayload.total).toBe(1);expect(taskPayload.counts.open).toBe(1);
 expect(JSON.stringify(taskPayload)).not.toContain("PRIVATE-HUB-TASK");
 const before=await snapshot(),captures:Array<{width:number;state:string;png:Buffer}>=[],metrics:unknown[]=[];
 // Remove only this test's exact known outputs, never broad directories. Save
 // completed synthetic frames immediately; a later failure must not erase them.
 await mkdir(evidenceDir,{recursive:true});
 for(const name of [...captureNames,"leadership-hub-performance.json"]) await rm(`${evidenceDir}/${name}`,{force:true});
 const persistMetrics=async(acceptanceComplete=false)=>writeFile(`${evidenceDir}/leadership-hub-performance.json`,JSON.stringify({fixture:evidenceDescription,acceptanceComplete,captures:captures.map(c=>`leadership-hub-${c.state}-${c.width}.png`),metrics},null,2));
 const saveCapture=async(c:{width:number;state:string;png:Buffer})=>{
  const name=`leadership-hub-${c.state}-${c.width}.png`;
  if(!captureNames.has(name)) throw new Error("Unexpected leadership evidence name");
  await writeFile(`${evidenceDir}/${name}`,c.png);captures.push(c);await persistMetrics();
 };
 await persistMetrics();
 for(const width of [1440,390]){
  const ctx=await context(width),page=await ctx.newPage(),requests:string[]=[],mutations:string[]=[];
  await page.addInitScript(()=>{
   const state={cls:0};(window as unknown as {leadershipMetrics:{cls:number}}).leadershipMetrics=state;
   new PerformanceObserver(list=>{for(const entry of list.getEntries() as (PerformanceEntry & {hadRecentInput:boolean;value:number})[])if(!entry.hadRecentInput)state.cls+=entry.value;}).observe({type:"layout-shift",buffered:true});
  });
  page.on("request",r=>{requests.push(new URL(r.url()).pathname);if(!["GET","HEAD","OPTIONS"].includes(r.method()))mutations.push(r.method()+" "+new URL(r.url()).pathname);});
  try{
   await page.goto(`${owned.baseUrl}/executive`,{waitUntil:"domcontentloaded"});
   const hub=page.getByTestId("leadership-workspace"),tasks=page.getByTestId("leadership-tasks");
   await expect.poll(()=>tasks.innerText()).toContain("مسجّل إجراء مختلف");
   await expect.poll(()=>page.getByTestId("leadership-lab-preview").innerText()).toContain("تاج خزفي");
   await expect.poll(()=>page.getByTestId("leadership-day-queue").innerText()).toContain("مريض متابعة اصطناعي");
   expect(await tasks.innerText()).toContain("المسؤول المسند: مسؤول متابعة اصطناعي");expect(await hub.innerText()).not.toContain("PRIVATE-HUB-TASK");
   expect(requests.filter(p=>p==="/api/executive/pulse")).toHaveLength(2);expect(requests.filter(p=>p==="/api/lab/backlog")).toHaveLength(1);
   expect(requests).not.toContain("/api/executive");expect(requests).not.toContain("/api/hr/attendance");expect(requests).not.toContain("/api/inventory");expect(requests).not.toContain("/api/reports");
   expect(await hub.evaluate(e=>getComputedStyle(e).direction)).toBe("rtl");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   expect(await hub.locator("button").evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().height>=24))).toBe(true);
   const measured=await page.evaluate(()=>({readyMs:performance.now(),apiReadTimings:performance.getEntriesByType("resource").filter(e=>new URL(e.name).pathname.startsWith("/api/executive")||new URL(e.name).pathname==="/api/lab/backlog").map(e=>({path:new URL(e.name).pathname,duration:e.duration})),navigation:performance.getEntriesByType("navigation").map(e=>({duration:e.duration,domContentLoaded:(e as PerformanceNavigationTiming).domContentLoadedEventEnd})),paint:performance.getEntriesByType("paint").map(e=>({name:e.name,startTime:e.startTime})),cls:(window as unknown as {leadershipMetrics:{cls:number}}).leadershipMetrics.cls}));
   metrics.push({width,...measured,initialLeadershipRequests:requests.filter(p=>p.startsWith("/api/executive")||p==="/api/lab/backlog")});
   expect(measured.paint.some(p=>p.name==="first-contentful-paint")).toBe(true);
   await checkControls(page, hub);
   const overview=page.getByTestId("leadership-overview");
   const metricsCards=page.getByTestId("leadership-metrics").locator("button");
   await saveCapture({width,state:"populated",png:await captureSlice(page,await metricsCards.all())});
   for (const [state,panel] of [["day",page.getByTestId("leadership-day-queue")],["lab",page.getByTestId("leadership-lab-preview")],["tasks",tasks]] as const) {
    await saveCapture({width,state,png:await captureSlice(page,[panel.getByRole("heading"),panel.locator("li").first()])});
   }
   if(width===390){
    await page.emulateMedia({reducedMotion:"reduce"});
    await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
    try {
     const reflow=await hub.evaluate(element=>({clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,pageWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth}));
     metrics.push({width,probe:"overview-200-percent-reflow",...reflow});await persistMetrics();
     expect(reflow.scrollWidth<=reflow.clientWidth+1).toBe(true);
     expect(reflow.pageWidth<=reflow.viewportWidth+1).toBe(true);
     await checkControls(page,overview);
     await saveCapture({width,state:"overview-zoom",png:await captureSlice(page,[metricsCards.first()])});
    } finally {await page.evaluate(()=>{document.documentElement.style.fontSize="";});}
   }
   const beforeLabCount=requests.filter(p=>p==="/api/lab/backlog").length;
   const dayControl=page.getByLabel("يوم الوصول والمواعيد",{exact:true});
   await wheelIntoView(page,[dayControl]); await assertUnobscured(page,dayControl); await dayControl.fill("2098-01-01");
   await expect.poll(()=>page.getByTestId("leadership-day-queue").innerText()).toContain("لا زيارات مفتوحة");
   expect(requests.filter(p=>p==="/api/lab/backlog")).toHaveLength(beforeLabCount);
   expect(await page.getByTestId("leadership-lab-preview").innerText()).toContain("تاج خزفي");
   await reachableClick(page,page.getByRole("button",{name:"مراجعة عدم الحضور والإحالات",exact:true}));
   const reviewDay=page.getByLabel("يوم الموعد / اكتمال الإحالة",{exact:true});
   await expect.poll(()=>reviewDay.inputValue()).toBe("2098-01-01");
   await expect.poll(()=>page.getByTestId("leadership-operations").innerText()).toContain("2098-01-01");
   const teamControl=page.getByRole("button",{name:"الفريق والمهام",exact:true});
   await wheelIntoView(page,[teamControl]); await assertUnobscured(page,teamControl);
   await teamControl.focus();await page.keyboard.press("Enter");
   await expect.poll(()=>page.getByTestId("leadership-tasks").innerText()).toContain("تأكيد موعد التجربة");
   expect(await page.locator('a[href="/hr?tab=tasks"]').count()).toBe(1);
   // The actual app renders a typed synthetic finance transport for cross-currency visual coverage.
   // Operational/lab/task populated evidence above uses the owned database, not this fixture.
   await page.route(url=>url.pathname==="/api/executive",route=>{
    const url=new URL(route.request().url());
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({...leadershipFinancialFixture(),from:url.searchParams.get("from"),to:url.searchParams.get("to")})});
   });
   await reachableClick(page,page.getByRole("button",{name:"المالية",exact:true}));
   await expect.poll(()=>requests.includes("/api/executive")).toBe(true);
   const finance=page.getByTestId("leadership-finance");
   await expect.poll(()=>finance.innerText()).toContain("ما دخل وما خرج، بكل عملة");
   const financeReadCount=requests.filter(path=>path==="/api/executive").length;
   for(const [view,label] of [["cash","حركة النقد"],["billing","الفواتير والمصروفات"],["debts","الذمم"],["period","تشغيل الفترة"]]){
    await reachableClick(page,finance.getByRole("button",{name:label,exact:true}));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await checkControls(page,finance);
    for(const record of await finance.locator("article, dl > div").all()) {
     if(!await record.isVisible()) continue;
     await wheelIntoView(page,[record]); await assertUnobscured(page,record);
    }
    const representative=view==="period" ? finance.locator("section").filter({has:page.getByRole("heading",{name:"تشغيل الفترة، لا تشغيل اليوم",exact:true})}) : finance.locator("article").first();
    await saveCapture({width,state:`finance-${view}`,png:await captureSlice(page,[representative])});
    if(width===390){
     await page.emulateMedia({reducedMotion:"reduce"});
     await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
     try {
      const reflow=await hub.evaluate(element=>({clientWidth:element.clientWidth,scrollWidth:element.scrollWidth}));
      // Bounded numeric/style evidence only: no text, HTML, patient identifiers,
      // URLs, cookies or transport bodies. Persist before the failing assertion.
      const overflow=await hub.evaluate(element=>{
       const boundary=element.getBoundingClientRect();
       return Array.from(element.querySelectorAll("*")).filter(node=>{
        const box=node.getBoundingClientRect();return box.width>0&&(box.left<boundary.left-1||box.right>boundary.right+1||node.scrollWidth>node.clientWidth+1);
       }).slice(0,30).map(node=>{const box=node.getBoundingClientRect(),style=getComputedStyle(node);return {tag:node.tagName,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,width:box.width,left:box.left,right:box.right,display:style.display,minWidth:style.minWidth,maxWidth:style.maxWidth,whiteSpace:style.whiteSpace,overflowWrap:style.overflowWrap};});
      });
      metrics.push({width,probe:`finance-${view}-200-percent-reflow`,...reflow,overflow});await persistMetrics();
      expect(reflow.scrollWidth<=reflow.clientWidth+1).toBe(true);
      if(view==="period") {
       await checkControls(page,finance);
       await saveCapture({width,state:"finance-period-zoom",png:await captureSlice(page,[representative.getByRole("heading"),representative.locator("dl > div").first()])});
      }
     } finally { await page.evaluate(()=>{document.documentElement.style.fontSize="";}); }
    }
   }
   expect(requests.filter(path=>path==="/api/executive")).toHaveLength(financeReadCount);
   // Genuine empty responses from the reader shape, intercepted only in this synthetic UI fixture.
   const sourceMatch = (url:URL) => url.pathname==="/api/executive/pulse"||url.pathname==="/api/lab/backlog";
   const emptyRoute = async (route: import("playwright").Route) => {
    const result = await route.fetch(), payload = await result.json();
    await route.fulfill({response:result,json:{...payload,counts:Object.fromEntries(Object.keys(payload.counts).map(k=>[k,0])),total:0,page:0,hasMore:false,items:[]}});
   };
   await page.route(sourceMatch,emptyRoute);
   await reachableClick(page,page.getByRole("button",{name:"نظرة شاملة",exact:true}));
   await expect.poll(()=>page.getByTestId("leadership-tasks").innerText()).toContain("لا مهام مفتوحة");
   await expect.poll(()=>page.getByTestId("leadership-lab-preview").innerText()).toContain("لا طلبات معمل");
   const emptyPanel=page.getByTestId("leadership-day-queue");
   await saveCapture({width,state:"empty",png:await captureSlice(page,[emptyPanel.getByRole("heading"),emptyPanel.getByText("لا زيارات مفتوحة ضمن يوم الوصول المختار.",{exact:true})])});
   await page.unroute(sourceMatch,emptyRoute);
   await page.route(url=>url.pathname==="/api/executive/pulse"||url.pathname==="/api/lab/backlog",route=>route.fulfill({status:503,contentType:"application/json",body:"{}"}));
   await reachableClick(page,page.getByRole("button",{name:"تحديث التشغيل والمعمل",exact:true}));
   await expect.poll(()=>page.getByTestId("leadership-day-queue").innerText()).toContain("العدد غير معروف");
   await expect.poll(()=>page.getByTestId("leadership-lab-preview").innerText()).toContain("العدد غير معروف");
   expect(await page.getByTestId("leadership-metrics").locator("button strong").allTextContents()).toEqual(["—","—","—","—"]);
   const errorPanel=page.getByTestId("leadership-day-queue");
   await checkControls(page,errorPanel);
   await saveCapture({width,state:"error",png:await captureSlice(page,[errorPanel.getByRole("heading"),errorPanel.getByRole("alert")])});
   await page.route(url=>url.pathname==="/api/executive/pulse",route=>route.fulfill({status:401,contentType:"application/json",body:"{}"}));
   await reachableClick(page,page.getByRole("button",{name:"تحديث التشغيل والمعمل",exact:true}));
   await expect.poll(()=>page.locator("main").last().innerText()).toContain("أُخفيت بيانات القيادة");
   expect(await page.getByTestId("leadership-workspace").count()).toBe(0);
   expect(await page.locator('a[href="/patients/'+patient+'?tab=summary"]').count()).toBe(0);
   expect(mutations).toEqual([]);
  }finally{await ctx.close();}
 }
 expect(await snapshot()).toEqual(before);
 expect(captures.map(c=>`${c.state}-${c.width}`).sort()).toEqual([1440,390].flatMap(width=>["populated","day","lab","tasks","empty","error","finance-cash","finance-billing","finance-debts","finance-period"].map(state=>`${state}-${width}`)).concat("finance-period-zoom-390","overview-zoom-390").sort());
 await persistMetrics(true);
},240000);


it("keeps arrival and appointment reads usable while the independent laboratory source is delayed",async()=>{
 const ctx=await context(390),page=await ctx.newPage();
 let releaseLab:()=>void=()=>{};
 const labGate=new Promise<void>(resolve=>{releaseLab=resolve;});
 let labPending=false;
 await page.route(url=>url.pathname==="/api/lab/backlog",async route=>{
  labPending=true;await labGate;await route.continue();
 });
 try {
  await page.goto(`${owned.baseUrl}/executive`,{waitUntil:"domcontentloaded"});
  await expect.poll(()=>labPending).toBe(true);
  await expect.poll(()=>page.getByTestId("leadership-day-queue").innerText()).toContain("مريض متابعة اصطناعي");
  await expect.poll(()=>page.getByTestId("leadership-tasks").innerText()).toContain("تأكيد موعد التجربة");
  expect(await page.getByTestId("leadership-appointments").locator("strong").allTextContents()).toEqual(["2","1","1"]);
  expect(await page.getByTestId("leadership-metrics").locator("strong").allTextContents()).toEqual(["1","1","—","—"]);
  expect(await page.getByTestId("leadership-lab-preview").getByRole("status").innerText()).toContain("جارٍ التحقق");
  await mkdir(evidenceDir,{recursive:true});
  await writeFile(`${evidenceDir}/leadership-hub-delayed-lab-390.png`,await captureSlice(page,await page.getByTestId("leadership-metrics").locator("button").all()));
  releaseLab();
  await expect.poll(()=>page.getByTestId("leadership-lab-preview").innerText()).toContain("تاج خزفي");
  expect(await page.getByTestId("leadership-metrics").locator("strong").allTextContents()).toEqual(["1","1","1","1"]);
  await reachableClick(page,page.getByTestId("leadership-metrics").getByRole("button",{name:/وصلت ولم تُركّب/}));
  await expect.poll(()=>page.getByTestId("lab-backlog").getByRole("button",{name:"وصل ولم يُركّب",exact:true}).getAttribute("aria-pressed")).toBe("true");
  await expect.poll(()=>page.getByTestId("lab-backlog").locator("article").count()).toBe(1);
  expect(await page.getByTestId("lab-backlog").locator("article").innerText()).toContain("تاج خزفي");
  await reachableClick(page,page.getByRole("button",{name:"نظرة شاملة",exact:true}));
  await expect.poll(()=>page.getByTestId("leadership-lab-preview").innerText()).toContain("جسر خزفي");
  await reachableClick(page,page.getByTestId("leadership-metrics").getByRole("button",{name:/متأخرة عند المعمل/}));
  await expect.poll(()=>page.getByTestId("lab-backlog").getByRole("button",{name:"متأخر عند المعمل",exact:true}).getAttribute("aria-pressed")).toBe("true");
  await expect.poll(()=>page.getByTestId("lab-backlog").locator("article").count()).toBe(1);
  expect(await page.getByTestId("lab-backlog").locator("article").innerText()).toContain("جسر خزفي");
 } finally {releaseLab();await ctx.close();}
},120000);

it("clears verified financial amounts on integrity refusal and locks the hub after financial session denial",async()=>{
 const ctx=await context(390),page=await ctx.newPage();let responseStatus=200;
 await page.route(url=>url.pathname==="/api/executive",route=>{
  const url=new URL(route.request().url());
  return route.fulfill({status:responseStatus,contentType:"application/json",body:JSON.stringify(responseStatus===200
   ? {...leadershipFinancialFixture(),from:url.searchParams.get("from"),to:url.searchParams.get("to")}
   : {message:responseStatus===409 ? "تعذّر اعتماد القراءة المالية الاصطناعية" : "انتهت الجلسة الاصطناعية"})});
 });
 try {
  await page.goto(`${owned.baseUrl}/executive`,{waitUntil:"domcontentloaded"});
  await expect.poll(()=>page.getByTestId("leadership-tasks").innerText()).toContain("تأكيد موعد التجربة");
  await reachableClick(page,page.getByRole("button",{name:"المالية",exact:true}));
  const finance=page.getByTestId("leadership-finance");
  await expect.poll(()=>finance.locator("article").count()).toBe(2);
  responseStatus=409;
  await reachableClick(page,finance.getByRole("button",{name:"تحديث المالية",exact:true}));
  await expect.poll(()=>finance.getByRole("alert").innerText()).toContain("سلامة السجلات");
  expect(await finance.locator("article").count()).toBe(0);
  expect(await finance.getByRole("link",{name:"تصدير CSV",exact:true}).count()).toBe(0);
  await reachableClick(page,page.getByRole("button",{name:"نظرة شاملة",exact:true}));
  await reachableClick(page,page.getByRole("button",{name:"المالية",exact:true}));
  await expect.poll(()=>finance.getByRole("alert").count()).toBe(1);
  expect(await finance.locator("article").count()).toBe(0);
  responseStatus=200;
  await reachableClick(page,finance.getByRole("button",{name:"تحديث المالية",exact:true}));
  await expect.poll(()=>finance.locator("article").count()).toBe(2);
  responseStatus=401;
  await reachableClick(page,finance.getByRole("button",{name:"تحديث المالية",exact:true}));
  await expect.poll(()=>page.locator("main").last().innerText()).toContain("أُخفيت بيانات القيادة");
  expect(await page.getByTestId("leadership-workspace").count()).toBe(0);
  expect(await page.getByTestId("leadership-finance").count()).toBe(0);
  expect(await page.getByRole("button",{name:"نظرة شاملة",exact:true}).count()).toBe(0);
  expect(await page.locator(`a[href^="/patients/${patient}"]`).count()).toBe(0);
 } finally {await ctx.close();}
},120000);

it("drops prior principal data on real browser account replacement and keeps restricted roles out of the hub",async()=>{
 for(const role of ["doctorA","reception"] as const){
  const ctx=await context(390),page=await ctx.newPage();
  try {
   await page.goto(`${owned.baseUrl}/executive`,{waitUntil:"domcontentloaded"});
   await expect.poll(()=>page.getByTestId("leadership-tasks").innerText()).toContain("تأكيد موعد التجربة");
   const [name,...value]=h.sessions[role].cookie.split("=");
   await ctx.addCookies([{name,value:value.join("="),url:owned.baseUrl}]);
   // Refresh with a different real server principal, never a development role switch or forged client session.
   await page.reload({waitUntil:"domcontentloaded"});
   await expect.poll(()=>page.getByTestId("leadership-workspace").count()).toBe(0);
   expect(await page.getByTestId("leadership-tasks").count()).toBe(0);
   expect(await page.getByTestId("leadership-finance").count()).toBe(0);
   expect(await page.getByTestId("leadership-clinical").count()).toBe(0);
   expect(await page.locator("body").innerText()).not.toContain("تأكيد موعد التجربة");
   expect(await page.locator("body").innerText()).not.toContain("مريض متابعة اصطناعي");
   const read=await ctx.request.get(`${owned.baseUrl}/api/executive/pulse?view=tasks`);
   expect(read.status()).toBe(403);expect(await read.text()).not.toContain("counts");
  } finally {await ctx.close();}
 }
},120000);

it("opens treatment and doctor readers only on demand and retains the canonical report scope",async()=>{
 const ctx=await context(390),page=await ctx.newPage(),reportRequests:URL[]=[],careRequests:URL[]=[];
 page.on("request",request=>{
  const url=new URL(request.url());
  if(url.pathname==="/api/reports")reportRequests.push(url);
  if(url.pathname==="/api/executive/pulse"&&url.searchParams.get("view")==="care")careRequests.push(url);
 });
 try {
  await page.goto(`${owned.baseUrl}/executive`,{waitUntil:"domcontentloaded"});
  await expect.poll(()=>page.getByTestId("leadership-tasks").innerText()).toContain("تأكيد موعد التجربة");
  expect(reportRequests).toHaveLength(0);expect(careRequests).toHaveLength(0);
  const careResponse=page.waitForResponse(response=>{
   const url=new URL(response.url());return url.pathname==="/api/executive/pulse"&&url.searchParams.get("view")==="care";
  });
  await reachableClick(page,page.getByRole("button",{name:"الأعمال وأداء الأطباء",exact:true}));
  const clinical=page.getByTestId("leadership-clinical"),care=page.getByTestId("leadership-care");
  const result=await careResponse;expect(result.status()).toBe(200);
  const payload=await result.json();
  expect(payload.scope).toBe("active_plan_work_now");
  expect(payload.counts).toEqual({activePlans:1,pendingPlans:1,patients:1,pendingItems:2,plannedItems:1,inProgressItems:1,withoutPendingItems:0});
  expect(payload.items).toHaveLength(1);expect(payload.items[0]).toMatchObject({id:carePlan,patientId:patient,pendingItems:2});
  await expect.poll(()=>care.innerText()).toContain("خطة علاج اصطناعية متعددة الخطوات");
  expect(reportRequests).toHaveLength(0);expect(careRequests).toHaveLength(1);
  expect(careRequests[0].searchParams.has("day")).toBe(false);
  const planHref=await care.locator(`a[href*="planId=${carePlan}"]`).first().getAttribute("href");
  const planUrl=new URL(planHref!,owned.baseUrl);
  expect(planUrl.pathname).toBe(`/patients/${patient}`);expect(planUrl.searchParams.get("tab")).toBe("treatment");expect(planUrl.searchParams.get("sub")).toBe("plans");
  await mkdir(evidenceDir,{recursive:true});
  await writeFile(`${evidenceDir}/leadership-hub-care-390.png`,await captureSlice(page,[care.locator("li").first()]));
  await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
  try {
   expect(await clinical.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
   await checkControls(page,clinical);
   await writeFile(`${evidenceDir}/leadership-hub-care-zoom-390.png`,await captureSlice(page,[care.getByRole("heading",{name:"كل الخطط الجارية والعمل المتبقي",exact:true})]));
  } finally {await page.evaluate(()=>{document.documentElement.style.fontSize="";});}
  await reachableClick(page,clinical.getByRole("button",{name:"علاج ينتظر الجدولة",exact:true}));
  await expect.poll(()=>clinical.getByRole("link",{name:"فتح التقرير الكامل",exact:true}).count()).toBe(1);
  expect(reportRequests.map(url=>url.searchParams.get("report"))).toEqual(["unscheduled-treatment"]);
  expect(await clinical.innerText()).toContain("كل الخطط الجارية الآن");
  expect(await clinical.innerText()).not.toContain("PRIVATE-HUB-TASK");
  const href=await clinical.getByRole("link",{name:"فتح التقرير الكامل",exact:true}).getAttribute("href");
  expect(href).toContain("report=unscheduled-treatment");
  await reachableClick(page,clinical.getByRole("button",{name:"أداء الأطباء",exact:true}));
  await expect.poll(()=>clinical.innerText()).toContain("سجلات الأطباء في الفترة");
  expect(reportRequests.at(-1)?.searchParams.get("report")).toBe("provider-utilization");
  expect(await clinical.innerText()).toContain("نسبة الاستغلال غير معروفة");
  expect(await clinical.innerText()).toContain("لا تُنسب مصروفات العيادة إلى طبيب");
  await mkdir(evidenceDir,{recursive:true});
  await writeFile(`${evidenceDir}/leadership-hub-clinical-390.png`,await captureSlice(page,[clinical.getByRole("heading",{name:"سجلات الأطباء في الفترة",exact:true})]));
  await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
  try {
   expect(await clinical.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
   await checkControls(page,clinical);
  } finally {await page.evaluate(()=>{document.documentElement.style.fontSize="";});}
 } finally {await ctx.close();}
},120000);
