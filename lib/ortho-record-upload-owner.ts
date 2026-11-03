import type { PhotoStage, PhotoView } from "./ortho-photos";
import { readRecordUploadCommand, verifyRecordUploadReceipt, type RecordUploadCommand, type RecordUploadReceipt } from "./ortho-record-upload";
export type RecordUploadDraft = {
  file: File; photoView: PhotoView; title: string; stage: "" | "unknown" | PhotoStage;
  dateState: "" | "known" | "unknown"; takenOn: string; sourceNote: string;
};
/** Memory-only file and command ownership survives diagnostic/pillar remounts. */
export function makeRecordUploadOwner(input: {
  patientId: number; orthoCaseId: number; actorId: number;
  authorized(): boolean; writable(): boolean; deny(): void;
}) {
  let active = false, generation = 0, revision = 0;
  let draft: RecordUploadDraft | null = null, busy = false, uncertain = false, lastDocumentId: number | null = null;
  let frozen: { command: RecordUploadCommand; body: string; file: File } | null = null;
  let pending: { confirmed: RecordUploadReceipt | null; refused: boolean; controller: AbortController } | null = null;
  const listeners = new Set<() => void>();
  const current = () => active && input.authorized();
  const editable = () => current() && input.writable() && !busy && !uncertain;
  const changed = () => { revision++; for (const listener of [...listeners]) listener(); };
  function begin(command: RecordUploadCommand, retry: boolean) {
    if (!current() || !input.writable() || !draft || busy || (retry ? !uncertain : uncertain)) return null;
    const checked = readRecordUploadCommand(command), body = JSON.stringify(checked);
    if (retry && (!frozen || frozen.body !== body || frozen.file !== draft.file)) return null;
    if (!retry) {
      if (checked.title !== draft.title || checked.photoView !== draft.photoView || !draft.stage || !draft.dateState
        || checked.photoStage !== (draft.stage === "unknown" ? null : draft.stage)
        || checked.occurrence.state !== draft.dateState || checked.occurrence.takenOn !== (draft.dateState === "unknown" ? null : draft.takenOn)
        || checked.occurrence.sourceNote !== draft.sourceNote || checked.file.mimeType !== draft.file.type || checked.file.sizeBytes !== draft.file.size) return null;
      frozen = { command: checked, body, file: draft.file };
    }
    const captured = frozen!, capturedGeneration = generation;
    const operation = { confirmed: null as RecordUploadReceipt | null, refused: false, controller: new AbortController() };
    pending = operation; busy = true; changed();
    const owns = () => active && pending === operation && frozen === captured;
    const live = () => owns() && current() && capturedGeneration === generation && input.writable();
    return {
      current: live, signal: operation.controller.signal, abort: () => operation.controller.abort(),
      form() { const form = new FormData(); form.set("patientId", String(input.patientId)); form.set("command", captured.body); form.set("file", captured.file); return form; },
      checkHeaders(response: Response) {
        if (!live()) return false;
        if ([401, 403].includes(response.status)) { uncertain = true; input.deny(); changed(); return false; }
        return true;
      },
      async confirm(raw: unknown, status: number) {
        if (!live()) return null;
        const receipt = await verifyRecordUploadReceipt(raw, { ...input, command: captured.command }, status);
        if (!live()) return null;
        operation.confirmed = receipt; return receipt;
      },
      refuse(status: number) { if (live() && !retry && [400, 404, 409, 413].includes(status)) operation.refused = true; },
      markUncertain() { if (owns()) { uncertain = true; changed(); } },
      finish() {
        if (!owns()) return;
        const permitted = live(); pending = null; busy = false;
        if (operation.confirmed && permitted) { lastDocumentId = operation.confirmed.documentId; draft = null; frozen = null; uncertain = false; }
        else if (operation.refused && permitted && !retry) frozen = null;
        else uncertain = true;
        changed();
      },
    };
  }
  return {
    get draft() { return draft; }, get busy() { return busy; }, get uncertain() { return uncertain; },
    get revision() { return revision; }, get lastDocumentId() { return lastDocumentId; }, get pendingCommand() { return frozen?.command ?? null; },
    active: current, editable,
    activate() { active = true; },
    select(file: File, photoView: PhotoView, title: string) {
      if (!editable() || draft) return false;
      draft = { file, photoView, title, stage: "", dateState: "", takenOn: "", sourceNote: "" }; generation++; changed(); return true;
    },
    update(update: Partial<Omit<RecordUploadDraft, "file" | "photoView">>) {
      if (!editable() || !draft) return;
      draft = { ...draft, ...update }; generation++; changed();
    },
    discard() { if (!editable()) return false; draft = null; frozen = null; generation++; changed(); return true; },
    begin: (command: RecordUploadCommand) => begin(command, false),
    beginRetry: () => frozen ? begin(frozen.command, true) : null,
    invalidateRead() { generation++; if (pending) { uncertain = true; pending.controller.abort(); } changed(); },
    canLeave: (confirm: () => boolean) => !active || !busy && !uncertain && (!draft || confirm()),
    needsUnloadWarning: () => active && (!!draft || busy || uncertain),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retire() { active = false; generation++; pending?.controller.abort(); pending = null; busy = false; draft = null; frozen = null; listeners.clear(); },
  };
}
export type RecordUploadOwner = ReturnType<typeof makeRecordUploadOwner>;
