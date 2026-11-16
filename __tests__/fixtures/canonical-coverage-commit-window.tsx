import { StrictMode, startTransition, useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionProvider } from "../../components/SessionProvider";
import { OrthoFollowupCoveragePanel } from "../../components/OrthoFollowupCoveragePanel";
import { makeCanonicalCoverageDraft } from "../../lib/canonical-ortho-coverage-draft";
import { readFinancialJournal } from "../../lib/financial-command-journal";
import type { FollowupCoverageCommand } from "../../lib/ortho-followup-coverage";

const grants = ["finance.agreements.manage", "finance.invoices.view", "clinical.plans.view", "clinical.ortho.view"];
const originalScope = { actor: "synthetic-coverage-a", patientId: 801 };
const context = { projection: "ortho-followup-coverage-editor", patientId: 801, orthoCaseId: 802,
  enabled: true, canEdit: true, current: null, applicable: false, sources: [{ patientId: 801, orthoCaseId: 802,
    clinicalCaseId: 803, planId: 804, planItemId: 805, invoiceId: 806, fingerprint: "a".repeat(64), invoiceNumber: "SYN-806", serviceName: "Synthetic coverage" }] };
const events: string[] = [], unexpected: string[] = [];
let resolveBody: ((value: unknown) => void) | undefined, command: FollowupCoverageCommand | undefined;
let posts = 0, jsonCalls = 0, saved = 0, acknowledgments = 0, passiveEpoch = 0;
window.addEventListener("synthetic-coverage-acknowledgment", () => { acknowledgments++; });
let early: { passiveEpoch: number; saved: number; acknowledgments: number } | null = null;
window.fetch = async (input, init) => {
  const url = String(input), method = init?.method ?? "GET";
  if (method === "GET" && url === "/api/ortho/802/followup-coverage?patientId=801&edit=1") return { ok: true, status: 200, redirected: false, json: async () => context } as Response;
  if (method === "POST" && url === "/api/ortho/802/followup-coverage?patientId=801") {
    posts++; command = JSON.parse(String(init?.body)) as FollowupCoverageCommand;
    const body = new Promise<unknown>(resolve => { resolveBody = resolve; });
    // Ignore abort deliberately; ownership, not network cancellation, is the fence.
    return { ok: true, status: 200, redirected: false, json: () => { jsonCalls++; return body; } } as Response;
  }
  unexpected.push(method + " " + url); throw new Error("Unallowlisted synthetic fetch");
};
type Retirement = "owner" | "unmount" | "permission" | "refresh";
let transition: (kind: Retirement) => void = () => { throw new Error("not mounted"); };
const api = { retire: (kind: Retirement) => transition(kind), snapshot: async () => ({ events: [...events], unexpected: [...unexpected], posts, jsonCalls, saved, acknowledgments, passiveEpoch, early, journal: await readFinancialJournal(originalScope) }) };
export type CanonicalCoverageCommitSnapshot = Awaited<ReturnType<typeof api.snapshot>>;
declare global { interface Window { __canonicalCoverageCommit: typeof api } }
window.__canonicalCoverageCommit = api;
function Fixture() {
  const [state, setState] = useState({ owner: originalScope.actor, mounted: true, allowed: true, epoch: 0, mode: "refresh" as Retirement });
  const [draftOwner] = useState(() => makeCanonicalCoverageDraft({ authorized: () => true, deny: () => undefined }));
  useLayoutEffect(() => {
    transition = kind => startTransition(() => setState({ owner: kind === "owner" ? "synthetic-coverage-b" : originalScope.actor,
      mounted: kind !== "unmount", allowed: kind !== "permission", epoch: 1, mode: kind }));
    return () => { transition = () => { throw new Error("fixture unmounted"); }; };
  }, []);
  useLayoutEffect(() => {
    if (state.epoch !== 1 || state.mode === "refresh") return;
    events.push("commit:1");
    if (!resolveBody || !command || jsonCalls !== 1) throw new Error("POST must already await its JSON body");
    resolveBody({ ok: true, revision: { id: "1", version: 1, supersedesRevisionId: command.expectedRevisionId,
      source: command.source, sourceFingerprint: command.expectedSourceFingerprint, decision: command.decision, reason: command.reason,
      createdAt: "2026-11-01T00:00:00Z", createdBy: originalScope.actor, commandId: command.commandId } });
    void (async () => { for (let tick = 0; tick < 8; tick++) await Promise.resolve(); early = { passiveEpoch, saved, acknowledgments }; events.push("microtasks:1"); })();
  }, [state.epoch, state.mode]);
  useEffect(() => { passiveEpoch = state.epoch; events.push(`passive:${state.epoch}`); }, [state.epoch]);
  return <SessionProvider key={`${state.owner}:${state.allowed}`} value={{ username: state.owner, role: "doctor", canonical: true, patientScope: "own", capabilities: state.allowed ? grants : [] }}>
    {state.mounted ? <OrthoFollowupCoveragePanel key={state.epoch} canonical patientId={801} orthoCaseId={802} draftOwner={draftOwner} onSaved={() => { saved++; events.push("saved"); }} /> : null}
  </SessionProvider>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
