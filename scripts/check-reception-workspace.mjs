// Synthetic request and browser integration. No Next server, DB, credentials or disk-backed uploads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = process.cwd();
const common = { bundle: true, write: false, logLevel: "silent", jsx: "automatic", alias: { "@": root } };
const deskId = 31;
const identity = { id: deskId, fullName: "Synthetic Desk", patientNumber: "TEST-00031", phone: null };
const marker = "synthetic-private-canary";
let session, scope, moneyAccess, wrongOwner, moneyFailure, dataCalls, saved;
const fixtureRows = ["YER", "SAR", "USD"].map((currency, i) => ({
  patientId: deskId, currency, dueMinor: [1200, -500, 0][i], collectedMinor: 987654, private: marker,
}));
const fakeDb = {
  getVisitOwner: async () => ({ found: true, patientId: deskId }),
  createPatientWithDuplicateReview: async (_, confirmed) => confirmed
    ? { ok: true, patient: {...identity, medicalAlert:marker} }
    : { ok:false, duplicates:[{patient:{...identity, photoDocumentId:marker}, reason:"same_name", score:100}] },
  searchPatients: async () => [{...identity, photoDocumentId:marker}],
  CLINIC_TIME_ZONE: "Asia/Aden",
  findUserByUsername: async () => ({ partyId: 7, permissions: {} }),
  doctorOwnsPatient: async () => scope,
  getPatientFile: async id => { dataCalls.push("clinical"); return { patient: { id, medicalAlert: marker } }; },
  listPatientPlannedVisits: async id => { assert.equal(id, deskId); return []; },
  getPool: () => ({ query: async (sql, args) => {
    if (sql.includes('AS "openVisitId"')) {
      assert.equal(args[0], deskId);
      assert.equal(args[1], "Asia/Aden");
      assert.match(args[2], /^\d{4}-\d{2}-\d{2}$/);
      assert.match(sql, /v.patient_id = p.id/);
      assert.match(sql, /WHERE p.id = \$1/);
      dataCalls.push("activeVisit");
      return { rows: [{ openVisitId: null }] };
    }
    assert.deepEqual(args, [deskId]); assert.match(sql, /WHERE (patient_)?id = \$1/);
    assert.doesNotMatch(sql, /SELECT \*/i);
    dataCalls.push("query");
    if (sql.includes("FROM patients")) return { rows: [{ ...identity, medicalAlert: marker, photoDocumentId: 99 }] };
    return { rows: [{ id: 44, currency: "SAR", private: marker }] };
  } }),
  getSettings: async () => ({}), validateDocumentAssociations: async () => {},
  recordAudit: async () => {}, recordDocument: async record => { saved = record; return { id: 55, storageKey: marker }; },
  listPatientDocuments: async () => { throw Error("Unexpected document list"); },
  getDocumentForDownload: async () => { throw Error("Unexpected download"); },
};
const moneyFixture = () => ({
  id:deskId, balances: fixtureRows.map(({currency,dueMinor}) => ({currency,dueMinor,paidMinor:0,scheduledDueMinor:0,otherMinor:0})),
  invoices:[], agreements:[], receipts:[], schedules:[], history:[],
  targets:{ invoices:[{id:44,currency:"SAR"}], plans:[], openings:["USD"] },
});
const modules = {
  "@/lib/assistant-patient-file": { getAssistantPatientFile: async () => null },
  "@/lib/reception-patient-account": {readReceptionPatientAccount: async id => {
    assert.equal(id, deskId);
    if (moneyFailure || wrongOwner) throw new Error("Unavailable account");
    return moneyFixture();
  }},
  "@/lib/planned-visit-projection": {},
  "@/lib/operational-access": { authorizeVisit: async () => ({ok:true,patientId:deskId}) },
  "@/lib/invoice-settlement-position": { InvoiceSettlementError: class extends Error {} },
  "@/lib/walkout-access": { canSeeWalkout: async () => true },
  "@/lib/reception-handoff-db": { readReceptionHandoff: async () => ({status:"pending", handledReason:marker}) },
  "@/lib/checkout-db": { readVisitCheckout: async () => {
    dataCalls.push("checkout");
    return { walkout: { visitId:3,patientId:deskId,patientName:identity.fullName,signedAt:"2026-11-27T10:00:00Z",arrivedAt:"2026-11-27T09:00:00Z",
      doctorName:marker,treatmentDone:marker,nextPlan:marker,deferred:false,lines:[{description:marker,financialReviewRequired:true}],orthoAdjustment:null,
      invoice:null,balances:[],nextAppointment:null,checkout:{previous:{},current:{},invoicePaidMinor:0} },
      summary:[],dueRecommendation:null,today:"2026-11-27" }; } },
  "next/server": { NextResponse: Response },
  "@/lib/session": { requireSession: async () => session },
  "@/lib/db": fakeDb,
  "@/lib/patient-access": { canAccessPatient: async () => scope, canViewPatientMoney: async () => moneyAccess },
  "@/lib/legacy-balance-arrangements-db": { listLegacyOpeningPositions: async () => [{ currency: "USD", remainingMinor: 20 }] },
  "@/lib/patient-appointments-reader": { readPatientAppointments: async () => ({ today: "2026-11-27", appointments: [], nextCursor: null }) },
  "@/lib/files": { storageStatus: async () => ({ ready: true }), putFile: async bytes => ({ sizeBytes: bytes.length, key: marker, sha256: marker }) },
};
function mockPlugin(mapping) {
  return { name: "synthetic-dependencies", setup(b) {
    b.onResolve({ filter: /.*/ }, arg => arg.path in mapping ? { path: arg.path, namespace: "fixture" } : undefined);
    b.onLoad({ filter: /.*/, namespace: "fixture" }, arg => ({ contents: mapping[arg.path], loader: "js" }));
  } };
}
globalThis.__deskModules = modules;
const paths = {
  registration: "./app/api/patients/route.ts", workflow: "./app/api/patients/[id]/workflow/route.ts",
  checkout: "./app/api/visits/[id]/walkout/route.ts",
  patient: "./app/api/patients/[id]/route.ts",
  documents: "./app/api/patients/[id]/documents/route.ts",
  download: "./app/api/documents/[id]/route.ts",
};
const mockSources = Object.fromEntries(Object.keys(modules).map(key => [key, `module.exports = globalThis.__deskModules[${JSON.stringify(key)}]`]));
const server = await build({ ...common, format: "cjs", platform: "node",
  stdin: { contents: Object.entries(paths).map(([name, path]) => `export * as ${name} from ${JSON.stringify(path)};`).join("\n"), resolveDir: root },
  plugins: [mockPlugin(mockSources)] });
