import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SessionProvider, useSession, useSessionActions, type SessionInfo } from "../../components/SessionProvider";
import { useChairReadiness, type VisitReadiness } from "../../components/today/useChairReadiness";
import { ReadinessChip } from "../../components/today/ReadinessChip";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../../lib/doctor-permissions";

const A: SessionInfo = { username: "today-synthetic-a", role: "doctor",
  permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: true } };
const B: SessionInfo = { ...A, username: "today-synthetic-b" };
const LIMITED: SessionInfo = { ...A, permissions: { ...A.permissions!, canViewPatientPayments: false } };
const warnings = ["تحذير المريض الأول الاصطناعي", "تحذير المريض الثاني الاصطناعي"];
type Pending = { id: number; path: string; signal: AbortSignal | null; jsonCalls: number;
  headers: (status: number) => void; body: (value: unknown) => void; fail: () => void };
const reads: Pending[] = [], unexpected: string[] = [], clears: number[] = [];
const captured = new Map<string, () => unknown>();
let currentReload: (() => Promise<void>) | null = null;
let visibility = "visible", setups = 0, cleanups = 0;
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input), location.href), method = init?.method ?? "GET";
  if (url.origin !== location.origin || url.pathname !== "/api/visits/readiness" || url.search || method !== "GET") {
    unexpected.push(method + " " + url.origin + url.pathname);
    return Promise.reject(new Error("Unallowlisted synthetic request"));
  }
  let headers!: (response: Response) => void, body!: (value: unknown) => void, reject!: (error: Error) => void;
  const decoded = new Promise<unknown>((resolve) => { body = resolve; });
  const request: Pending = { id: reads.length, path: url.pathname, signal: init?.signal ?? null, jsonCalls: 0,
    headers: status => headers({ status, ok: status >= 200 && status < 300,
      json: () => { request.jsonCalls++; return decoded; } } as Response),
    body: value => body(value), fail: () => reject(new TypeError("Synthetic offline")),
  };
  reads.push(request);
  // Deliberately deliver late responses after abort: ownership is the guard.
  return new Promise<Response>((resolve, fail) => { headers = resolve; reject = fail; });
};
const ready = (patient: number, options: { cleared?: boolean; redacted?: boolean; warning?: string } = {}) => {
  const item: VisitReadiness = {
    visitId: 701, patientId: patient, status: "waiting", chair: null,
    arrivedAt: "2026-10-05T06:00:00Z", seatedAt: null, signedAt: null,
    cleared: options.cleared ? { at: "2026-10-05T06:01:00Z", by: "synthetic" } : null,
    checklist: [{ key: "alerts", state: "attention", label: options.warning ?? warnings[patient === 91 ? 0 : 1] }],
    attention: 1, alerts: [options.warning ?? warnings[patient === 91 ? 0 : 1]], historyAlerts: [],
    editableAlert: options.warning ?? warnings[patient === 91 ? 0 : 1],
    balances: [{ currency: "SAR", dueMinor: 900_000, warn: true }],
  };
  if (options.redacted) Object.assign(item, { checklist: null, attention: null, alerts: null,
    historyAlerts: null, editableAlert: null, balances: null });
  return { items: [item], requireClearance: false };
};
function one(id: number) { const request = reads[id]; if (!request) throw new Error("Unknown read"); return request; }
const api = {
  snapshot: () => ({ setups, cleanups, unexpected: [...unexpected], clears: [...clears],
    reads: reads.map(({ id, path, signal, jsonCalls }) => ({ id, path, aborted: signal?.aborted ?? false, jsonCalls })) }),
  headers: (id: number, status = 200) => one(id).headers(status),
  body: (id: number, patient = 91, options: Parameters<typeof ready>[1] = {}) => one(id).body(ready(patient, options)),
  rawBody: (id: number, value: unknown) => one(id).body(value),
  respond: (id: number, patient = 91, options: Parameters<typeof ready>[1] = {}) => {
    one(id).headers(200); one(id).body(ready(patient, options));
  },
  fail: (id: number) => one(id).fail(),
  reload: () => { if (!currentReload) throw new Error("Missing committed hook"); void currentReload(); },
  captureReload: (key: string) => {
    if (!currentReload) throw new Error("Missing committed hook"); captured.set(key, currentReload);
  },
  captureRetry: (key: string, element: HTMLElement) => {
    if (element.tagName !== "BUTTON" || !document.getElementById("today-fixture")?.contains(element)) throw new Error("Expected committed retry");
    const propKey = Object.getOwnPropertyNames(element).find(name => name.startsWith("__reactProps$"));
    const props = propKey ? (element as unknown as Record<string, unknown>)[propKey] : null;
    const handler = props && typeof props === "object" ? (props as Record<string, unknown>).onClick : null;
    if (typeof handler !== "function") throw new Error("Committed callback missing");
    captured.set(key, handler as () => unknown);
  },
  replay: (key: string) => {
    const handler = captured.get(key); if (!handler) throw new Error("Unknown retained callback"); void handler();
  },
  visibility: (next: "visible" | "hidden") => { visibility = next; document.dispatchEvent(new Event("visibilitychange")); },
};
export type TodayFixtureSnapshot = ReturnType<typeof api.snapshot>;
declare global { interface Window { __todayReadinessFixture: typeof api } }
window.__todayReadinessFixture = api;

function Probe({ patient }: { patient: number }) {
  const session = useSession(), visit = { id: 701, patientId: patient, status: "waiting", chair: null };
  const readiness = useChairReadiness(30_000, session, [visit]);
  useLayoutEffect(() => { currentReload = readiness.reload; return () => { currentReload = null; }; }, [readiness.reload]);
  useLayoutEffect(() => { setups++; return () => { cleanups++; }; }, []);
  return <section id="today-fixture" data-state={readiness.state}>
    <ReadinessChip visit={visit} item={readiness.byVisit.get(701)} state={readiness.state}
      canClear={readiness.canClear} busy={false} onClear={id => clears.push(id)} onRetry={readiness.reload} />
  </section>;
}
function Controls() {
  const { setSession } = useSessionActions();
  const [patient, setPatient] = useState(91), [mounted, setMounted] = useState(true);
  return <>
    <nav aria-label="Synthetic Today controls">
      <button id="patient-b" onClick={() => setPatient(92)}>Patient B</button>
      <button id="patient-aba" onClick={() => { flushSync(() => setPatient(92)); flushSync(() => setPatient(91)); }}>Patient ABA</button>
      <button id="principal-aba" onClick={() => { flushSync(() => setSession(B)); flushSync(() => setSession(A)); }}>Principal ABA</button>
      <button id="permission-aba" onClick={() => { flushSync(() => setSession(LIMITED)); flushSync(() => setSession(A)); }}>Permission ABA</button>
      <button id="limited" onClick={() => setSession(LIMITED)}>Revoke money permission</button>
      <button id="toggle" onClick={() => setMounted(value => !value)}>Toggle mount</button>
    </nav>
    {mounted ? <Probe patient={patient} /> : null}
  </>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<StrictMode><SessionProvider value={A}><Controls /></SessionProvider></StrictMode>);
