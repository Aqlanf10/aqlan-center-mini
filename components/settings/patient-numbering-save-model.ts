import type { CommandResult } from '../../lib/patient-numbering-command';

export type NumberingSaveDraft = Readonly<{ prefix: string; next: string; reason: string }>;
/** Send exactly as prepared by the server after the owner reviews the intent. */
export type NumberingSaveTicket = NumberingSaveDraft & Readonly<{
  preview: string; expectedRevision: string; requestId: string; previewToken: string;
}>;
export type SavePreviewResult = { ok: true; ticket: NumberingSaveTicket } | { ok: false; reason: string };
export interface NumberingSaveOperations {
  preview(draft: NumberingSaveDraft): Promise<SavePreviewResult>;
  save(ticket: NumberingSaveTicket): Promise<CommandResult>;
}
