import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
let browser: Browser;
beforeAll(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});});
afterAll(async()=>{await browser?.close();});
const roots=[{name:'current checkout',dir:process.cwd()},...(process.env.HR_FROZEN_SOURCE_ROOT?[{name:'frozen writer checkout',dir:process.env.HR_FROZEN_SOURCE_ROOT}]:[])];
for(const source of roots)it(`retains earlier uncertain A after B refusal and later retry refusals in ${source.name}`,async()=>{
  const bundled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {HrHistoryDraftProvider} from './components/hr/HistoryDraftProvider';import {HrHistoryLauncher} from './components/hr/HistoryEditor';const root=createRoot(document.getElementById('root'));window.mount=(username)=>{window.syntheticSession={username,role:'admin'};flushSync(()=>root.render(React.createElement(HrHistoryDraftProvider,{view:'staff'},React.createElement(HrHistoryLauncher,{key:username,staffId:7,label:'Synthetic retained intent',kind:'employment'}))));};`,resolveDir:source.dir,sourcefile:'synthetic-refusal.jsx',loader:'jsx'},bundle:true,write:false,jsx:'automatic',platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent',plugins:[{name:'synthetic-session',setup(b){b.onResolve({filter:/(?:^|\/)SessionProvider$/},()=>({path:'session',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:'export const useSession=()=>window.syntheticSession;'}));}}]});
  const context=await browser.newContext(),page=await context.newPage(),sent:Record<string,unknown>[]=[],outside:string[]=[];
  const intent=(body:Record<string,unknown>)=>({...body,staffId:7,operation:'employment.record'});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!=='http://127.0.0.1:47894'){outside.push(url.origin);return route.abort();}
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><div id="root"></div>'});
    if(url.pathname!=='/api/hr/staff/7/history'){outside.push(url.pathname);return route.abort();}
    if(route.request().method()==='POST'){
      const body=route.request().postDataJSON();sent.push(body);
      if(sent.length===1)return route.fulfill({status:200,contentType:'application/json',body:'{"requestId":"unconfirmed-foreign-receipt"}'});
      // B gets its own first refusal. A then receives first a foreign B refusal,
      // then a matching refusal on a replay; neither proves that A's earlier attempt did not commit.
      const refused=sent.length===3?sent[1]:body;
      return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({message:'Synthetic confirmed refusal for this attempt',refusal:{confirmedNoCommitAttempt:true,intent:intent(refused)}})});
    }
    return route.fulfill({contentType:'application/json',body:JSON.stringify({staffId:7,kind:'employment',headRevision:0,timeline:{revision:0,facts:[]},records:[],selectedRecord:null,selected:{kind:'unknown'},asOfDay:'2026-10-11',legacyObservation:{workStatus:'active',hireDate:null,endDate:null,linkedUserId:null}})});
  });
  const mount=async(owner:string)=>{await page.evaluate(name=>(window as unknown as {mount(name:string):void}).mount(name),owner);await page.getByRole('button',{name:'تاريخ العمل: Synthetic retained intent'}).click();await page.getByRole('form').waitFor();};
  const submitNew=async(p:Page,reason:string)=>{await p.getByLabel('بداية السريان',{exact:true}).fill('2026-10-01');await p.getByLabel('سبب التوثيق أو التصحيح').fill(reason);await p.getByRole('button',{name:'توثيق الفترة',exact:true}).click();};
  try{
    await page.goto('http://127.0.0.1:47894/');await page.addScriptTag({content:bundled.outputFiles![0].text});
    await mount('owner-a');await submitNew(page,'Earlier uncertain A');await expect.poll(()=>sent.length).toBe(1);
    await page.getByRole('button',{name:'إعادة الطلب المحفوظ للتحقق'}).waitFor();const original=JSON.parse(JSON.stringify(sent[0]));
    await mount('owner-b');await submitNew(page,'Later different B');await expect.poll(()=>sent.length).toBe(2);
    await expect.poll(()=>page.getByRole('button',{name:'توثيق الفترة',exact:true}).count()).toBe(1);
    await mount('owner-a');expect(await page.getByLabel('سبب التوثيق أو التصحيح').inputValue()).toBe('Earlier uncertain A');
    for(const count of [3,4]){
      await page.getByRole('button',{name:'إعادة الطلب المحفوظ للتحقق'}).click();await expect.poll(()=>sent.length).toBe(count);
      await expect.poll(()=>page.getByRole('button',{name:'إعادة الطلب المحفوظ للتحقق'}).count()).toBe(1);
      expect(sent[count-1]).toEqual(original);expect(await page.getByLabel('بداية السريان',{exact:true}).isDisabled()).toBe(true);
    }
    await page.getByRole('button',{name:'إغلاق التاريخ',exact:true}).click();await page.getByRole('button',{name:'تاريخ العمل: Synthetic retained intent'}).click();
    await page.getByRole('button',{name:'إعادة الطلب المحفوظ للتحقق'}).waitFor();expect(await page.getByLabel('سبب التوثيق أو التصحيح').inputValue()).toBe('Earlier uncertain A');
    expect(sent[1].requestId).not.toBe(original.requestId);expect(outside).toEqual([]);
  }finally{await context.close();}
});
