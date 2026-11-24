import { isNumberingRequestId, type NumberingSettingsTransport, type SettingsNumberingCurrent, type SettingsNumberingRead } from '../patient-numbering-settings-contract';
import type { AppliedNumbering } from '../patient-numbering-command';
import type { NumberingSaveDraft, NumberingSaveTicket } from '../../components/settings/patient-numbering-save-model';

type Disposition = { ok: true; state: 'open' | 'expired' | 'committed' | 'retired' } | { ok: false; reason: string };
/** This transport must bind to one authorized owner/target session and use
 * fresh reads; a verified new scope requires a new object. The presenter
 * cannot grant authority, supply credentials, or mount an HTTP route. */
export interface OwnerNumberingPort extends NumberingSettingsTransport {
  readDisposition(requestId: string): Promise<Disposition>;
  retireExpired(requestId: string): Promise<Disposition>;
}
type Work = { active: SettingsNumberingCurrent; draft: NumberingSaveDraft };
type Review = Work & { ticket: NumberingSaveTicket };
type EditingNotice = 'none' | 'saved' | 'invalid' | 'repreview' | 'preview-failed' | 'retired';
export type EditorState =
  | { kind: 'unavailable' }
  | { kind: 'loading' }
  | { kind: 'read-failed' }
  | (Work & { kind: 'editing'; notice: EditingNotice })
  | (Work & { kind: 'previewing' })
  | (Review & { kind: 'review' | 'saving' })
  | { kind: 'uncertain'; active: SettingsNumberingCurrent | null; checking: boolean; canRetire: boolean };

type ReceiptIntent = Readonly<Pick<NumberingSaveTicket, 'prefix' | 'next' | 'preview' | 'expectedRevision' | 'requestId'>>;
type PendingAttempt = { readonly intent: ReceiptIntent; appliedRevision?: string };
type PortScope = {
  lease: { key: symbol; invalidate: () => void } | null;
  attempt: PendingAttempt | null;
  lastReadId: string | null;
};
// One active presenter per transport, CAS on the attempted operation object.
// The scope retains no preview token, reasons, draft or credentials.
const scopes = new WeakMap<OwnerNumberingPort, PortScope>();
const hidden: EditorState = { kind: 'unavailable' };
const emptyDraft = (active: SettingsNumberingCurrent): NumberingSaveDraft => ({ prefix: active.prefix, next: '', reason: '' });
const filled = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const activeOk = (active: SettingsNumberingCurrent | undefined): active is SettingsNumberingCurrent =>
  !!active && filled(active.prefix) && filled(active.revision) && (active.next === null || filled(active.next));
const ticketOk = (ticket: NumberingSaveTicket | undefined): ticket is NumberingSaveTicket =>
  !!ticket && isNumberingRequestId(ticket.requestId) && filled(ticket.previewToken) && filled(ticket.expectedRevision)
  && filled(ticket.prefix) && filled(ticket.next) && filled(ticket.reason) && filled(ticket.preview);
const authorityLost = (reason: string) => ['owner-required', 'owner-numbering-not-activated',
  'session-required', 'preview-authority-changed'].includes(reason);
const retryWithPreview = (reason: string) => ['invalid-input', 'stale-preview', 'would-reuse-or-rewind'].includes(reason);
const staleWithoutWrite = (reason: string) => ['stale-preview', 'would-reuse-or-rewind'].includes(reason);
const sameReceiptIntent = (value: AppliedNumbering | undefined, t: ReceiptIntent): value is AppliedNumbering =>
  !!value && value.prefix === t.prefix && value.next === t.next && value.preview === t.preview
  && filled(value.revision) && value.revision !== t.expectedRevision;
export const completeNumberingDraft = (draft: NumberingSaveDraft) =>
  filled(draft.prefix) && filled(draft.next) && filled(draft.reason);
function usable(port: OwnerNumberingPort | null): port is OwnerNumberingPort {
  return !!port && ['read', 'preview', 'save', 'readDisposition', 'retireExpired']
    .every(key => typeof port[key as keyof OwnerNumberingPort] === 'function');
}

