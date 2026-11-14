import { isAdjustmentDate, ADJUSTMENT_DATE_ERROR } from "./ortho-adjustment-date";
import { parseAdjustmentInterval, ADJUSTMENT_INTERVAL_ERROR } from "./ortho-adjustment-interval";
import { IDEMPOTENCY_KEY_PATTERN, newIdempotencyKey } from "./idempotency-key";
import { parseAuxiliariesInput } from "./ortho-auxiliaries";

export type AdjustmentCommandScope = { patientId: number; caseId: number; authority: string };
export type AdjustmentCommandBody = { doneOn: string; upperWire: string; lowerWire: string;
  elastics: string; elasticNote: string; done: string; nextWeeks: number;
  /** Explicit removal only; absent means a blank wire keeps the current one. */
  upperWireAction?: "remove"; lowerWireAction?: "remove";
  /** 0132, optional. Absent: not recorded. [] is an explicit "none". auxiliaryOther only with "other". */
  auxiliaries?: string[]; auxiliaryOther?: string | null };
export type AdjustmentReceipt = { id: number; patientId: number; caseId: number; requestKey: string;
  visitId: number | null; attachedToToday: boolean };
export type AdjustmentCommand = { version: 1; scope: AdjustmentCommandScope; key: string;
  body: string; receipt: AdjustmentReceipt | null };
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export function adjustmentCommandStorageKey(scope: AdjustmentCommandScope) {
  return `ortho-adjustment:v1:${JSON.stringify([scope.patientId, scope.caseId, scope.authority])}`;
}
function validBody(body: unknown): body is string {
  if (typeof body !== "string" || body.length > 100_000) return false;
  try {
    const parsed = JSON.parse(body);
    const actions = (["lowerWireAction", "upperWireAction"] as const).filter((key) => Object.hasOwn(parsed ?? {}, key));
    // Commands stored before 0132 carry neither key and stay valid; a stored list must still be exact.
    const auxiliaryKeys = (["auxiliaries", "auxiliaryOther"] as const).filter((key) => Object.hasOwn(parsed ?? {}, key));
    if (auxiliaryKeys.length && (!Object.hasOwn(parsed, "auxiliaries") || !Array.isArray(parsed.auxiliaries)
      || !parseAuxiliariesInput(parsed).ok)) return false;
    return parsed && Object.keys(parsed).sort().join(",") === ["done", "doneOn", "elasticNote", "elastics", ...actions, ...auxiliaryKeys, "lowerWire", "nextWeeks", "upperWire"].sort().join(",")
      && actions.every((key) => parsed[key] === "remove" && parsed[key.replace("Action", "")].trim() === "")
      && ["doneOn", "upperWire", "lowerWire", "elastics", "elasticNote", "done"].every((key) => typeof parsed[key] === "string")
      && /^\d{4}-\d{2}-\d{2}$/.test(parsed.doneOn)
      && ["none", "class_ii", "class_iii", "vertical", "triangle", "cross"].includes(parsed.elastics)
      && Number.isInteger(parsed.nextWeeks) && parsed.nextWeeks >= 1 && parsed.nextWeeks <= 52;
  } catch { return false; }
}
export function isAdjustmentReceipt(value: unknown, command: AdjustmentCommand): value is AdjustmentReceipt {
  if (!value || typeof value !== "object") return false;
  const row = value as AdjustmentReceipt;
  return positive(row.id) && row.patientId === command.scope.patientId && row.caseId === command.scope.caseId
    && row.requestKey === command.key && (row.visitId === null || positive(row.visitId))
    && typeof row.attachedToToday === "boolean" && (!row.attachedToToday || row.visitId !== null);
}
/** Fail closed on corrupt/unavailable storage: never replace an unresolved request. */
export function readAdjustmentCommand(storage: StorageLike, scope: AdjustmentCommandScope): AdjustmentCommand | null {
  const raw = storage.getItem(adjustmentCommandStorageKey(scope));
  if (raw === null) return null;
  const command = JSON.parse(raw) as AdjustmentCommand;
  if (!command || command.version !== 1 || !command.scope || command.scope.patientId !== scope.patientId
    || command.scope.caseId !== scope.caseId || command.scope.authority !== scope.authority
    || typeof command.key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(command.key) || !validBody(command.body)
    || (command.receipt !== null && !isAdjustmentReceipt(command.receipt, command))) {
    throw new Error("تعذّر التحقق من طلب الشدّة المحفوظ. راجع السجل قبل تسجيل طلب جديد.");
  }
  return command;
}
/** New authoring admission only; never rewrite or reinterpret a recovered command. */
export function adjustmentNewCommandError(body: AdjustmentCommandBody): string | null {
  if (!isAdjustmentDate(body.doneOn)) return ADJUSTMENT_DATE_ERROR;
  if (typeof body.nextWeeks !== "number" || parseAdjustmentInterval(body.nextWeeks) === null) return ADJUSTMENT_INTERVAL_ERROR;
  const fields = [
    ["upperWire", 40, "السلك العلوي"], ["lowerWire", 40, "السلك السفلي"],
    ["elasticNote", 120, "وصف المطاطات"], ["done", 400, "ما نُفّذ في الشدّة"],
  ] as const;
  for (const arch of ["upper", "lower"] as const) {
    const action = body[`${arch}WireAction`];
    if (action !== undefined && action !== "remove") return "إجراء السلك غير صالح.";
    if (action === "remove" && typeof body[`${arch}Wire`] === "string" && body[`${arch}Wire`].trim()) return "اختر إزالة السلك أو تسجيل سلك، لا كليهما.";
  }
  if (Object.hasOwn(body, "auxiliaries") || Object.hasOwn(body, "auxiliaryOther")) {
    if (!Array.isArray(body.auxiliaries)) return "قائمة الأجهزة المساعدة غير صالحة؛ لم يبدأ الحفظ.";
    const auxiliaries = parseAuxiliariesInput(body);
    if (!auxiliaries.ok) return auxiliaries.message;
  }
  for (const [key, limit, label] of fields) {
    if (typeof body[key] !== "string") return "بيانات الشدّة النصية غير صالحة؛ لم يبدأ الحفظ.";
    if (body[key].trim().length > limit) {
      return `${label} يتجاوز ${limit} حرفًا. اختصره قبل الحفظ؛ لم يُحذف نصك ولم يُرسل جزء منه.`;
    }
  }
  return null;
}
export function createAdjustmentCommand(storage: StorageLike, scope: AdjustmentCommandScope, body: AdjustmentCommandBody): AdjustmentCommand {
  if (readAdjustmentCommand(storage, scope)) throw new Error("يوجد طلب شدّة محفوظ يجب مراجعته أولًا.");
  const inputError = adjustmentNewCommandError(body);
  if (inputError) throw new Error(inputError);
  if (!positive(scope.patientId) || !positive(scope.caseId) || !scope.authority || !validBody(JSON.stringify(body))) {
    throw new Error("بيانات الشدّة غير صالحة للحفظ.");
  }
  const command: AdjustmentCommand = { version: 1, scope: { ...scope }, key: newIdempotencyKey("ortho-adjust"), body: JSON.stringify(body), receipt: null };
  writeAdjustmentCommand(storage, command);
  return command;
}
export function writeAdjustmentCommand(storage: StorageLike, command: AdjustmentCommand) {
  const key = adjustmentCommandStorageKey(command.scope);
  const raw = JSON.stringify(command);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("تعذّر حفظ مفتاح الطلب بأمان؛ لم تبدأ محاولة جديدة.");
}
export function completeAdjustmentCommand(storage: StorageLike, command: AdjustmentCommand, receipt: unknown): AdjustmentCommand {
  if (!isAdjustmentReceipt(receipt, command)) throw new Error("تعذّر التحقق من مرجع الشدّة المحفوظة.");
  const completed = { ...command, receipt };
  writeAdjustmentCommand(storage, completed);
  return completed;
}
/** Only explicit new intent after a verified receipt may retire the tombstone. */
export function retireAdjustmentCommand(storage: StorageLike, command: AdjustmentCommand) {
  const current = readAdjustmentCommand(storage, command.scope);
  if (!current?.receipt || current.key !== command.key) throw new Error("يجب تأكيد نتيجة الشدّة السابقة أولًا.");
  storage.removeItem(adjustmentCommandStorageKey(command.scope));
  if (readAdjustmentCommand(storage, command.scope)) throw new Error("تعذّر بدء شدّة جديدة بأمان.");
}
/** Codes the server returns only after rolling back everything for this request: no receipt was written
 * for its key, so the key is unused and the frozen command may be dropped. Any other failure stays
 * uncertain and keeps the command for same-key reconciliation. */
export const DEFINITIVE_ADJUSTMENT_REFUSALS: readonly string[] = ["adjustment_visit_already_recorded"];
export function isDefinitiveAdjustmentRefusal(status: number, payload: unknown): payload is { code: string; message: string; existingAdjustmentId?: number } {
  return status === 409 && !!payload && typeof payload === "object"
    && DEFINITIVE_ADJUSTMENT_REFUSALS.includes(String((payload as { code?: unknown }).code))
    && typeof (payload as { message?: unknown }).message === "string";
}
/** Drops only this exact unacknowledged command after a definitive refusal. Never drops a receipt. */
export function discardRefusedAdjustmentCommand(storage: StorageLike, command: AdjustmentCommand) {
  const current = readAdjustmentCommand(storage, command.scope);
  if (!current || current.key !== command.key || current.receipt !== null) throw new Error("تعذّر التحقق من طلب الشدّة المرفوض؛ راجع السجل.");
  storage.removeItem(adjustmentCommandStorageKey(command.scope));
  if (readAdjustmentCommand(storage, command.scope)) throw new Error("تعذّر إزالة طلب الشدّة المرفوض بأمان.");
}
