const STATES = new Set(['not_run', 'unchanged', 'changed']);
const SEQUENCE_STATES = new Set(['not_run', 'unchanged', 'advanced', 'regressed']);
const OUTCOMES = new Set(['not_run', 'duplicate_constraint', 'other']);
const KEYS = ['version', 'databases', 'identityBefore', 'identityAfter', 'legacySha256', 'faultySha256', 'outcome', 'rows', 'registry', 'patientIdSequence', 'patientNumberSequence'] as const;

export type RetainedRollbackReport = {
  version: 'synthetic-rollback-v1'; databases: number; identityBefore: boolean; identityAfter: boolean;
  legacySha256: string | null; faultySha256: string | null;
  outcome: 'not_run' | 'duplicate_constraint' | 'other'; rows: 'not_run' | 'unchanged' | 'changed';
  registry: 'not_run' | 'unchanged' | 'changed';
  patientIdSequence: 'not_run' | 'unchanged' | 'advanced' | 'regressed';
  patientNumberSequence: 'not_run' | 'unchanged' | 'advanced' | 'regressed';
};

export function initialRetainedRollbackReport(): RetainedRollbackReport {
  return { version: 'synthetic-rollback-v1', databases: 0, identityBefore: false, identityAfter: false,
    legacySha256: null, faultySha256: null, outcome: 'not_run', rows: 'not_run', registry: 'not_run',
    patientIdSequence: 'not_run', patientNumberSequence: 'not_run' };
}

/** Fail closed: no free text, names, paths, URLs, SQL, credentials or extra fields. */
export function serializeRetainedRollbackReport(value: unknown, requireComplete = false): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid synthetic report.');
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  const digest = (v: unknown) => v === null || typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  if (keys.length !== KEYS.length || KEYS.some(k => !Object.hasOwn(object, k))
      || object.version !== 'synthetic-rollback-v1' || !Number.isInteger(object.databases)
      || (object.databases as number) < 0 || (object.databases as number) > 3
      || typeof object.identityBefore !== 'boolean' || typeof object.identityAfter !== 'boolean'
      || !digest(object.legacySha256) || !digest(object.faultySha256)
      || typeof object.outcome !== 'string' || !OUTCOMES.has(object.outcome)
      || typeof object.rows !== 'string' || !STATES.has(object.rows)
      || typeof object.registry !== 'string' || !STATES.has(object.registry)
      || typeof object.patientIdSequence !== 'string' || !SEQUENCE_STATES.has(object.patientIdSequence)
      || typeof object.patientNumberSequence !== 'string' || !SEQUENCE_STATES.has(object.patientNumberSequence)) {
    throw new Error('Invalid synthetic report.');
  }
  if (requireComplete && (object.databases !== 3 || !object.identityBefore || !object.identityAfter
      || object.legacySha256 === null || object.faultySha256 === null || object.outcome === 'not_run'
      || object.rows === 'not_run' || object.registry === 'not_run'
      || object.patientIdSequence === 'not_run' || object.patientNumberSequence === 'not_run')) {
    throw new Error('Incomplete synthetic report.');
  }
  return JSON.stringify(Object.fromEntries(KEYS.map(key => [key, object[key]]))) + '\n';
}

export function syntheticSequenceState(before: bigint, after: bigint): 'unchanged' | 'advanced' | 'regressed' {
  return after === before ? 'unchanged' : after > before ? 'advanced' : 'regressed';
}
