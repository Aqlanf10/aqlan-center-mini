import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { PatientCeph } from "../../components/PatientCeph";
import { SessionProvider, useSessionActions, type SessionInfo } from "../../components/SessionProvider";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../../lib/doctor-permissions";

// Test-only browser entry, bundled in memory and delivered by interception.
// Actual PatientCeph, SessionProvider and React development StrictMode execute.
// Only fetch responses and next/link's anchor are substituted by the test.
const patientA = 939201, patientB = 939202, caseA = 938201, caseB = 938202, documentId = 936201;
const A: SessionInfo = { username: "ceph-writer-a", role: "doctor",
  permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canUploadXrays: true } };
const B: SessionInfo = { ...A, username: "ceph-writer-b" };
const LIMITED: SessionInfo = { ...A, permissions: { ...A.permissions!, canUploadXrays: false } };
type Pending = { id: number; path: string; submitted: unknown; signal: AbortSignal | null; jsonCalls: number; settled: boolean;
  headers: (status: number) => void; body: (value: unknown) => void; fail: () => void; badJSON: () => void };
const requests: Pending[] = [], unexpected: string[] = [], callbacks: number[] = [];
const reads: string[] = [];
const imageIds = new Map([[patientA, [documentId]], [patientB, [documentId + 1]]]);
const documents = (ids: number[]) => ({ documents: ids.map((id) => ({
  id, title: "Synthetic ceph image " + id, isImage: true, mimeType: "image/png",
  takenOn: null, uploadedAt: "2026-10-05", removedAt: null,
})) });
type DocumentRead = { path: string; signal: AbortSignal | null; jsonCalls: number;
  headers: () => void; body: (ids: number[]) => void };
