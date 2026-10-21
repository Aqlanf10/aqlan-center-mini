import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClinicalNavigationContext } from "../lib/patient-navigation";
import { clinicalNavigationVerificationMode as modeFor, readVerifiedClinicalContext, useClinicalNavigationContext } from "../components/useClinicalNavigationContext";

// Deterministic hook-lifetime simulation, not React/browser acceptance. Actual hook
// owner/effect/abort code runs; hosted acceptance remains required for rendered navigation.
const hooks = vi.hoisted(() => ({cursor:0, values:[] as unknown[], pending:[] as (()=>void)[], cleanups:[] as (()=>void)[]}));
vi.mock("react", () => ({
  useState(initial:unknown) {
    const i=hooks.cursor++; if (!(i in hooks.values)) hooks.values[i]=initial;
    return [hooks.values[i], (value:unknown)=>{hooks.values[i]=value;}];
  },
  useMemo(factory:()=>unknown,deps:unknown[]) {
    const i=hooks.cursor++, prior=hooks.values[i] as {deps:unknown[];value:unknown}|undefined;
    if (!prior || deps.some((value,index)=>!Object.is(value,prior.deps[index]))) hooks.values[i]={deps,value:factory()};
    return (hooks.values[i] as {value:unknown}).value;
  },
  useEffect(effect:()=>void|(()=>void),deps:unknown[]) {
    const i=hooks.cursor++, prior=hooks.values[i] as {deps:unknown[];cleanup?:()=>void}|undefined;
    if (!prior || deps.some((value,index)=>!Object.is(value,prior.deps[index]))) {
      prior?.cleanup?.(); const state={deps,cleanup:undefined as undefined|(()=>void)}; hooks.values[i]=state;
      hooks.pending.push(()=>{state.cleanup=effect()||undefined;if(state.cleanup)hooks.cleanups.push(state.cleanup);});
    }
  },
}));
const fetchMock=vi.fn<typeof fetch>();
const context={patientId:11,visitId:21};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const visit=(id=21,patientId:number|null=11)=>({id,patientId,status:"signed",invoiceId:999,planId:888,duesMinor:123});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function RenderHook(authority="assistant:a", mode:Parameters<typeof useClinicalNavigationContext>[4]="assistant-visit", requested:ClinicalNavigationContext=context, patientId=11) {
  hooks.cursor=0;
  const result=useClinicalNavigationContext(patientId,requested,false,authority,mode);
  for(const effect of hooks.pending.splice(0))effect();
  return result;
}
beforeEach(()=>{hooks.cursor=0;hooks.values=[];hooks.pending=[];hooks.cleanups=[];fetchMock.mockReset();vi.stubGlobal("fetch",fetchMock);});
afterEach(()=>{for(const cleanup of hooks.cleanups)cleanup();vi.unstubAllGlobals();vi.useRealTimers();});

