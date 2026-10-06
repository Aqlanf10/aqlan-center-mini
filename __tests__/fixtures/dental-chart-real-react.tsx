import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { DentalChart } from "../../components/DentalChart";
import { SessionProvider, useSessionActions, type SessionInfo } from "../../components/SessionProvider";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../../lib/doctor-permissions";

// Only network responses are replaced. Real DentalChart, SessionProvider and
// React development StrictMode execute without a clinic or database connection.
const A: SessionInfo = { username: "synthetic-chart-a", role: "doctor", permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewAllPatients: true } };
const B: SessionInfo = { ...A, username: "synthetic-chart-b" };
const LIMITED: SessionInfo = { ...A, permissions: { ...A.permissions!, canViewAllPatients: false } };
type Pending = { id: number; path: string; method: string; submitted: unknown; signal: AbortSignal | null;
  jsonCalls: number; headers: (status: number) => void; body: (value: unknown) => void; fail: () => void };
const requests: Pending[] = [], unexpected: string[] = [];
let permits = 0, setups = 0, cleanups = 0;
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), location.href), method = init?.method ?? "GET";
  if (url.origin !== location.origin || !/^\/api\/patients\/(19|20)\/chart$/.test(url.pathname)
    || url.search || !["GET", "POST"].includes(method) || (method === "POST" && permits < 1)) {
    unexpected.push(method + " " + url.origin + url.pathname + url.search);
    return Promise.reject(new Error("Unallowlisted fixture request"));
  }
  if (method === "POST") permits--;
  let resolveHeaders!: (value: Response) => void, rejectHeaders!: (reason: Error) => void;
  let resolveBody!: (value: unknown) => void;
  const body = new Promise<unknown>((resolve) => { resolveBody = resolve; });
  const pending: Pending = { id: requests.length, path: url.pathname, method,
    submitted: init?.body ? JSON.parse(String(init.body)) : null, signal: init?.signal ?? null, jsonCalls: 0,
    headers: (status) => resolveHeaders({ status, ok: status >= 200 && status < 300,
      json: () => { pending.jsonCalls++; return body; } } as Response),
    body: resolveBody, fail: () => rejectHeaders(new TypeError("Synthetic offline")),
  };
  requests.push(pending);
  // Deliberately permit completion after abort to verify ownership, not just cancellation.
  return new Promise<Response>((resolve, reject) => { resolveHeaders = resolve; rejectHeaders = reject; });
};
const captures = new Map<string, () => unknown>();
const api = {
  snapshot: () => ({ setups, cleanups, permits, unexpected: [...unexpected], requests: requests.map((one) => ({
    id: one.id, path: one.path, method: one.method, submitted: one.submitted,
    aborted: one.signal?.aborted ?? false, jsonCalls: one.jsonCalls,
  })) }),
  allow: () => { permits++; },
  headers: (id: number, status = 200) => requests[id].headers(status),
  body: (id: number, value: unknown) => requests[id].body(value),
  respond: (id: number, value: unknown, status = 200) => { requests[id].headers(status); requests[id].body(value); },
  fail: (id: number) => requests[id].fail(),
  capture: (key: string, element: HTMLElement) => {
    if (element.tagName !== "BUTTON" || !document.querySelector("#fixture-chart")?.contains(element)) throw new Error("Expected chart button");
    const propKey = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactProps$"));
    const props = propKey ? (element as unknown as Record<string, unknown>)[propKey] : null;
    const handler = props && typeof props === "object" ? (props as Record<string, unknown>).onClick : null;
    if (typeof handler !== "function") throw new Error("Expected committed React callback");
    captures.set(key, handler as () => unknown);
  },
  replay: (key: string) => { const handler = captures.get(key); if (!handler) throw new Error("Unknown captured callback"); void handler(); },
};
export type DentalChartFixtureSnapshot = ReturnType<typeof api.snapshot>;
declare global { interface Window { __dentalChartFixture: typeof api } }
window.__dentalChartFixture = api;
function Probe({ patientId }: { patientId: number }) {
  useLayoutEffect(() => { setups++; return () => { cleanups++; }; }, []);
  return <div id="fixture-chart"><DentalChart patientId={patientId} /></div>;
}
function Controls() {
  const { setSession } = useSessionActions();
  const [patientId, setPatientId] = useState(19), [mounted, setMounted] = useState(true);
  return <>
    <nav aria-label="Synthetic controls">
      <button id="patient-b" onClick={() => setPatientId(20)}>Patient B</button>
      <button id="patient-aba" onClick={() => { flushSync(() => setPatientId(20)); flushSync(() => setPatientId(19)); }}>Patient A B A</button>
      <button id="principal-b" onClick={() => setSession(B)}>Principal B</button>
      <button id="principal-aba" onClick={() => { flushSync(() => setSession(B)); flushSync(() => setSession(A)); }}>Principal A B A</button>
      <button id="permission-b" onClick={() => setSession(LIMITED)}>Permissions B</button>
      <button id="toggle-chart" onClick={() => setMounted((value) => !value)}>Toggle chart</button>
    </nav>
    {mounted ? <Probe patientId={patientId} /> : null}
  </>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<StrictMode><SessionProvider value={A}><Controls /></SessionProvider></StrictMode>);
