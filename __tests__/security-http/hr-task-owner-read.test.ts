import {afterAll,beforeAll,expect,it} from "vitest";
import {build} from "esbuild";
import {chromium,type Browser,type Page,type Route} from "playwright";

// Real React reconciliation of the production component, with synthetic transport.
// No application route, account, persistence, or production test hook is added.
let browser:Browser,bundle:string;
beforeAll(async()=>{
 const result=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {HrTasksPanel} from './components/hr/TasksPanel';const root=createRoot(document.getElementById('root'));window.mountOwner=(username)=>flushSync(()=>root.render(React.createElement(HrTasksPanel,{session:username?{username,role:'doctor'}:null})));`,resolveDir:process.cwd(),sourcefile:"synthetic-task-owner.jsx",loader:"jsx"},bundle:true,write:false,jsx:"automatic",platform:"browser",format:"iife",define:{"process.env.NODE_ENV":'"development"'},logLevel:"silent"});
 if(!result.outputFiles?.[0])throw new Error("Synthetic component bundle was not produced");
 bundle=result.outputFiles[0].text;browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
},120000);
afterAll(async()=>{await browser?.close();});
const task=(id:number,title:string)=>({id,title,description:`Description ${title}`,isPrivate:true,status:"planned",priority:"normal",dueAt:null,plannedFor:null,overdue:false,ownerUserId:id,ownerDisplayName:"Synthetic owner",assigneeStaffId:null,assigneeLabel:"",completedAt:null,createdAt:"2026-10-11T00:00:00.000Z",updatedAt:"2026-10-11T00:00:00.000Z"});
const list=(...tasks:ReturnType<typeof task>[])=>({tasks,counts:{planned:tasks.length,in_progress:0,blocked:0,completed:0,cancelled:0},overdueCount:0});
const detail=(value:ReturnType<typeof task>)=>({task:value,checklist:[],comments:[],events:[],links:[],permissions:{canManage:true,canWork:true}});
const json=async(route:Route,value:unknown,status=200)=>{
 await route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
 const response=await route.request().response();await response?.finished();
};
const renderDrain=(page:Page)=>page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
async function setup(){
 const context=await browser.newContext();const page=await context.newPage();
 await page.route("http://hr-owner.invalid/",route=>route.fulfill({contentType:"text/html",body:'<!doctype html><html><body><div id="root"></div></body></html>'}));
 await page.goto("http://hr-owner.invalid/");await page.addScriptTag({content:bundle});
 return {page,close:()=>context.close()};
}
async function mount(page:Page,owner:string|null){return page.evaluate(value=>{
 (window as unknown as {mountOwner:(name:string|null)=>void}).mountOwner(value);
 // This snapshot is synchronous with the commit, before a pending response.
 return document.body.textContent??"";
},owner);}

it("hides A synchronously before B's first list response and rejects a retired A list response",async()=>{
 const fixture=await setup(),{page}=fixture;const held:Route[]=[];
 try{
  await page.route("**/api/tasks?**",route=>{held.push(route);});
  await mount(page,"synthetic-a");await expect.poll(()=>held.length).toBe(1);
  const immediate=await mount(page,"synthetic-b");expect(immediate).not.toContain("PRIVATE-A");await expect.poll(()=>held.length).toBe(2);
  await json(held[0],list(task(1,"PRIVATE-A")));await renderDrain(page);
  expect(await page.textContent("body")).not.toContain("PRIVATE-A");
  await json(held[1],list(task(2,"PRIVATE-B")));await expect.poll(()=>page.textContent("body")).toContain("PRIVATE-B");
  expect(await page.textContent("body")).not.toContain("PRIVATE-A");
 }finally{await fixture.close();}
});

it("retires cached list/detail immediately and refuses an older detail when a different owner is mounted",async()=>{
 const fixture=await setup(),{page}=fixture;let owner="a";let heldDetail:Route|undefined;
 try{
  await page.route("**/api/tasks?**",route=>json(route,list(task(owner==="a"?1:2,owner==="a"?"PRIVATE-A":"PRIVATE-B"))));
  await page.route("**/api/tasks/1",route=>json(route,detail(task(1,"PRIVATE-A-DETAIL"))));
  await mount(page,"synthetic-a");await page.getByRole("button",{name:/PRIVATE-A/}).click();await expect.poll(()=>page.textContent("body")).toContain("PRIVATE-A-DETAIL");
  owner="b";const immediate=await mount(page,"synthetic-b");expect(immediate).not.toContain("PRIVATE-A");
  await expect.poll(()=>page.textContent("body")).toContain("PRIVATE-B");expect(await page.getByRole("dialog").count()).toBe(0);
  owner="a";await mount(page,"synthetic-a");await page.unroute("**/api/tasks/1");await page.route("**/api/tasks/1",route=>{heldDetail=route;});
  await page.getByRole("button",{name:/PRIVATE-A/}).click();await expect.poll(()=>!!heldDetail).toBe(true);
  owner="b";await mount(page,"synthetic-b");await expect.poll(()=>page.textContent("body")).toContain("PRIVATE-B");
  await json(heldDetail!,detail(task(1,"LATE-PRIVATE-A-DETAIL")));await renderDrain(page);
  expect(await page.textContent("body")).not.toContain("PRIVATE-A");expect(await page.getByRole("dialog").count()).toBe(0);
 }finally{await fixture.close();}
});

it("admits only the newest query, including a repeated A query after A→B→A",async()=>{
 const fixture=await setup(),{page}=fixture;const held:Array<{route:Route;query:string}>=[];
 try{
  await page.route("**/api/tasks?**",route=>{const query=new URL(route.request().url()).searchParams.get("q")??"";if(!query)return json(route,list());held.push({route,query});});
  await mount(page,"synthetic-a");const search=page.getByRole("searchbox",{name:"بحث في المهام"});
  await search.fill("A");await expect.poll(()=>held.length).toBe(1);await search.fill("B");await expect.poll(()=>held.length).toBe(2);await search.fill("A");await expect.poll(()=>held.length).toBe(3);
  expect(held.map(x=>x.query)).toEqual(["A","B","A"]);
  await json(held[2].route,list(task(3,"CURRENT-A")));await expect.poll(()=>page.textContent("body")).toContain("CURRENT-A");
  await json(held[1].route,list(task(2,"STALE-B")));await json(held[0].route,list(task(1,"STALE-A")));await renderDrain(page);
  expect(await page.textContent("body")).toContain("CURRENT-A");expect(await page.textContent("body")).not.toContain("STALE-");
 }finally{await fixture.close();}
});

it("retains exact uncertain A and B commands without retired completions clearing another mounted form",async()=>{
 const fixture=await setup(),{page}=fixture;const posts:Array<{route:Route;body:Record<string,unknown>}>=[];
 const receipt=(body:Record<string,unknown>,id:number)=>({id,ownerUserId:id,creationReceipt:{clientRequestId:body.clientRequestId,...body.expectedOwner as object}});
 try{
  await page.route("**/api/tasks?**",route=>json(route,list()));
  await page.route("**/api/tasks",route=>{posts.push({route,body:route.request().postDataJSON()});});
  const open=()=>page.getByRole("button",{name:"مهمة جديدة",exact:true}).click();
  const modal=page.getByRole("dialog",{name:"مهمة جديدة",exact:true});
  await mount(page,"synthetic-a");await open();await modal.getByLabel("العنوان",{exact:true}).fill("PRIVATE-PENDING-A");await modal.getByLabel(/مهمة خاصة/).check();await modal.getByRole("button",{name:"إنشاء",exact:true}).click();await expect.poll(()=>posts.length).toBe(1);
  await mount(page,"synthetic-b");await open();expect(await modal.getByLabel("العنوان",{exact:true}).inputValue()).toBe("");await modal.getByLabel("العنوان",{exact:true}).fill("PRIVATE-PENDING-B");await modal.getByLabel(/مهمة خاصة/).check();await modal.getByRole("button",{name:"إنشاء",exact:true}).click();await expect.poll(()=>posts.length).toBe(2);
  await mount(page,"synthetic-a");await open();expect(await modal.getByLabel("العنوان",{exact:true}).inputValue()).toBe("PRIVATE-PENDING-A");expect(await modal.getByLabel("العنوان",{exact:true}).isDisabled()).toBe(true);
  // Both old HTTP completions arrive after their originating view retired.
  await json(posts[1].route,receipt(posts[1].body,2),201);await json(posts[0].route,receipt(posts[0].body,1),201);await renderDrain(page);
  expect(await modal.count()).toBe(1);expect(await modal.getByLabel("العنوان",{exact:true}).inputValue()).toBe("PRIVATE-PENDING-A");
  await modal.getByRole("button",{name:"تحقق وأعد نفس الطلب",exact:true}).click();await expect.poll(()=>posts.length).toBe(3);expect(posts[2].body).toEqual(posts[0].body);
  await json(posts[2].route,{message:"Synthetic current refusal",creationRefusal:{...receipt(posts[2].body,1).creationReceipt,noWrite:true}},403);
  await expect.poll(()=>modal.getByRole("alert").innerText()).toContain("Synthetic current refusal");expect(await modal.getByLabel("العنوان",{exact:true}).isDisabled()).toBe(true);
  await modal.getByRole("button",{name:"تحقق وأعد نفس الطلب",exact:true}).click();await expect.poll(()=>posts.length).toBe(4);expect(posts[3].body).toEqual(posts[0].body);await json(posts[3].route,receipt(posts[3].body,1),201);await expect.poll(()=>modal.count()).toBe(0);
  await mount(page,"synthetic-b");await open();expect(await modal.getByLabel("العنوان",{exact:true}).inputValue()).toBe("PRIVATE-PENDING-B");await modal.getByRole("button",{name:"تحقق وأعد نفس الطلب",exact:true}).click();await expect.poll(()=>posts.length).toBe(5);expect(posts[4].body).toEqual(posts[1].body);await json(posts[4].route,receipt(posts[4].body,2),201);await expect.poll(()=>modal.count()).toBe(0);
  expect(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0});
 }finally{await fixture.close();}
});
