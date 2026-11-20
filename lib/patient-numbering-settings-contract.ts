import type { AppliedNumbering } from "./patient-numbering-command";
import type { NumberingDisplaySnapshot } from "../components/settings/patient-numbering-preview-model";
import type { NumberingSaveOperations } from "../components/settings/patient-numbering-save-model";

export interface SettingsNumberingReceipt {
  requestId: string;
  value: AppliedNumbering;
}
/** Null is a verified exhausted sequence, not an unavailable or invented next number. */
export type SettingsNumberingCurrent = NumberingDisplaySnapshot | { prefix: string; next: null; revision: string };
export type SettingsNumberingRead =
  | { ok: true; current: SettingsNumberingCurrent; readId: string; receipt: SettingsNumberingReceipt | null }
  | { ok: false; reason: string };
export interface NumberingSettingsTransport extends NumberingSaveOperations {
  /** null requests current state; an ID reconciles that exact durable receipt. */
  read(requestId: string | null): Promise<SettingsNumberingRead>;
}
export const isNumberingRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
