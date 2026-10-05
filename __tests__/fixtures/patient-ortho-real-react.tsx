import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SessionProvider, useSession, useSessionActions, type SessionInfo } from "../../components/SessionProvider";
import { PatientOrtho } from "../../components/PatientOrtho";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../../lib/doctor-permissions";

// Test-only entry. The acceptance runner bundles this in memory and serves it
// exclusively through Playwright interception. PatientOrtho, all its local
// forms, SessionProvider and React development StrictMode remain real.
const A: SessionInfo = { username: "ortho-reader-a", role: "doctor", displayName: "Synthetic A",
  permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewAllPatients: true } };
const B: SessionInfo = { ...A, username: "ortho-reader-b" };
const LIMITED: SessionInfo = { ...A, permissions: { ...A.permissions!, canEditPlans: false } };
const OTHER_ROLE: SessionInfo = { ...A, role: "admin" };
export const orthoFixtureIds = { patientA: 939101, patientB: 939102, caseId: 938101, visitId: 937101 } as const;
const { patientA, patientB, caseId, visitId } = orthoFixtureIds;

function caseRow(marker = "accepted-case-a", unsigned = false) {
  const currentVisitId: number | null = unsigned ? visitId : null;
  return { id: caseId, patientId: patientA, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: marker,
    status: "active", phase: "working", startDate: "2026-01-04", plannedMonths: 18,
    upperWire: "016 NiTi", lowerWire: "012 NiTi", planId: null, retainer: null, retainerOn: null,
    note: null, closedAt: null, closedBy: null, closedNote: null, baselineKind: null,
    baselineRecordedAt: null, elastics: null, responsibleDoctorName: null, legacyFinancialMode: null,
    remainingObjectives: null, photosVisible: false,
    adjustments: [{ id: 936101, visitId: currentVisitId, visitSigned: !unsigned,
      doneOn: "2026-10-04", phase: "working", upperWire: "016 NiTi", lowerWire: "012 NiTi",
      elastics: "class_ii", elasticNote: "synthetic prior regimen", done: "synthetic prior adjustment",
      nextWeeks: 6, note: null, recordedBy: "synthetic doctor", photos: [] }],
    progress: { monthsElapsed: 9, monthsPlanned: 18, monthsRemaining: 9, percent: 50,
      overdue: false, adjustments: 1, lastAdjustment: "2026-10-04", daysSinceLast: 0 } };
}
type Pending = { id: number; path: string; method: string; signal: AbortSignal | null;
  jsonCalls: number; status: number | null; settled: boolean; submitted: unknown;
  headers: (status: number) => void; body: (value: unknown) => void; fail: () => void; badJSON: () => void };
