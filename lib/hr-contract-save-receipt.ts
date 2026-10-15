import type { HrContractKind, HrContractStatus } from "./hr-contracts-attendance-shared";

/** One runtime deadline covers response headers and complete JSON consumption. */
export const CONTRACT_SAVE_RECEIPT_TIMEOUT_MS = 12_000;

/** Keep the complete native read within one deadline. The read callback must
 * have no settlement/UI effects: after timeout a late body cannot report success. */
export async function readBoundedContractSaveReceipt<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("انتهت مهلة استلام إيصال حفظ العقد."));
    }, CONTRACT_SAVE_RECEIPT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface ContractSavePayload {
  expectedUpdatedAt?: string;
  staffId: string;
  title: string;
  templateKind: HrContractKind;
  compensationKind: "salary" | "commission" | "salary_commission";
  startDate: string;
  endDate: string | null;
  probationEndDate: string | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  baseSalaryMinor: number | null;
  commissionRatePercent: number | null;
  doctorPartyId: number | null;
  termsPayload: Record<string, unknown>;
}

/** Memory-only UI intent, not a backend idempotency or replay key. */
export interface PendingContractSave {
  token: string;
  owner: string;
  phase: "awaiting" | "uncertain";
  method: "POST" | "PATCH";
  path: string;
  expectedId: number | null;
  expectedContractNumber: string | null;
  expectedStatus: HrContractStatus;
  expectedCreator: string;
  payload: ContractSavePayload;
}

/** Identity is a committed HR-page generation, not merely a username. */
export interface ContractSaveAdmissionView {
  readonly owner: string;
  readonly admin: boolean;
  readonly contractsVisible: boolean;
}
export interface ContractSaveAdmissionLease {
  readonly view: ContractSaveAdmissionView;
  canAdmit: () => boolean;
  detach: () => void;
}

/** New mutations require a live, committed panel. Settlement deliberately does
 * not use this gate: an already-dispatched owner's exact token may settle later. */
export function createContractSaveAdmissionGate() {
  let committed: ContractSaveAdmissionView | undefined;
  return {
    commit(view: ContractSaveAdmissionView) {
      committed = view;
      return () => { if (committed === view) committed = undefined; };
    },
    mount(view: ContractSaveAdmissionView): ContractSaveAdmissionLease {
      let mounted = true;
      return {
        view,
        canAdmit: () => mounted && committed === view && Boolean(view.owner) && view.admin && view.contractsVisible,
        detach: () => { mounted = false; },
      };
    },
  };
}

function matchesContractNumber(value: unknown, id: number, request: PendingContractSave): boolean {
  if (typeof value !== "string") return false;
  if (request.method === "PATCH") return Boolean(request.expectedContractNumber) && value === request.expectedContractNumber;
  // Mirrors the server SERIAL allocator's CTR-YYYYMM-id.padStart(4, "0").
  // The server's year/month is accepted; the browser never guesses its clock.
  const parts = /^CTR-([0-9]{4})(0[1-9]|1[0-2])-([0-9]+)$/.exec(value);
  return Boolean(parts && parts[3] === String(id).padStart(4, "0"));
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function snapshotContractSave(request: PendingContractSave): PendingContractSave {
  return freezeJson(JSON.parse(JSON.stringify(request)) as PendingContractSave);
}

function sameJson(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (Array.isArray(expected)) return Array.isArray(actual)
    && actual.length === expected.length && expected.every((value, index) => sameJson(actual[index], value));
  if (!expected || typeof expected !== "object" || Array.isArray(actual)
    || !actual || typeof actual !== "object") return false;
  const left = actual as Record<string, unknown>, right = expected as Record<string, unknown>;
  const keys = Object.keys(right);
  return Object.keys(left).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(left, key) && sameJson(left[key], right[key]));
}

/** The exact native mutation receipt must confirm this frozen intent. A list
 * lookup or matching title cannot establish which mutation created a row. */
export function confirmsContractSave(value: unknown, request: PendingContractSave): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>, payload = request.payload;
  if (!Number.isSafeInteger(receipt.id) || Number(receipt.id) <= 0
    || !Number.isSafeInteger(receipt.staffId) || Number(receipt.staffId) <= 0
    || !["draft", "under_review"].includes(request.expectedStatus)
    || (request.expectedId !== null && receipt.id !== request.expectedId)
    || receipt.staffId !== Number(payload.staffId)
    || receipt.title !== payload.title.trim()
    || receipt.status !== request.expectedStatus
    || receipt.createdBy !== request.expectedCreator
    || receipt.approvedAt !== null || receipt.approvedBy !== null
    || !matchesContractNumber(receipt.contractNumber, Number(receipt.id), request)
    || typeof receipt.updatedAt !== "string" || !Number.isFinite(Date.parse(receipt.updatedAt))) return false;
  const fields = ["templateKind", "compensationKind", "startDate", "endDate", "probationEndDate",
    "salaryCurrency", "salaryPeriod", "baseSalaryMinor", "commissionRatePercent", "doctorPartyId"] as const;
  return fields.every(key => receipt[key] === payload[key]) && sameJson(receipt.termsPayload, payload.termsPayload);
}