describe("assistant exact visit verification without treatment graph access",()=>{
  it("uses only the existing clinical GET and projects only matching identity",async()=>{
    fetchMock.mockResolvedValue(response(visit()));
    expect(await readVerifiedClinicalContext(11,context,undefined,"assistant-visit")).toEqual({context,sub:"cases"});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/visits/21/clinical");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({cache:"no-store"});
  });
  it.each([
    ["wrong patient",visit(21,12)], ["unbound patient",visit(21,null)], ["wrong visit",visit(22)],
    ["missing identity",{}], ["array",[]], ["null",null], ["invalid status",{...visit(),status:"done"}],
    ["string ID",{...visit(),id:"21"}],
  ])("rejects %s response",async(_label,payload)=>{
    fetchMock.mockResolvedValue(response(payload));
    await expect(readVerifiedClinicalContext(11,context,undefined,"assistant-visit")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([401,403,404,500])("fails closed on HTTP %i without fallback",async status=>{
    fetchMock.mockResolvedValue(response({message:status===403?"المساعد السريري يعمل على زيارات اليوم وحدها.":"رفض"},status));
    await expect(readVerifiedClinicalContext(11,context,undefined,"assistant-visit")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1); // In particular, old-date 403 never becomes graph navigation.
  });
  it("preserves an old-date 403 from the clinical API without a graph retry",async()=>{
    fetchMock.mockResolvedValue(response({message:"المساعد السريري يعمل على زيارات اليوم وحدها."},403));
    await expect(readVerifiedClinicalContext(11,context,undefined,"assistant-visit")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/visits/21/clinical");
  });
  it("retains the bounded timeout and aborts the outstanding exact read",async()=>{
    vi.useFakeTimers();fetchMock.mockReturnValue(new Promise(()=>{}));
    const reading=readVerifiedClinicalContext(11,context,undefined,"assistant-visit");
    const rejected=expect(reading).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15000);await rejected;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("rejects malformed JSON and network failures",async()=>{
    fetchMock.mockResolvedValueOnce(new Response("not json"));
    await expect(readVerifiedClinicalContext(11,context,undefined,"assistant-visit")).rejects.toThrow();
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(readVerifiedClinicalContext(11,context,undefined,"assistant-visit")).rejects.toThrow();
  });
  it.each(["planId","planItemId","clinicalCaseId","orthoCaseId","endoTreatmentId","pillar"])("refuses mixed %s context before any read",async key=>{
    await expect(readVerifiedClinicalContext(11,{...context,[key]:key==="pillar"?"wires":31},undefined,"assistant-visit")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([{patientId:12,visitId:21},{patientId:11},{visitId:0}])("refuses invalid requested identity %j",async requested=>{
    await expect(readVerifiedClinicalContext(11,requested,undefined,"assistant-visit")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("keeps null sessions pending and assistant non-Today context refused",()=>{
    expect(modeFor(null,"today")).toBe("pending");
    expect(modeFor({username:"",role:"assistant"},"today")).toBe("pending");
    expect(modeFor({username:"a",role:"assistant"},"treatment")).toBe("refused");
    expect(RenderHook("null","pending").ready).toBe(false);
    expect(RenderHook("assistant:a","refused").ready).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("leaves other roles on the graph verifier",async()=>{
    for(const role of ["admin","doctor","reception"]) expect(modeFor({username:"user",role},"today")).toBe("graph");
    fetchMock.mockResolvedValue(response({ok:true,context,specialty:null,sub:"cases"}));
    await readVerifiedClinicalContext(11,context,undefined,"graph");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/patients/11/clinical-context?patientId=11&visitId=21");
  });
  it("rejects a body completed after abort even if fetch ignored cancellation",async()=>{
    const body=deferred<unknown>(),abort=new AbortController();
    fetchMock.mockResolvedValue({ok:true,json:()=>body.promise} as Response);
    const reading=readVerifiedClinicalContext(11,context,abort.signal,"assistant-visit");
    const rejected=expect(reading).rejects.toThrow(); await flush();abort.abort();body.resolve(visit());await rejected;
  });
});

describe("visit navigation owner fencing",()=>{
  it("does not publish an obsolete visit after a newer exact visit",async()=>{
    const old=deferred<Response>();fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(visit(22)));
    RenderHook();const oldSignal=fetchMock.mock.calls[0][1]?.signal;
    const next={patientId:11,visitId:22};expect(RenderHook("assistant:a","assistant-visit",next).ready).toBe(false);
    expect(oldSignal?.aborted).toBe(true);await flush();expect(RenderHook("assistant:a","assistant-visit",next).context).toEqual(next);
    old.resolve(response(visit()));await flush();expect(RenderHook("assistant:a","assistant-visit",next).context).toEqual(next);
  });
  it("does not reuse accepted identity after role/session loss",async()=>{
    fetchMock.mockResolvedValue(response(visit()));RenderHook();await flush();expect(RenderHook().ready).toBe(true);
    expect(RenderHook("null","pending").context).toBeUndefined();expect(fetchMock).toHaveBeenCalledTimes(1);
    const graph=deferred<Response>();fetchMock.mockReturnValueOnce(graph.promise);
    expect(RenderHook("doctor:b","graph").ready).toBe(false);
    expect(fetchMock.mock.calls[1][0]).toContain("/clinical-context?");
    graph.resolve(response({ok:true,context,specialty:null,sub:"cases"}));await flush();expect(RenderHook("doctor:b","graph").ready).toBe(true);
  });
  it("ignores a late prior-session read and re-verifies for the new session",async()=>{
    const old=deferred<Response>(),fresh=deferred<Response>();fetchMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    RenderHook();RenderHook("assistant:b");old.resolve(response(visit()));await flush();expect(RenderHook("assistant:b").ready).toBe(false);
    fresh.resolve(response(visit()));await flush();expect(RenderHook("assistant:b").context).toEqual(context);
  });
  it("hides accepted identity when a mixed context replaces it, without a graph read",async()=>{
    fetchMock.mockResolvedValue(response(visit()));RenderHook();await flush();expect(RenderHook().ready).toBe(true);
    const mixed={...context,planId:31};expect(RenderHook("assistant:a","assistant-visit",mixed).context).toBeUndefined();
    await flush();expect(RenderHook("assistant:a","assistant-visit",mixed).ready).toBe(false);expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not accept an old patient's response after navigating to another patient",async()=>{
    const old=deferred<Response>();fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(visit(24,12)));
    RenderHook();const next={patientId:12,visitId:24};RenderHook("assistant:a","assistant-visit",next,12);await flush();
    old.resolve(response(visit()));await flush();expect(RenderHook("assistant:a","assistant-visit",next,12).context).toEqual(next);
  });
});
