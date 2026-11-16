import { StrictMode, startTransition, useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanonicalCephCreate } from "../../components/patient/CanonicalCephCreate";
import type { CanonicalCephList } from "../../lib/canonical-ceph-projection";

const list: CanonicalCephList = { projection: "ceph-summary", patientId: 801, clinicTimeZone: "Asia/Aden", analyses: [], hasMore: false };
const choices = { projection: "ceph-create-context", patientId: 801, clinicTimeZone: "Asia/Aden", imagesBefore: null, nextImagesBefore: null, hasOpenDraft: false,
  images: [{ id: 901, title: "SYN image", takenOn: null, uploadedAt: "2026-11-01T00:00:00Z", previousStudies: 0 }], orthoCases: null, referenceSets: [] };
const events: string[] = [], unexpected: string[] = [];
let resolveBody: ((value: unknown) => void) | undefined, jsonCalls = 0, created = 0, refreshes = 0, posts = 0, passiveEpoch = 0;
let early: { passiveEpoch: number; created: number; marker: string | null } | null = null;
const originalKey = "aqlan.ceph-create.pending:synthetic-a:801";
window.fetch = async (input, init) => {
  const url = String(input), method = init?.method ?? "GET";
  if (method === "GET" && url === "/api/patients/801/ceph?create=1") return { ok: true, status: 200, json: async () => choices } as Response;
  if (method === "POST" && url === "/api/patients/801/ceph") {
    posts++;
    const body = new Promise<unknown>(resolve => { resolveBody = resolve; });
    // Abort is deliberately ignored: current ownership must protect settlement.
    return { ok: true, status: 201, json: () => { jsonCalls++; return body; } } as Response;
  }
  unexpected.push(method + " " + url); throw new Error("Unallowlisted synthetic fetch");
};
let transition: (kind: "close" | "owner" | "unmount") => void = () => { throw new Error("not mounted"); };
const api = { retire: (kind: "close" | "owner" | "unmount") => transition(kind), snapshot: () => ({ events: [...events], unexpected: [...unexpected], jsonCalls, created, refreshes, posts, passiveEpoch, early, marker: sessionStorage.getItem(originalKey) }) };
export type CanonicalCephCommitSnapshot = ReturnType<typeof api.snapshot>;
declare global { interface Window { __canonicalCephCommit: typeof api } }
window.__canonicalCephCommit = api;
function Fixture() {
  const [state, setState] = useState({ visible: true, owner: "synthetic-a", mounted: true, epoch: 0 });
  useLayoutEffect(() => {
    transition = kind => startTransition(() => setState({ visible: kind !== "close", owner: kind === "owner" ? "synthetic-b" : "synthetic-a", mounted: kind !== "unmount", epoch: 1 }));
    return () => { transition = () => { throw new Error("fixture unmounted"); }; };
  }, []);
  useLayoutEffect(() => {
    if (state.epoch !== 1) return;
    events.push("commit:1");
    if (!resolveBody || jsonCalls !== 1) throw new Error("Response must already be awaiting its JSON body");
    events.push("release-body:1"); resolveBody({ id: 1001, duplicateWarning: null });
    void (async () => {
      for (let tick = 0; tick < 8; tick++) await Promise.resolve();
      early = { passiveEpoch, created, marker: sessionStorage.getItem(originalKey) };
      events.push("microtasks:1");
    })();
  }, [state.epoch]);
  useEffect(() => { passiveEpoch = state.epoch; events.push(`passive:${state.epoch}`); }, [state.epoch]);
  return <div id="canonical-commit-fixture">{state.mounted ? <CanonicalCephCreate patientId="801" ownerKey={state.owner} visible={state.visible} list={list}
    onCreated={() => { created++; events.push("created"); }} refreshStudies={() => { refreshes++; }} /> : null}</div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