const requests: Pending[] = [];
const unexpected: string[] = [];
const permits: Array<{ method: string; path: string; remaining: number }> = [];
const created: Array<{ url: string; fileId: number; name: string; size: number; type: string; lastModified: number }> = [];
const revoked: string[] = [];
const identities = new WeakMap<Blob, number>();
let nextFileId = 0;
function fileId(file: Blob) {
  let id = identities.get(file); if (!id) { id = ++nextFileId; identities.set(file, id); } return id;
}
const createObjectURL = URL.createObjectURL.bind(URL);
const revokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob: Blob | MediaSource) => {
  const url = createObjectURL(blob);
  if (blob instanceof File) created.push({ url, fileId: fileId(blob), name: blob.name,
    size: blob.size, type: blob.type, lastModified: blob.lastModified });
  return url;
};
URL.revokeObjectURL = (url: string) => { revoked.push(url); revokeObjectURL(url); };
function submitted(body: BodyInit | null | undefined): unknown {
  if (body instanceof FormData) return [...body.entries()].map(([key, value]) => [key,
    value instanceof File ? { fileId: fileId(value), name: value.name, size: value.size,
      type: value.type, lastModified: value.lastModified } : value]);
  if (typeof body === "string") { try { return JSON.parse(body); } catch { return body; } }
  return null;
}
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), location.href); const method = (init?.method ?? "GET").toUpperCase();
  const path = `${url.pathname}${url.search}`;
  const parentRead = method === "GET" && (url.pathname === "/api/ortho" || /^\/api\/patients\/93910[12]$/.test(url.pathname));
  if (url.origin === location.origin && method === "GET" && path === "/api/parties?kind=doctor") {
    return Promise.resolve({ ok: true, status: 200, json: async () => [{ id: 935101, name: "Synthetic responsible doctor" }] } as Response);
  }
  const permit = permits.find((one) => one.method === method && one.path === path && one.remaining > 0);
  if (url.origin !== location.origin || (!parentRead && !permit)) {
    unexpected.push(`${method} ${url.origin}${path}`);
    return Promise.reject(new Error("Unallowlisted synthetic fixture transport"));
  }
  if (permit) permit.remaining--;
  let resolveHeaders!: (value: Response) => void; let rejectHeaders!: (reason: Error) => void;
  let resolveBody!: (value: unknown) => void; let rejectBody!: (reason: Error) => void;
  const body = new Promise<unknown>((resolve, reject) => { resolveBody = resolve; rejectBody = reject; });
  const pending: Pending = { id: requests.length + 1, path, method, signal: init?.signal ?? null,
    jsonCalls: 0, status: null, settled: false, submitted: submitted(init?.body),
    headers: (status) => { pending.status = status; resolveHeaders({ status, ok: status >= 200 && status < 300,
      json: () => { pending.jsonCalls++; return body; } } as Response); },
    body: (value) => { pending.settled = true; resolveBody(value); },
    fail: () => { pending.settled = true; rejectHeaders(new TypeError("Synthetic disconnected transport")); },
    badJSON: () => { pending.settled = true; rejectBody(new SyntaxError("Synthetic malformed body")); } };
  requests.push(pending);
  // Deliberately ignore AbortSignal: ownership must fence headers, body and
  // post-response upload chains even when cancellation cannot stop completion.
  return new Promise<Response>((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
};
function request(id: number) {
  const value = requests.find((item) => item.id === id); if (!value) throw new Error("Unknown fixture request"); return value;
}
let setups = 0; let cleanups = 0;
const commits: Array<{ owner: string; html: string; values: string[] }> = [];
let latestChildRefresh: (() => void) | null = null;
let capturedChildRefresh: (() => void) | null = null;
type HostCallback = { handler: (event: unknown) => unknown; element: HTMLElement;
  prop: "onClick" | "onSubmit"; replays: number };
const hostCallbacks = new Map<string, HostCallback>();
function captureHostCallback(key: string, element: HTMLElement, prop: HostCallback["prop"]) {
  if (!document.getElementById("fixture-ortho")?.contains(element)
    || (prop === "onClick" ? element.tagName !== "BUTTON" : element.tagName !== "FORM")) {
    throw new Error("Callback capture requires a committed real orthodontic button/form");
  }
  // Test-only inspection of React DOM's committed host props. This captures the
  // actual closure installed by real React; it does not substitute JSX, hooks,
  // components, listeners or product guards. Detached DOM events would not reach
  // React's delegated listener, so direct replay is necessary for stale-handler
  // regressions. Fail explicitly if this development React DOM detail changes.
  const propsKey = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactProps$"));
  const props = propsKey ? (element as unknown as Record<string, unknown>)[propsKey] : null;
  const handler = props && typeof props === "object" ? (props as Record<string, unknown>)[prop] : null;
  if (typeof handler !== "function") throw new Error(`Real React DOM ${prop} callback unavailable`);
  hostCallbacks.set(key, { handler: handler as HostCallback["handler"], element, prop, replays: 0 });
}
async function replayHostCallback(key: string) {
  const captured = hostCallbacks.get(key);
  if (!captured) throw new Error("Unknown captured real React callback");
  captured.replays++;
  await captured.handler({ type: captured.prop === "onSubmit" ? "submit" : "click",
    target: captured.element, currentTarget: captured.element,
    preventDefault() {}, stopPropagation() {}, });
}
const api = {
  snapshot: () => ({ setups, cleanups, unexpected: [...unexpected], created: [...created], revoked: [...revoked],
    commits: [...commits], permits: permits.map((one) => ({ ...one })),
    callbacks: [...hostCallbacks].map(([key, value]) => ({ key, prop: value.prop, tag: value.element.tagName,
      connected: value.element.isConnected, replays: value.replays })),
    requests: requests.map((one) => ({ id: one.id, path: one.path, method: one.method,
      aborted: one.signal?.aborted ?? false, jsonCalls: one.jsonCalls, status: one.status,
      settled: one.settled, submitted: one.submitted })) }),
  allow: (method: string, path: string, count = 1) => { permits.push({ method, path, remaining: count }); },
  headers: (id: number, status: number) => request(id).headers(status),
  body: (id: number, value: unknown) => request(id).body(value),
  fail: (id: number) => request(id).fail(),
  badJSON: (id: number) => request(id).badJSON(),
  respond: (id: number, value: unknown, status = 200) => { request(id).headers(status); request(id).body(value); },
  caseBody: (marker = "accepted-case-a", unsigned = false) => ({ cases: [caseRow(marker, unsigned)] }),
  patientBody: (name = "synthetic patient A") => ({ patient: { id: patientA, fullName: name, phone: "700000001" } }),
  registerChildRefresh: (callback: () => void) => { latestChildRefresh = callback; },
  captureChildRefresh: () => { capturedChildRefresh = latestChildRefresh; },
  capturedChildRefresh: () => capturedChildRefresh?.(),
  captureHostCallback,
  replayHostCallback,
};
export type OrthoFixtureSnapshot = ReturnType<typeof api.snapshot>;
declare global { interface Window { __patientOrthoFixture: typeof api } }
window.__patientOrthoFixture = api;

function Probe({ patientId }: { patientId: number }) {
  const session = useSession();
  useLayoutEffect(() => { setups++; return () => { cleanups++; }; }, []);
  useLayoutEffect(() => {
    const section = document.getElementById("fixture-ortho");
    commits.push({ owner: JSON.stringify([patientId, session?.username, session?.role, session?.permissions]),
      html: section?.innerHTML ?? "", values: [...(section?.querySelectorAll("input,textarea,select") ?? [])]
        .map((element) => (element as HTMLInputElement).value) });
  });
  return <section id="fixture-ortho"><PatientOrtho patientId={patientId} /></section>;
}
function Controls() {
  const { setSession } = useSessionActions();
  const [patientId, setPatientId] = useState<number>(patientA);
  const [mounted, setMounted] = useState(true);
  return <>
    <nav aria-label="Synthetic ownership controls">
      <button id="patient-a" onClick={() => setPatientId(patientA)}>Patient A</button>
      <button id="patient-b" onClick={() => setPatientId(patientB)}>Patient B</button>
      <button id="session-a" onClick={() => setSession(A)}>Principal A</button>
      <button id="session-b" onClick={() => setSession(B)}>Principal B</button>
      <button id="session-null" onClick={() => setSession(null)}>Logout</button>
      <button id="display-name" onClick={() => setSession({ ...A, displayName: "Renamed presentation only" })}>Display name</button>
      <button id="patient-aba" onClick={() => { flushSync(() => setPatientId(patientB)); flushSync(() => setPatientId(patientA)); }}>Patient A B A</button>
      <button id="principal-aba" onClick={() => { flushSync(() => setSession(B)); flushSync(() => setSession(A)); }}>Principal A B A</button>
      <button id="permission-aba" onClick={() => { flushSync(() => setSession(LIMITED)); flushSync(() => setSession(A)); }}>Permission A B A</button>
      <button id="role-aba" onClick={() => { flushSync(() => setSession(OTHER_ROLE)); flushSync(() => setSession(A)); }}>Role A B A</button>
      <button id="toggle-probe" onClick={() => setMounted((value) => !value)}>Toggle probe</button>
    </nav>
    {mounted ? <Probe patientId={patientId} /> : null}
  </>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<StrictMode><SessionProvider value={A}><Controls /></SessionProvider></StrictMode>);
