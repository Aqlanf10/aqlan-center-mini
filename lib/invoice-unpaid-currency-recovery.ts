/** U0 recovery candidate. Not mounted or activated. The server remains the only
 * eligibility authority; a stored preview is solely acknowledgement evidence. */
import { evaluateWrongCurrencyAmounts, type CurrencyCorrectionSource } from './invoice-currency-intent';
import { freezeUnpaidCurrencyRequest, restoreUnpaidCurrencyRequest, parseUnpaidCurrencyAcknowledgement, UNPAID_CURRENCY_KIND, type UnpaidCurrencyRequest } from './invoice-unpaid-currency-contract';
import { readFinancialJournal, reserveFinancialCommand, acknowledgeFinancialCommand, FinancialRecoveryError, type FinancialCommand } from './financial-command-journal';

export interface UnpaidCurrencyActor { userId: number; username: string; role: 'admin' }
interface FrozenEvidence { version: 1; actor: UnpaidCurrencyActor; source: CurrencyCorrectionSource; sourceCreatedAt: string; body: string; requestHash: string }
export interface UnpaidCurrencyPreview { actor: UnpaidCurrencyActor; source: CurrencyCorrectionSource; sourceCreatedAt: string }
const sameActor = (a: UnpaidCurrencyActor, b: UnpaidCurrencyActor) => a.userId === b.userId && a.username === b.username && a.role === b.role;
function actorValid(a: UnpaidCurrencyActor) {
  if (!a || Object.keys(a).sort().join(',') !== 'role,userId,username' || !Number.isSafeInteger(a.userId) || a.userId <= 0 || typeof a.username !== 'string' || !a.username || a.username.length > 200 || a.role !== 'admin') throw new FinancialRecoveryError('invalid');
}
// Deliberately matches debt-source-proof canonicalisation without node:crypto or
// a server-only import in the client graph. Golden parity is regression-tested.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export async function unpaidCurrencyRequestHash(request: UnpaidCurrencyRequest, actor: UnpaidCurrencyActor): Promise<string> {
  actorValid(actor);
  const value = JSON.stringify(canonical({ purpose: 'invoice-unpaid-currency-command-v1', request, actor }));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2, '0')).join('');
}
function validateEvidence(e: FrozenEvidence, patientId: number, actor: UnpaidCurrencyActor) {
  actorValid(actor); actorValid(e.actor);
  if (Object.keys(e).sort().join(',') !== 'actor,body,requestHash,source,sourceCreatedAt,version' || e.version !== 1 || !sameActor(actor, e.actor)
    || typeof e.sourceCreatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(e.sourceCreatedAt)) throw new FinancialRecoveryError('invalid');
  const request = restoreUnpaidCurrencyRequest(e.body, patientId);
  const amounts = evaluateWrongCurrencyAmounts(e.source, request.intent);
  if (e.source.invoiceId !== request.invoiceId || e.source.patientId !== request.patientId || e.source.sourceHash !== request.expectedSourceHash) throw new FinancialRecoveryError('invalid');
  return { request, amounts };
}
export async function freezeUnpaidCurrencyCommand(value: unknown, preview: UnpaidCurrencyPreview): Promise<FinancialCommand> {
  const body = freezeUnpaidCurrencyRequest(value);
  const request = restoreUnpaidCurrencyRequest(body, preview.source.patientId);
  const evidence: FrozenEvidence = { version: 1, actor: preview.actor, source: preview.source, sourceCreatedAt: preview.sourceCreatedAt, body, requestHash: await unpaidCurrencyRequestHash(request, preview.actor) };
  validateEvidence(evidence, request.patientId, preview.actor);
  const original = JSON.stringify(evidence);
  return { kind: UNPAID_CURRENCY_KIND, key: request.idempotencyKey, original, payload: original };
}
export async function restoreUnpaidCurrencyCommand(command: FinancialCommand, patientId: number, actor: UnpaidCurrencyActor) {
  if (command.kind !== UNPAID_CURRENCY_KIND || command.payload !== command.original) throw new FinancialRecoveryError('invalid');
  const evidence: FrozenEvidence = JSON.parse(command.original);
  const { request, amounts } = validateEvidence(evidence, patientId, actor);
  if (JSON.stringify(evidence) !== command.original || command.key !== request.idempotencyKey || evidence.requestHash !== await unpaidCurrencyRequestHash(request, actor)) throw new FinancialRecoveryError('invalid');
  return { evidence, request, amounts };
}
export type UnpaidCurrencyAttempt = { state: 'acknowledged' } | { state: 'unresolved'; reason: 'session' | 'conflict' | 'unconfirmed' };
/** authenticate must consult the canonical server session afresh, not the React
 * session cache. send must use the separately gated U0 endpoint. Never accepts
 * a replacement preview, new key, or changed body during replay. */