const compiled = { exports: {} };
new Function("module", "require", server.outputFiles[0].text)(compiled, createRequire(import.meta.url));
const routes = compiled.exports;
const reset = () => { session = { role: "reception", username: "synthetic" }; scope = true; moneyAccess = true;
  wrongOwner = false; moneyFailure = false; dataCalls = []; saved = null; };
const invoke = (name, query = "", id = deskId, init = {}) => {
  const req = new Request("http://desk.invalid/api/patients/" + id + query, init);
  return routes[name][init.method || "GET"](req, { params: Promise.resolve({ id: String(id) }) });
};
const okPrivate = async res => {
  assert.equal(res.status, 200); assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  const body = await res.json(); assert.ok(!JSON.stringify(body).includes(marker)); return body;
};
test("desk identity and balance are explicit, scoped representations", async () => {
  reset();
  assert.deepEqual(await okPrivate(await invoke("patient", "?projection=reception")), identity);
  assert.deepEqual(dataCalls, ["query"]);
  const money = await okPrivate(await invoke("patient", "?projection=reception-money"));
  assert.deepEqual(money, { ...moneyFixture(), openVisitId:null, canCollect:true });
  wrongOwner = true; assert.equal((await invoke("patient", "?projection=reception-money")).status, 500);
});
test("role, patient scope, money permission and malformed queries fail before data access", async () => {
  reset();
  assert.equal((await invoke("patient")).status, 403);
  for (const role of ["cashier", "accountant", "assistant", "doctor", "admin"]) {
    session.role = role;
    assert.equal((await invoke("patient", "?projection=reception")).status, 403);
  }
  session.role = "reception";
  for (const query of ["?projection=reception&id=9", "?projection=reception&projection=appointments", "?projection=unknown"]) {
    assert.equal((await invoke("patient", query)).status, 400);
  }
  assert.equal((await invoke("patient", "?projection=reception", "1.1")).status, 400);
  scope = false; assert.equal((await invoke("patient", "?projection=reception")).status, 404);
  scope = true; moneyAccess = false; assert.equal((await invoke("patient", "?projection=reception-money")).status, 403);
  session = null; assert.equal((await invoke("patient", "?projection=reception")).status, 401);
  assert.deepEqual(dataCalls, []);
});
test("authorized clinical reader and scoped appointment reader retain their contracts", async () => {
  reset();
  const appt = await okPrivate(await invoke("patient", "?projection=appointments&view=upcoming"));
  assert.equal(appt.patientId, deskId); assert.deepEqual(appt.appointments, []);
  for (const role of ["doctor", "admin"]) {
    session.role = role; assert.equal((await invoke("patient")).status, 200);
  }
  session.role = "doctor"; scope = false;
  assert.equal((await invoke("patient")).status, 403);
  assert.deepEqual(dataCalls, ["clinical", "clinical"]);
});
test("registration, duplicate review and search return identity only", async () => {
  reset();
  const send = confirmDuplicate => invoke("registration", "", deskId, {method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({fullName:identity.fullName,confirmDuplicate})});
  const warning = await send(false);
  assert.equal(warning.status,409); assert.deepEqual((await warning.json()).duplicates,[{reason:"same_name",patient:identity}]);
  const result = await send(true); assert.equal(result.status,201); assert.deepEqual(await result.json(),identity);
  assert.deepEqual(await (await invoke("registration","?q=Synthetic")).json(),[identity]);
});
test("visit checkout binds both IDs and preserves financial review after redaction", async () => {
  reset();
  assert.equal((await invoke("workflow")).status,403);
  assert.equal((await invoke("checkout","?patientId=99",3)).status,404);
  assert.deepEqual(dataCalls,[]);
  const checkout = await okPrivate(await invoke("checkout","?patientId=31",3));
  assert.equal(checkout.patientId,31); assert.equal(checkout.financialReviewRequired,true);
  assert.deepEqual(checkout.lines,[]); assert.ok(!("treatmentDone" in checkout));
});
const upload = () => {
  const form = new FormData();
  form.set("file", new File(["%PDF-1.4\nfixture\n%%EOF"], "synthetic.pdf", { type: "application/pdf" }));
  form.set("kind", "report"); return form;
};
test("desk can upload externally without reading gallery or bytes", async () => {
  reset();
  for (const route of ["documents", "download"]) assert.equal((await invoke(route)).status, 403);
  let form = upload(); form.set("orthoCaseId", "1");
  assert.equal((await invoke("documents", "", deskId, { method: "POST", body: form })).status, 400);
  assert.equal(saved, null);
  const res = await invoke("documents", "", deskId, { method: "POST", body: upload() });
  assert.equal(res.status, 201); assert.deepEqual(await res.json(), { uploaded: true });
  assert.equal(saved.patientId, deskId);
});