export function createNumberingEditor(candidate: OwnerNumberingPort | null) {
  const port = usable(candidate) ? candidate : null;
  const scope: PortScope = (port && scopes.get(port)) || { lease: null, attempt: null, lastReadId: null };
  if (port) scopes.set(port, scope);
  const key = Symbol('numbering-presenter');
  let state: EditorState = hidden, generation = 0, displaced = false;
  const listeners = new Set<() => void>();
  const publish = (value: EditorState) => { state = value; for (const notice of listeners) notice(); };
  const editing = (active: SettingsNumberingCurrent, notice: EditingNotice, draft = emptyDraft(active)) =>
    publish({ kind: 'editing', active, draft, notice });
  const uncertain = (active: SettingsNumberingCurrent | null, checking = false, canRetire = false) =>
    publish({ kind: 'uncertain', active, checking, canRetire });
  const owns = () => !displaced && scope.lease?.key === key;
  const allowed = (id: number, attempt?: PendingAttempt) =>
    owns() && id === generation && (!attempt || scope.attempt === attempt);
  const stop = () => {
    ++generation;
    if (scope.lease?.key === key) scope.lease = null;
    publish(hidden); // Never clear an outstanding attempt on unmount/authority loss.
  };
  function claim() {
    if (displaced || !port) return false;
    if (owns()) return true;
    const previous = scope.lease;
    scope.lease = { key, invalidate: () => { displaced = true; ++generation; publish(hidden); } };
    previous?.invalidate();
    return owns();
  }
  function applyRead(reply: SettingsNumberingRead | undefined, attempt: PendingAttempt | null, retired = false) {
    if (!reply?.ok || !activeOk(reply.current) || !filled(reply.readId) || reply.readId === scope.lastReadId) return false;
    if (attempt && scope.attempt !== attempt) return false;
    const receipt = reply.receipt;
    if (!attempt || retired) {
      if (receipt !== null) return false;
    } else if (!receipt || receipt.requestId !== attempt.intent.requestId ||
      !sameReceiptIntent(receipt.value, attempt.intent) ||
      (attempt.appliedRevision !== undefined && receipt.value.revision !== attempt.appliedRevision)) return false;
    if (attempt) scope.attempt = null;
    scope.lastReadId = reply.readId;
    editing(reply.current, retired ? 'retired' : attempt ? 'saved' : 'none');
    return true;
  }
  async function read() {
    if (!port || (state.kind !== 'unavailable' && state.kind !== 'read-failed') || !claim()) return;
    const id = ++generation;
    publish({ kind: 'loading' });
    if (!allowed(id)) return;
    const attempt = scope.attempt;
    if (attempt) { await recover(null, id, attempt); return; }
    try {
      const response = await port.read(null);
      if (!allowed(id)) return;
      if (response && !response.ok && authorityLost(response.reason)) { stop(); return; }
      if (applyRead(response, null)) return;
    } catch { if (!allowed(id)) return; }
    publish({ kind: 'read-failed' });
  }
  async function preview() {
    if (!port || !owns() || state.kind !== 'editing' || !completeNumberingDraft(state.draft)) return;
    const { active, draft } = state, id = ++generation;
    if (scope.attempt) { uncertain(active); return; }
    publish({ kind: 'previewing', active, draft });
    if (!allowed(id)) return;
    try {
      const reply = await port.preview(draft);
      if (!allowed(id)) return;
      if (reply && !reply.ok && authorityLost(reply.reason)) { stop(); return; }
      if (reply?.ok && ticketOk(reply.ticket) && reply.ticket.reason === draft.reason.trim()) {
        const { prefix, next, reason, preview, expectedRevision, requestId, previewToken } = reply.ticket;
        publish({ kind: 'review', active, draft, ticket: Object.freeze({ prefix, next, reason, preview, expectedRevision, requestId, previewToken }) });
        return;
      }
      editing(active, reply && !reply.ok && retryWithPreview(reply.reason) ?
        (reply.reason === 'invalid-input' ? 'invalid' : 'repreview') : 'preview-failed', draft);
      return;
    } catch { if (!allowed(id)) return; }
    editing(active, 'preview-failed', draft);
  }
  async function refreshRetired(active: SettingsNumberingCurrent | null, id: number, attempt: PendingAttempt) {
    if (!port || !allowed(id, attempt)) return;
    // A response which already confirmed an applied revision is never resolved
    // by retirement. Contradictory evidence keeps the gate closed.
    if (attempt.appliedRevision !== undefined) { uncertain(active); return; }
    const fresh = await port.read(null);
    if (!allowed(id, attempt)) return;
    if (fresh && !fresh.ok && authorityLost(fresh.reason)) { stop(); return; }
    if (!applyRead(fresh, attempt, true)) uncertain(active);
  }
  async function recover(active: SettingsNumberingCurrent | null, id: number, attempt: PendingAttempt) {
    if (!port || !allowed(id, attempt)) return;
    try {
      // A dropped connection or ordinary absence cannot prove no save occurred.
      // Checked terminal dispositions are available only from the donor ledger.
      const reply = await port.read(attempt.intent.requestId);
      if (!allowed(id, attempt)) return;
      if (reply && !reply.ok && authorityLost(reply.reason)) { stop(); return; }
      if (applyRead(reply, attempt)) return;
      const disposition = await port.readDisposition(attempt.intent.requestId);
      if (!allowed(id, attempt)) return;
      if (disposition && !disposition.ok && authorityLost(disposition.reason)) { stop(); return; }
      if (disposition?.ok && disposition.state === 'retired') { await refreshRetired(active, id, attempt); return; }
      uncertain(active, false, disposition?.ok && disposition.state === 'expired' && attempt.appliedRevision === undefined);
      return;
    } catch { if (!allowed(id, attempt)) return; }
    uncertain(active);
  }
  async function confirm(reviewed: NumberingSaveTicket) {
    if (!port || !owns() || state.kind !== 'review' || state.ticket !== reviewed) return;
    const { active, draft, ticket } = state, id = ++generation;
    if (scope.attempt) { uncertain(active); return; }
    const { prefix, next, preview, expectedRevision, requestId } = ticket;
    const attempt: PendingAttempt = { intent: Object.freeze({ prefix, next, preview, expectedRevision, requestId }) };
    scope.attempt = attempt;
    publish({ active, draft, ticket, kind: 'saving' });
    if (!allowed(id, attempt)) return;
    try {
      const reply = await port.save(ticket);
      if (!allowed(id, attempt)) return;
      if (reply && !reply.ok && authorityLost(reply.reason)) { stop(); return; }
      if (reply && !reply.ok && staleWithoutWrite(reply.reason)) {
        // These certified server refusals have not accepted this exact save.
        scope.attempt = null; editing(active, 'repreview', draft); return;
      }
      if (reply?.ok && sameReceiptIntent(reply.value, ticket)) {
        attempt.appliedRevision = reply.value.revision;
        await recover(active, id, attempt); return;
      }
    } catch { if (!allowed(id, attempt)) return; }
    uncertain(active);
  }
  async function retire() {
    if (!port || !owns() || state.kind !== 'uncertain' || state.checking || !state.canRetire || !scope.attempt) return;
    const { active } = state, id = ++generation, attempt = scope.attempt;
    uncertain(active, true);
    if (!allowed(id, attempt)) return;
    try {
      const retired = await port.retireExpired(attempt.intent.requestId);
      if (!allowed(id, attempt)) return;
      if (retired && !retired.ok && authorityLost(retired.reason)) { stop(); return; }
      if (!retired?.ok || retired.state !== 'retired') { uncertain(active); return; }
      // Verify again before clearing: a retire response cannot stand in for a
      // fresh disposition and active state confirmation. No client clock.
      const verified = await port.readDisposition(attempt.intent.requestId);
      if (!allowed(id, attempt)) return;
      if (verified && !verified.ok && authorityLost(verified.reason)) { stop(); return; }
      if (verified?.ok && verified.state === 'retired') { await refreshRetired(active, id, attempt); return; }
    } catch { if (!allowed(id, attempt)) return; }
    uncertain(active);
  }
  return {
    subscribe: (notice: () => void) => { listeners.add(notice); return () => { listeners.delete(notice); }; },
    snapshot: () => state, serverSnapshot: () => hidden, read, preview, confirm, stop, retire,
    edit: (key: keyof NumberingSaveDraft, value: string) => {
      if (owns() && state.kind === 'editing') editing(state.active, 'none', { ...state.draft, [key]: value });
    },
    discard: () => {
      if (!owns()) return;
      if (state.kind === 'review') editing(state.active, 'none', state.draft);
      else if (state.kind === 'editing') editing(state.active, 'none');
    },
    verify: async () => {
      if (!owns() || state.kind !== 'uncertain' || state.checking) return;
      const attempt = scope.attempt;
      if (!attempt) { stop(); await read(); return; }
      const { active } = state, id = ++generation;
      uncertain(active, true);
      await recover(active, id, attempt);
    },
  };
}