export async function attemptUnpaidCurrencyCommand(input: {
  command: FinancialCommand; patientId: number; actor: UnpaidCurrencyActor; revision: number;
  authenticate: () => Promise<UnpaidCurrencyActor | null>;
  send: (body: string, requestHash: string) => Promise<unknown>;
}): Promise<UnpaidCurrencyAttempt> {
  const scope = { actor: input.actor.username, patientId: input.patientId };
  try {
    const restored = await restoreUnpaidCurrencyCommand(input.command, input.patientId, input.actor);
    const current = await input.authenticate();
    if (!current || !sameActor(current, input.actor)) return { state: 'unresolved', reason: 'session' };
    const saved = await reserveFinancialCommand(scope, input.revision, input.command);
    if (saved.command?.original !== input.command.original || saved.command.kind !== UNPAID_CURRENCY_KIND || saved.command.key !== input.command.key) return { state: 'unresolved', reason: 'conflict' };
    // A second check after durable storage closes the ordinary session-switch
    // window. The backend still independently validates session in its transaction.
    const beforeSend = await input.authenticate();
    if (!beforeSend || !sameActor(beforeSend, input.actor)) return { state: 'unresolved', reason: 'session' };
    const response = await input.send(restored.evidence.body, restored.evidence.requestHash);
    if (!response || typeof response !== 'object' || Array.isArray(response)
      || Object.keys(response).sort().join(',') !== 'acknowledgement,replayed'
      || typeof (response as { replayed: unknown }).replayed !== 'boolean') throw new FinancialRecoveryError('invalid');
    const ack = parseUnpaidCurrencyAcknowledgement((response as { acknowledgement: unknown }).acknowledgement, {
      request: restored.request, requestHash: restored.evidence.requestHash, actorUserId: input.actor.userId, createdBy: input.actor.username,
    });
    if (ack.sourcePrincipalMinor !== restored.amounts.sourceNetMinor || ack.targetPrincipalMinor !== restored.amounts.targetNetMinor || ack.original.createdAt !== restored.evidence.sourceCreatedAt) throw new FinancialRecoveryError('invalid');
    const afterSend = await input.authenticate();
    if (!afterSend || !sameActor(afterSend, input.actor)) return { state: 'unresolved', reason: 'session' };
    await acknowledgeFinancialCommand(scope, input.command);
    return { state: 'acknowledged' };
  } catch { return { state: 'unresolved', reason: 'unconfirmed' }; }
}
export async function readUnpaidCurrencyRecovery(patientId: number, actor: UnpaidCurrencyActor) {
  actorValid(actor);
  const journal = await readFinancialJournal({ actor: actor.username, patientId });
  // Do not parse or upgrade a pending v1/other financial operation.
  if (journal.command?.kind !== UNPAID_CURRENCY_KIND) return { journal, recovery: null };
  return { journal, recovery: await restoreUnpaidCurrencyCommand(journal.command, patientId, actor) };
}
