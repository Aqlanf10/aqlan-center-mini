import { validPrescriptionCommandKey } from "./prescription-command";
export type PendingPrescriptionCommand = { version: 1; key: string; digest: string; prescribingDoctorPartyId: number };
export interface CommandStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export const prescriptionCommandStorageKey = (username: string, patientId: number, visitId: number | null) => `rx-issuance:v1:${JSON.stringify([username, patientId, visitId])}`;
/** No medication, diagnosis, instructions, patient name or signed token is stored.
 * Missing receipt is not proof of rollback; only an explicit user decision may
 * discard this local reference. Server receipts are never deleted. */
export function readPrescriptionCommand(storage: CommandStorage, scope: string): PendingPrescriptionCommand | null {
  const raw = storage.getItem(scope);
  if (raw === null) return null;
  let entry: PendingPrescriptionCommand;
  try { entry = JSON.parse(raw); } catch { throw new Error("تعذر قراءة مفتاح الإصدار السابق؛ راجع السجل قبل بدء وصفة جديدة."); }
  if (entry?.version !== 1 || !validPrescriptionCommandKey(entry.key) || !/^[a-f0-9]{64}$/.test(entry.digest) || !Number.isSafeInteger(entry.prescribingDoctorPartyId) || entry.prescribingDoctorPartyId <= 0)
    throw new Error("مفتاح الإصدار السابق غير صالح؛ راجع السجل قبل بدء وصفة جديدة.");
  return entry;
}
export function getOrCreatePrescriptionCommand(storage: CommandStorage, scope: string, digest: string, prescribingDoctorPartyId: number, createKey: () => string): PendingPrescriptionCommand {
  const previous = readPrescriptionCommand(storage, scope);
  if (previous) {
    if (previous.digest !== digest || previous.prescribingDoctorPartyId !== prescribingDoctorPartyId) throw new Error("يوجد إصدار سابق لهذا السياق بمحتوى مختلف. تحقق من نتيجته ومن السجل قبل بدء وصفة جديدة.");
    return previous;
  }
  const entry: PendingPrescriptionCommand = { version: 1, key: createKey(), digest, prescribingDoctorPartyId };
  if (!validPrescriptionCommandKey(entry.key)) throw new Error("تعذر إنشاء مفتاح إصدار آمن.");
  storage.setItem(scope, JSON.stringify(entry)); // Fail closed if durable tab storage is unavailable.
  if (readPrescriptionCommand(storage, scope)?.key !== entry.key) throw new Error("تعذر تثبيت مفتاح الإصدار؛ لم تُرسل الوصفة.");
  return entry;
}

export type PrescriptionOperation = { generation: number; scope: string };
/** Synchronous latch survives React state batching. Owner retirement fences both
 * deferred hashing/network work and UI/print effects, not merely response text. */
export function createPrescriptionOperationFence() {
  let scope: string | null = null, generation = 0, busy = false;
  return {
    setScope(next: string | null) { if (next !== scope) { scope = next; generation += 1; busy = false; } },
    start(): PrescriptionOperation | null { if (!scope || busy) return null; busy = true; return { scope, generation }; },
    current(operation: PrescriptionOperation) { return operation.scope === scope && operation.generation === generation; },
    finish(operation: PrescriptionOperation) { if (operation.scope === scope && operation.generation === generation) busy = false; },
    isBusy() { return busy; },
    retire() { scope = null; generation += 1; busy = false; },
  };
}
