/** Limit failure diagnostics to fixed synthetic fixture labels and PostgreSQL
 * activity categories. Never include SQL, connection strings, or arbitrary
 * application names from an unexpected backend. Preserve one entry per row. */
export interface BackendActivity {
  pid: number;
  state: string | null;
  backend_type: string | null;
  application_name: string | null;
  wait_event_type: string | null;
}

const states = new Set(["active", "idle", "idle in transaction", "idle in transaction (aborted)", "fastpath function call", "disabled"]);
const backendTypes = new Set(["client backend", "autovacuum worker", "autovacuum launcher", "background worker", "parallel worker"]);
const applications = new Set(["synthetic-fk-direct", "synthetic-fk-pool", "aqlan-center-mini"]);
const waitTypes = new Set(["Activity", "BufferPin", "Client", "Extension", "InjectionPoint", "IO", "IPC", "Lock", "LWLock", "Timeout"]);

function category(value: string | null, allowed: Set<string>): string | null {
  return value === null ? null : allowed.has(value) ? value : "other";
}

export function safeFkBackendActivity(rows: BackendActivity[]) {
  return rows.map(row => ({
    pid: Number.isSafeInteger(row.pid) && row.pid > 0 ? row.pid : null,
    state: category(row.state, states),
    backendType: category(row.backend_type, backendTypes),
    application: category(row.application_name, applications),
    waitType: category(row.wait_event_type, waitTypes),
  }));
}