const documentReads: DocumentRead[] = [];
let holdNextDocuments = false;
function delayedDocuments(path: string, signal: AbortSignal | null): Promise<Response> {
  let resolveHeaders!: (value: Response) => void, resolveBody!: (value: unknown) => void;
  const body = new Promise<unknown>((resolve) => { resolveBody = resolve; });
  const read: DocumentRead = { path, signal, jsonCalls: 0,
    headers: () => resolveHeaders({ status: 200, ok: true, json: () => { read.jsonCalls++; return body; } } as Response),
    body: (ids) => resolveBody(documents(ids)),
  };
  documentReads.push(read);
  // A late response remains deliverable after abort so ownership is the guard.
  return new Promise<Response>((resolve) => { resolveHeaders = resolve; });
}
let permits = 0, setups = 0, cleanups = 0;
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), location.href), method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname + url.search;
  if (url.origin !== location.origin) {
    unexpected.push(method + " " + url.origin + path); return Promise.reject(new Error("External request blocked"));
  }
  if (method === "GET") {
    reads.push(path);
    let body: unknown;
    if (path === "/api/ceph-reference-sets") body = { sets: [] };
    else if ([patientA, patientB].some((id) => path === "/api/patients/" + id + "/ceph")) body = { analyses: [] };
    else if ([patientA, patientB].some((id) => path === "/api/patients/" + id + "/documents")) {
      if (holdNextDocuments) { holdNextDocuments = false; return delayedDocuments(path, init?.signal ?? null); }
      body = documents(imageIds.get(path.includes(String(patientA)) ? patientA : patientB) ?? []);
    }
    else if ([patientA, patientB].some((id) => path === "/api/ortho?patientId=" + id)) body = { cases: [{ id: caseA }, { id: caseB }] };
    else { unexpected.push(method + " " + path); return Promise.reject(new Error("Unallowlisted read")); }
    return Promise.resolve({ status: 200, ok: true, json: async () => body } as Response);
  }
  if (method !== "POST" || ![patientA, patientB].some((id) => path === "/api/patients/" + id + "/ceph") || permits < 1) {
    unexpected.push(method + " " + path); return Promise.reject(new Error("Unallowlisted mutation"));
  }
  permits--;
  let resolveHeaders!: (value: Response) => void, rejectHeaders!: (reason: Error) => void;
  let resolveBody!: (value: unknown) => void, rejectBody!: (reason: Error) => void;
  const body = new Promise<unknown>((resolve, reject) => { resolveBody = resolve; rejectBody = reject; });
  const request: Pending = { id: requests.length + 1, path, submitted: JSON.parse(String(init?.body)),
    signal: init?.signal ?? null, jsonCalls: 0, settled: false,
    headers: (status) => resolveHeaders({ status, ok: status >= 200 && status < 300,
      json: () => { request.jsonCalls++; return body; } } as Response),
    body: (value) => { request.settled = true; resolveBody(value); },
    fail: () => { request.settled = true; rejectHeaders(new TypeError("Synthetic network failure")); },
    badJSON: () => { request.settled = true; rejectBody(new SyntaxError("Synthetic JSON failure")); },
  };
  requests.push(request);
  // Deliberately ignore abort: cancellation must never be the only stale-effect guard.
  return new Promise<Response>((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
};
function request(id: number) {
  const row = requests.find((one) => one.id === id); if (!row) throw new Error("Unknown fixture request"); return row;
}
const captured = new Map<string, () => unknown>();
const capturedChanges = new Map<string, (event: { target: { value: string } }) => unknown>();
const api = {
  snapshot: () => ({ setups, cleanups, callbacks: [...callbacks], unexpected: [...unexpected], permits,
    reads: [...reads], documentReads: documentReads.map((one, index) => ({ id: index, path: one.path,
      aborted: one.signal?.aborted ?? false, jsonCalls: one.jsonCalls })),
    requests: requests.map((one) => ({ id: one.id, path: one.path, submitted: one.submitted,
      aborted: one.signal?.aborted ?? false, jsonCalls: one.jsonCalls, settled: one.settled })) }),
  allow: (count = 1) => { permits += count; },
  setImages: (patient: "a" | "b", ids: number[]) => imageIds.set(patient === "a" ? patientA : patientB, ids),
  holdDocuments: () => { holdNextDocuments = true; },
  documentHeaders: (id: number) => documentReads[id].headers(),
  documentBody: (id: number, ids: number[]) => documentReads[id].body(ids),
  headers: (id: number, status = 201) => request(id).headers(status),
  body: (id: number, value: unknown) => request(id).body(value),
  respond: (id: number, value: unknown = { id: 937201 }, status = 201) => { request(id).headers(status); request(id).body(value); },
  fail: (id: number) => request(id).fail(),
  badJSON: (id: number) => request(id).badJSON(),
  capture: (key: string, element: HTMLElement) => {
    if (element.tagName !== "BUTTON" || !document.getElementById("fixture-ceph")?.contains(element)) throw new Error("Expected committed ceph button");
    // Test-only access to the actual host callback. Detached DOM events would
    // miss React's delegated listener, so replay this captured closure directly.
    const propKey = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactProps$"));
    const props = propKey ? (element as unknown as Record<string, unknown>)[propKey] : null;
    const handler = props && typeof props === "object" ? (props as Record<string, unknown>).onClick : null;
    if (typeof handler !== "function") throw new Error("Committed React callback unavailable");
    captured.set(key, handler as () => unknown);
  },
  replay: (key: string) => { const handler = captured.get(key); if (!handler) throw new Error("Unknown captured button"); handler(); },
  captureChange: (key: string, element: HTMLElement) => {
    if (element.tagName !== "SELECT" || !document.getElementById("fixture-ceph")?.contains(element)) throw new Error("Expected committed ceph select");
    const propKey = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactProps$"));
    const props = propKey ? (element as unknown as Record<string, unknown>)[propKey] : null;
    const handler = props && typeof props === "object" ? (props as Record<string, unknown>).onChange : null;
    if (typeof handler !== "function") throw new Error("Committed React change callback unavailable");
    capturedChanges.set(key, handler as (event: { target: { value: string } }) => unknown);
  },
  replayChange: (key: string, value: string) => {
    const handler = capturedChanges.get(key); if (!handler) throw new Error("Unknown captured select"); handler({ target: { value } });
  },
};
export type CephFixtureSnapshot = ReturnType<typeof api.snapshot>;
declare global { interface Window { __patientCephFixture: typeof api } }
window.__patientCephFixture = api;

function Probe({ patientId, caseId, onCreated }: { patientId: number; caseId: number; onCreated: (id: number) => void }) {
  useLayoutEffect(() => { setups++; return () => { cleanups++; }; }, []);
  return <div id="fixture-ceph"><PatientCeph patientId={patientId} orthoCaseId={caseId} embedded currentPhase="aligning" onAnalysisCreated={onCreated} /></div>;
}
function Controls() {
  const { setSession } = useSessionActions();
  const [patientId, setPatientId] = useState(patientA), [caseId, setCaseId] = useState(caseA);
  const [mounted, setMounted] = useState(true), [callbackCloses, setCallbackCloses] = useState(false);
  return <>
    <nav aria-label="Synthetic fixture controls">
      <button id="patient-a" onClick={() => setPatientId(patientA)}>Patient A</button>
      <button id="patient-b" onClick={() => setPatientId(patientB)}>Patient B</button>
      <button id="principal-a" onClick={() => setSession(A)}>Principal A</button>
      <button id="principal-b" onClick={() => setSession(B)}>Principal B</button>
      <button id="permission-a" onClick={() => setSession(A)}>Permissions A</button>
      <button id="permission-b" onClick={() => setSession(LIMITED)}>Permissions B</button>
      <button id="patient-aba" onClick={() => { flushSync(() => setPatientId(patientB)); flushSync(() => setPatientId(patientA)); }}>Patient A B A</button>
      <button id="case-aba" onClick={() => { flushSync(() => setCaseId(caseB)); flushSync(() => setCaseId(caseA)); }}>Case A B A</button>
      <button id="principal-aba" onClick={() => { flushSync(() => setSession(B)); flushSync(() => setSession(A)); }}>Principal A B A</button>
      <button id="permission-aba" onClick={() => { flushSync(() => setSession(LIMITED)); flushSync(() => setSession(A)); }}>Permissions A B A</button>
      <button id="toggle-probe" onClick={() => setMounted((value) => !value)}>Toggle diagnostic pillar</button>
      <button id="callback-closes" onClick={() => setCallbackCloses(true)}>Close in callback</button>
    </nav>
    {mounted ? <Probe patientId={patientId} caseId={caseId} onCreated={(id) => {
      callbacks.push(id);
      if (callbackCloses) flushSync(() => setMounted(false));
    }} /> : null}
  </>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<StrictMode><SessionProvider value={A}><Controls /></SessionProvider></StrictMode>);
