/** Never imported by the Next app. The private loopback bundle supplies this in-memory port. */
import { PatientNumberingSettingsSlot as DormantSlot } from "../../../components/settings/PatientNumberingSettingsSlot";
import type { NumberingSaveTicket } from "../../../components/settings/patient-numbering-save-model";
import type { OwnerNumberingPort } from "../../../lib/patients/numbering-owner-editor";
import type { SettingsNumberingReceipt } from "../../../lib/patient-numbering-settings-contract";
import { parseNumberingRequest, planPatientNumbering } from "../../../lib/patient-numbering-policy";

type TrialWindow = Window & { a1NumberingFixture: { saved: () => number; awaitingReadback: () => boolean } };

let current = { prefix: "P", next: "7000", revision: "1:P:P:7000:0:0:1" };
let prepared: NumberingSaveTicket | null = null;
let receipt: SettingsNumberingReceipt | null = null;
let releaseReadback: (() => void) | null = null;
let saves = 0;

(window as unknown as TrialWindow).a1NumberingFixture = {
  saved: () => saves,
  awaitingReadback: () => releaseReadback !== null,
};

const port: OwnerNumberingPort = {
  async read(requestId) {
    if (requestId === null) return { ok: true, current, readId: crypto.randomUUID(), receipt: null };
    if (receipt?.requestId !== requestId) return { ok: false, reason: "receipt-unresolved" };
    await new Promise<void>(resolve => { releaseReadback = resolve; });
    releaseReadback = null;
    return { ok: true, current, readId: crypto.randomUUID(), receipt };
  },
  async preview(draft) {
    const request = parseNumberingRequest(draft.prefix, draft.next);
    if (!request) return { ok: false, reason: "invalid-input" };
    const prior = request.prefix === "P" && current.prefix !== "P" ? 7000n : 0n;
    const revision = request.prefix === "P" ? current.revision : "1:P:M:1:0:0:1";
    const plan = planPatientNumbering(request, {
      prefix: request.prefix, allocatedThrough: prior, historicalThrough: prior,
      pendingNext: prior > 0n ? null : request.prefix === "P" ? 7000n : null,
      historyComplete: true, revision,
    }, revision);
    if (!plan.ok) return plan;
    prepared = { ...plan, reason: draft.reason.trim(), requestId: crypto.randomUUID(), previewToken: "synthetic-not-a-credential" };
    // Match the actual transport's preview shape, not internal planning fields.
    const { prefix, next, preview, expectedRevision, reason, requestId, previewToken } = prepared;
    prepared = { prefix, next, preview, expectedRevision, reason, requestId, previewToken };
    return { ok: true, ticket: prepared };
  },
  async save(ticket) {
    const expected = prepared;
    if (!expected || receipt
      || (Object.keys(expected) as (keyof NumberingSaveTicket)[]).some(key => ticket[key] !== expected[key])) {
      return { ok: false, reason: "stale-preview" };
    }
    saves++;
    const { prefix, next, preview } = ticket;
    const value = { prefix, next, preview, revision: `2:${prefix}:${prefix}:${next}:0:0:1` };
    receipt = { requestId: ticket.requestId, value };
    current = { prefix, next, revision: value.revision };
    return { ok: true, value, replay: false };
  },
  async readDisposition(requestId) {
    return receipt?.requestId === requestId ? { ok: true, state: "committed" } : { ok: false, reason: "receipt-unresolved" };
  },
  async retireExpired() { return { ok: false, reason: "receipt-unresolved" }; },
};

export function PatientNumberingSettingsSlot() {
  return <>
    <DormantSlot port={port} />
    <button type="button" onClick={() => releaseReadback?.()}>تسليم قراءة الاختبار الاصطناعية</button>
  </>;
}
