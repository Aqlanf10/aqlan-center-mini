/** Unmounted transport preparation. No default route, UI import, automatic
 * replay, or submission activation. Callers must supply a separately reviewed
 * endpoint and fresh canonical-session lookup, never a React session cache. */
import { freezeUnpaidCurrencyCommand, attemptUnpaidCurrencyCommand,
  type UnpaidCurrencyActor, type UnpaidCurrencyPreview } from './invoice-unpaid-currency-recovery';
import type { FinancialCommand } from './financial-command-journal';
import { FinancialRecoveryError } from './financial-command-journal';

export function unpaidCurrencyTransport(input: {
  endpoint: string;
  authenticate: () => Promise<UnpaidCurrencyActor | null>;
  fetch: typeof fetch;
}) {
  // Require a same-origin relative path so integration cannot accidentally
  // transmit a frozen financial command to a third-party URL.
  if (!/^\/(?!\/)[^\\\s#]*$/.test(input.endpoint)) throw new FinancialRecoveryError('invalid');
  return {
    async preview(): Promise<UnpaidCurrencyPreview> {
      const response = await input.fetch(input.endpoint, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new FinancialRecoveryError('invalid');
      const value = await response.json();
      if (!value || Object.keys(value).sort().join(',') !== 'actor,source,sourceCreatedAt'
        || !value.source || Object.keys(value.source).sort().join(',') !== 'currency,discountMinor,invoiceId,lines,patientId,sourceHash,totalMinor'
        || !value.actor || Object.keys(value.actor).sort().join(',') !== 'role,userId,username'
        || !Number.isSafeInteger(value.actor.userId) || value.actor.userId <= 0 || value.actor.role !== 'admin'
        || typeof value.actor.username !== 'string' || !value.actor.username || value.actor.username.length > 200
        || typeof value.sourceCreatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.sourceCreatedAt)) throw new FinancialRecoveryError('invalid');
      return value;
    },
    // The existing freezer validates the exact source and intent together and
    // binds actor/hash/timestamp. Never accept envelope fields as source facts.
    prepare: freezeUnpaidCurrencyCommand,
    attempt(command: FinancialCommand, patientId: number, actor: UnpaidCurrencyActor, revision: number) {
      return attemptUnpaidCurrencyCommand({ command, patientId, actor, revision, authenticate: input.authenticate,
        send: async (body, requestHash) => {
          const response = await input.fetch(input.endpoint, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-Unpaid-Currency-Request-Hash': requestHash }, body });
          // Even 400/403/409 may follow an earlier committed delivery. Only a
          // valid exact acknowledgement can retire the reserved journal entry.
          if (!response.ok) throw new FinancialRecoveryError('invalid');
          return response.json();
        },
      });
    },
  };
}
