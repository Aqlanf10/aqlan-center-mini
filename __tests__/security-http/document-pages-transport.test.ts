import { createHmac, randomUUID } from "node:crypto";
import { request as nodeRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { JSON_BODY_LIMIT_BYTES } from "../../lib/security-limits";

// All files and rows are synthetic, on the harness-owned databases and loopback only.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const tokenOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);
const headers = (cookie: string) => ({ cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" });
async function upload(base: string, patient: number, cookie: string) {
  const form = new FormData(); form.set("file", new File([new Uint8Array(PNG)], "synthetic.png", { type: "image/png" }));
  form.set("kind", "xray"); form.set("title", "Synthetic pages document");
  const r = await fetch(`${base}/api/patients/${patient}/documents`, { method: "POST", headers: { cookie, Origin: base }, body: form, redirect: "manual" });
  expect(r.status).toBe(201); return (await r.json()).id as number;
}
async function chunkedTooLarge(url: string, cookie: string, origin = baseUrl) {
  return new Promise<number>((resolve,reject) => {
    const req = nodeRequest(url, { method: "DELETE", headers: { cookie, Origin: origin, "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, res => { res.resume(); res.on("end",()=>resolve(res.statusCode!)); });
    req.on("error", reject); req.write('{"note":"');
    for (let left=JSON_BODY_LIMIT_BYTES+1;left>0;left-=4096) req.write("x".repeat(Math.min(left,4096)));
    req.end('"}');
  });
}

describe("legacy document transport on a real built server", () => {
  let h: Awaited<ReturnType<typeof harness>>, db: Client, doc: number, patient: number;
  beforeAll(async () => {
    h = await harness(); db = new Client({ connectionString:h.seeded.dbUrl,ssl:false }); await db.connect();
    const doctor=(await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
    patient=(await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'Synthetic transport patient',$2) RETURNING id",[`SYN-DOC-PAGES-${randomUUID()}`,doctor])).rows[0].id;
    doc=await upload(baseUrl,patient,h.sessions.doctorA.cookie);
  },120000);
  afterAll(async()=>{await db?.end();});
  it("preserves byte length, identity, privacy and cookie/Bearer priority", async () => {
    const url=`${baseUrl}/api/documents/${doc}`, own=h.sessions.doctorA, other=h.sessions.doctorB;
    for(const credentials of [{cookie:own.cookie},{authorization:`Bearer ${own.token}`},{cookie:own.cookie,authorization:`Bearer ${other.token}`}] as Record<string, string>[]) {
      const r=await fetch(url,{headers:{...credentials,"Accept-Encoding":"gzip"}});
      expect(r.status).toBe(200);expect(r.headers.get("content-length")).toBe(String(PNG.length));expect(r.headers.get("content-encoding")).toBeNull();
      expect(r.headers.get("cache-control")).toContain("no-store");expect(r.headers.get("cache-control")).toContain("no-transform");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");expect(Buffer.from(await r.arrayBuffer())).toEqual(PNG);
    }
    const head=await fetch(url,{method:"HEAD",headers:{cookie:own.cookie,"Accept-Encoding":"gzip"}});
    expect(head.status).toBe(200);expect(head.headers.get("content-length")).toBe(String(PNG.length));expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await fetch(`${url}?id=0`,{headers:{cookie:own.cookie}})).status).toBe(200);
    expect((await fetch(url,{method:"OPTIONS"})).status).toBe(401);
    const options=await fetch(url,{method:"OPTIONS",headers:{cookie:own.cookie}});expect(options.status).toBe(204);expect(options.headers.get("allow")).toMatch(/HEAD/);
    const attachment=await fetch(`${url}?download=1`,{headers:{cookie:own.cookie}});expect(attachment.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect((await fetch(url,{headers:{cookie:other.cookie,authorization:`Bearer ${own.token}`}})).status).toBe(403);
    expect((await fetch(url,{headers:{cookie:`${own.cookie}; ${other.cookie}`}})).status).toBe(403);
    expect((await fetch(url,{headers:{cookie:`${other.cookie}; ${own.cookie}`}})).status).toBe(200);
    expect((await fetch(url,{headers:{cookie:"aqlan_flow_session=invalid",authorization:`Bearer ${own.token}`}})).status).toBe(200);
    expect((await fetch(url)).status).toBe(401);
  });
  it("rejects foreign DELETE, cross-origin and oversized streams without changing the document", async () => {
    const url=`${baseUrl}/api/documents/${doc}`;
    expect((await fetch(url,{method:"DELETE",headers:{...headers(h.sessions.doctorA.cookie),"Content-Type":"application/json"},body:JSON.stringify({note:"Synthetic reason"})})).status).toBe(403);
    expect((await fetch(url,{method:"DELETE",headers:{cookie:h.sessions.admin.cookie,Origin:"https://foreign.example", "Content-Type":"application/json"},body:JSON.stringify({note:"Synthetic reason"})})).status).toBe(403);
    expect(await chunkedTooLarge(url,h.sessions.admin.cookie)).toBe(413);
    expect((await db.query("SELECT removed_at FROM patient_documents WHERE id=$1",[doc])).rows[0].removed_at).toBeNull();
    const hidden=await fetch(url,{method:"DELETE",headers:{...headers(h.sessions.admin.cookie),"Content-Type":"application/json"},body:JSON.stringify({note:"Synthetic reason"})});
    expect(hidden.status).toBe(200);expect((await fetch(url,{headers:{cookie:h.sessions.doctorA.cookie}})).status).toBe(404);
  });
});

const ACCOUNTS = {
 owner: { username:"syn-pages-owner",password:"Synthetic#PagesOwner1",role:"admin",display:"Synthetic owner" },
 doctor: { username:"syn-pages-doctor",password:"Synthetic#PagesDoc1",role:"doctor",display:"Synthetic doctor",doctor:true,patientScope:"own",grants:{"clinical.xrays.view":true,"clinical.xrays.upload":true} },
 stranger: { username:"syn-pages-stranger",password:"Synthetic#PagesStranger1",role:"doctor",display:"Synthetic other",doctor:true,patientScope:"own",grants:{"clinical.xrays.view":true} },
} as const;
type Key=keyof typeof ACCOUNTS;
describe("canonical document transport on an independent built server",()=>{
  let j:CanonicalJourney<Key>, patient:number, doc:number, own:string, stranger:string;
  const secret="synthetic-canonical-document-pages-secret-0123456789";
  beforeAll(async()=>{
    j=await openCanonicalJourney({portOffset:157,secret,accounts:ACCOUNTS,ownerKey:"owner",async seed(db,_ids,parties){patient=(await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-PAGES-CANON','Synthetic canonical patient',$1) RETURNING id",[parties.doctor])).rows[0].id;}});
    own=(await j.login("doctor")).cookie;stranger=(await j.login("stranger")).cookie;doc=await upload(j.baseUrl,patient,own);
  },300000);
  afterAll(async()=>{await j?.close();},60000);
  it("preserves canonical scope and cookie/Bearer GET/HEAD",async()=>{
    const url=`${j.baseUrl}/api/documents/${doc}`;
    for(const credentials of [{cookie:own},{authorization:`Bearer ${tokenOf(own)}`}] as Record<string, string>[]) {
      const r=await fetch(url,{headers:{...credentials,"Accept-Encoding":"gzip"}});expect(r.status).toBe(200);
      expect(r.headers.get("content-length")).toBe(String(PNG.length));expect(r.headers.get("cache-control")).toContain("no-transform");expect(Buffer.from(await r.arrayBuffer())).toEqual(PNG);
    }
    const head=await fetch(url,{method:"HEAD",headers:{cookie:own}});expect(head.status).toBe(200);expect(head.headers.get("content-length")).toBe(String(PNG.length));expect((await head.arrayBuffer()).byteLength).toBe(0);
    const denied=await fetch(url,{headers:{cookie:stranger,authorization:`Bearer ${tokenOf(own)}`}});expect([403,404]).toContain(denied.status);
    const bogus=Buffer.from(JSON.stringify({durableIdentity:{invalid:true}})).toString("base64url");
    const forged=`${bogus}.${createHmac("sha256",secret).update(bogus).digest("base64url")}`;
    const noFallback=await fetch(url,{headers:{cookie:`aqlan_flow_session=${forged}`,authorization:`Bearer ${tokenOf(own)}`}});expect([401,403]).toContain(noFallback.status);
    expect(await j.ddlLog()).toEqual([]);
  });
  it("keeps canonical DELETE authorization, body limits, CSRF and bearer transport",async()=>{
    const url=`${j.baseUrl}/api/documents/${doc}`, owner=(await j.login("owner")).cookie;
    const json={"Content-Type":"application/json"};
    expect((await fetch(url,{method:"DELETE",headers:{cookie:own,Origin:j.baseUrl,...json},body:JSON.stringify({note:"Synthetic reason"})})).status).toBe(403);
    expect((await fetch(url,{method:"DELETE",headers:{cookie:owner,Origin:"https://foreign.example",...json},body:JSON.stringify({note:"Synthetic reason"})})).status).toBe(403);
    expect(await chunkedTooLarge(url,owner,j.baseUrl)).toBe(413);
    expect((await j.db.query("SELECT removed_at FROM patient_documents WHERE id=$1",[doc])).rows[0].removed_at).toBeNull();
    const hidden=await fetch(url,{method:"DELETE",headers:{authorization:`Bearer ${tokenOf(owner)}`,Origin:j.baseUrl,...json},body:JSON.stringify({note:"Synthetic reason"})});
    expect(hidden.status).toBe(200);expect((await fetch(url,{headers:{cookie:own}})).status).toBe(404);
    expect(await j.ddlLog()).toEqual([]);
  });
});