test(process.env.RECEPTION_TEST_DOM ? "React DOM: reception page mounts bounded readers after a clinical deep link" : "Chromium: reception booking, collection and upload with synthetic services", async () => {
  reset();
  const errors = [], paths = [], unexpected = [], payments = [];
  const fakeSession = 'exports.useSession = () => window.syntheticSession; exports.useSessionActions = () => ({session:window.syntheticSession,ready:true});';
  const doubles = {
    "@/components/PatientLedger": "exports.PatientLedger = () => null;",
    "@/components/SessionProvider": fakeSession,
    "./SessionProvider": fakeSession,
    "@/components/patient/TodayVisitTab": 'exports.TodayVisitTab = () => null;',
    "./useMoneyAttempt": `exports.useMoneyAttempt = () => ({ready:true, attempt:null, consume(){},
      run:async req => { await fetch(req.url,{method:"POST", body:req.body}); return {kind:"confirmed", acknowledgment:{paymentId:1}}; } });`,
  };
  const preserved = new Set(["react", "react/jsx-runtime", "./ReceptionWorkspace", "@/lib/checkout-visit-request",
    "@/components/SessionProvider", "@/lib/patient-appointments-contract"]);
  const browserBuild = await build({ ...common, format: "iife", platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import {createRoot} from 'react-dom/client';
      import {Suspense} from 'react';
      import Page from './app/patients/[id]/page';
      window.syntheticSession = {username:'synthetic', role:'reception'};
      const root = createRoot(document.getElementById('root'));
      const params=Promise.resolve({id:'31'}), searchParams=Promise.resolve({tab:'treatment',sub:'ortho'});
      root.render(<Suspense><Page params={params} searchParams={searchParams}/></Suspense>);
    ` }, plugins: [{ name: "isolate-unused-clinical-tree", setup(b) {
      b.onResolve({ filter: /.*/ }, a => {
        if (a.importer.endsWith("/app/patients/[id]/page.tsx") && !preserved.has(a.path))
          return { path: a.path, namespace: "unused" };
      });
      b.onLoad({ filter: /.*/, namespace: "unused" }, () => ({ contents: "module.exports={};" }));
    } }, mockPlugin(doubles)] });
  if (process.env.RECEPTION_TEST_DOM) {
    const {parseHTML} = await import(process.env.RECEPTION_TEST_DOM);
    const vm = await import("node:vm");
    const { window: dom } = parseHTML('<html><body><div id="root"></div></body></html>');
    const document = dom.document;
    const context = {document, location:{protocol:"http:",href:"http://desk.invalid",search:"?tab=treatment"}, navigator:{userAgent:"synthetic"},
      URL, URLSearchParams, Promise, AbortController, setTimeout,clearTimeout,setInterval:(fn,t)=>setInterval(fn,t).unref(),clearInterval,queueMicrotask, console, TextEncoder,
      FormData, Intl, Date, HTMLElement:dom.HTMLElement, HTMLIFrameElement:dom.HTMLIFrameElement,
      addEventListener:()=>{},removeEventListener:()=>{}, fetch:async(url, opts={})=>{
        const u=new URL(url,"http://desk.invalid"); const mode=u.searchParams.get("projection");
        paths.push(u.pathname+u.search);
        assert.equal(u.pathname,"/api/patients/31"); assert.ok(["appointments","reception","reception-money","reception-booking"].includes(mode));
        return invoke("patient",u.search);
      }};
    context.window=context; context.self=context;
    vm.runInNewContext(browserBuild.outputFiles[0].text,context);
    for(let i=0;i<60 && !document.querySelector("select");i++) await new Promise(r=>setTimeout(r,25));
    assert.ok(document.body.textContent.includes("Synthetic Desk"),document.body.textContent);
    assert.ok(document.body.textContent.includes("تحصيل دفعة"),document.body.textContent);
    assert.ok(document.querySelector("input[type=file]")); assert.ok(paths.some(p=>p.includes("projection=appointments")));
    assert.ok(!document.body.textContent.includes(marker));
    console.log("Synthetic DOM: patient header, booking, collection, upload, scoped appointments; allowed requests:", paths);
    return;
  }
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(6000);
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.hostname !== "desk.invalid") throw Error("Unexpected network");
      const path = url.pathname;
      if (req.isNavigationRequest()) return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>' });
      if (path === "/fixture.js") return route.fulfill({contentType: "text/javascript; charset=utf-8", body: browserBuild.outputFiles[0].text});
      paths.push(req.method() + " " + path + url.search);
      let res;
      if (path === "/api/patients/31" && req.method() === "GET") {
        if (!["appointments", "reception", "reception-money", "reception-booking"].includes(url.searchParams.get("projection"))) unexpected.push(req.url());
        res = await invoke("patient", url.search);
      } else if (path === "/api/patients/31/documents" && req.method() === "POST") {
        res = await routes.documents.POST(new Request(req.url(), {method:"POST", headers:req.headers(), body:req.postDataBuffer()}),
          {params:Promise.resolve({id:"31"})});
      } else if (path === "/api/payments" && req.method() === "POST") {
        payments.push(req.postDataJSON()); res = Response.json({ok:true});
      } else if (["/api/parties", "/api/settings/appointment-services", "/api/appointments/availability"].includes(path)) {
        res = Response.json([]);
      } else {
        unexpected.push(req.url()); res = Response.json({}, {status:403});
      }
      await route.fulfill({status:res.status, headers:Object.fromEntries(res.headers), body:await res.text()});
    });
    await page.goto("http://desk.invalid/patients/31?tab=treatment&sub=ortho");
    await page.getByRole("heading", { name: identity.fullName }).waitFor();
    await page.getByRole("button", { name:"حجز موعد", exact:true }).click();
    await page.getByText("حجز موعد للمريض: Synthetic Desk").waitFor();
    await page.getByRole("button", {name:"إغلاق", exact:true}).click();
    await page.getByLabel("تقييد الدفعة").selectOption("invoice-44");
    await page.getByRole("button", {name:"تحصيل دفعة", exact:true}).click();
    await page.getByLabel("المبلغ", {exact:true}).fill("10");
    await page.getByRole("button", {name:"سجّل الدفعة واطبع السند"}).click();
    await page.getByRole("button", {name:"تحصيل دفعة", exact:true}).waitFor();
    assert.equal(payments.length, 1); assert.equal(payments[0].patientId, deskId);
    assert.equal(payments[0].invoiceId, "44"); assert.equal(payments[0].currency, "SAR");
    await page.locator('input[type=file]').setInputFiles({name:"synthetic.pdf", mimeType:"application/pdf", buffer:Buffer.from("%PDF-1.4\nfixture\n%%EOF")});
    await page.getByRole("button", {name:"رفع المستند", exact:true}).click();
    await page.getByText("رُفع المستند إلى ملف المريض.").waitFor();
    moneyFailure = true; await page.reload();
    await page.getByText("تعذّر التحقق من الرصيد.").waitFor();
    assert.ok(await page.getByRole("button",{name:"حجز موعد",exact:true}).isVisible());
    assert.equal(await page.getByRole("button",{name:"تحصيل دفعة",exact:true}).count(), 0);
    assert.ok(paths.some(url => url.includes("projection=appointments")));
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    assert.ok(!(await page.locator("body").innerText()).includes(marker));
  } finally { await browser.close(); }
});
