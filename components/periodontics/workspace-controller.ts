import { newIdempotencyKey } from "@/lib/idempotency-key";
import type { PerioExamView } from "@/lib/periodontics-db";
import type { PerioSite } from "@/lib/periodontics";
import { PerioApiError, perioWorkspaceApi, type PerioWorkspaceApi } from "./api";
import { draftMatchesExam, editorDraft, editorIsDirty, editSite, serializeEditor, type PerioEditorDraft, type PerioInputSite, type PerioVisitContext } from "./workspace-model";

export interface WorkspaceContext {
  patientId: number;
  currentVisit: PerioVisitContext | null;
  editable: boolean;
  contextStatus: "loading" | "error" | "ready";
}
export interface AddendumDraft { text: string; requestKey: string | null; attemptedText: string | null; needsReload: boolean; blocked: boolean }
export interface WorkspaceState {
  exams: PerioExamView[];
  loaded: boolean;
  access: "unverified" | "ready" | "stale" | "denied" | "unavailable";
  busy: "load" | "save" | "addendum" | null;
  selected: "current" | number;
  anchorVisit: PerioVisitContext | null;
  staleContext: boolean;
  draft: PerioEditorDraft;
  baseline: PerioEditorDraft;
  recovery: "reload" | "review" | null;
  error: string | null;
  notice: string | null;
  addenda: Record<number, AddendumDraft>;
  writeBlocked: boolean;
}
const sameVisit = (a: PerioVisitContext | null, b: PerioVisitContext | null) => a?.id === b?.id && a?.patientId === b?.patientId && a?.caseId === b?.caseId && a?.signedAt === b?.signedAt;
export function workspacePending(state: WorkspaceState): boolean {
  return editorIsDirty(state.draft, state.baseline) || Object.values(state.addenda).some((draft) => !!draft.text || draft.attemptedText !== null);
}
/** One patient/authority instance. The UI remounts it on either identity change. */
export class PeriodonticsWorkspaceController {
  private state: WorkspaceState;
  private listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private active = true;
  private context: WorkspaceContext;
  constructor(context: WorkspaceContext, private api: PerioWorkspaceApi = perioWorkspaceApi,
    private onPersisted?: (exam: PerioExamView) => void, private makeKey = () => newIdempotencyKey("perio")) {
    this.context = context;
    const anchorVisit = context.contextStatus === "ready" ? context.currentVisit : null;
    const draft = editorDraft(null, anchorVisit?.caseId ?? null);
    this.state = { exams: [], loaded: false, access: "unverified", busy: null, selected: "current", anchorVisit, staleContext: false,
      draft, baseline: draft, recovery: null, error: null, notice: null, addenda: {}, writeBlocked: false };
  }
  setPersistedListener(listener: ((exam: PerioExamView) => void) | undefined) { this.onPersisted = listener; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(patch: Partial<WorkspaceState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }
  activate() { if (!this.active) { this.active = true; this.patch({ busy: null }); } }
  dispose() { this.active = false; this.request?.abort(); this.request = null; }
  private begin(kind: NonNullable<WorkspaceState["busy"]>) {
    if (!this.active || this.state.busy || this.accessEnded()) return null;
    const request = new AbortController(); this.request = request;
    this.patch({ busy: kind, error: null, notice: null }); return request;
  }
  private live(request: AbortController) { return this.active && this.request === request && !request.signal.aborted; }
  private finish(request: AbortController) { if (this.live(request)) { this.request = null; this.patch({ busy: null }); if (this.state.staleContext && !workspacePending(this.state)) this.adoptContext(); } }
  private accessEnded() { return this.state.access === "denied" || this.state.access === "unavailable"; }
  /** A definitive scope denial supersedes draft retention. This instance cannot regain access. */
  private redactAccessFailure(error: unknown, request: AbortController): boolean {
    if (!(error instanceof PerioApiError) || ![401, 403, 404].includes(error.status ?? 0) || !this.live(request)) return false;
    request.abort(); this.request = null;
    const draft = editorDraft(null, null);
    this.patch({ exams: [], loaded: false, access: error.status === 404 ? "unavailable" : "denied", busy: null,
      selected: "current", anchorVisit: null, staleContext: false, draft, baseline: draft, recovery: null,
      addenda: {}, writeBlocked: true, notice: null,
      error: error.status === 404 ? "سجل اللثة غير متاح لهذا السياق. أُخفيت البيانات السابقة؛ أعد فتح مساحة المريض للتحقق من الوصول."
        : "لم يعد الوصول إلى سجل اللثة مسموحًا. أُخفيت البيانات السابقة؛ أعد فتح مساحة المريض بعد التحقق من الصلاحية." });
    return true;
  }
  private currentExam() { return this.state.exams.find((exam) => exam.visitId === this.state.anchorVisit?.id) ?? null; }
  setContext(context: WorkspaceContext) {
    if (context.patientId !== this.context.patientId) { this.dispose(); return; }
    this.context = context;
    if (this.accessEnded()) return;
    if (context.contextStatus !== "ready" || sameVisit(this.state.anchorVisit, context.currentVisit)) return;
    if (workspacePending(this.state) || this.state.busy) {
      if (!this.state.staleContext) this.patch({ staleContext: true });
      return;
    }
    this.adoptContext();
  }
  /** Called only after explicit navigation/discard confirmation when a dirty context changed. */
  adoptContext() {
    if (this.state.busy || this.context.contextStatus !== "ready" || this.accessEnded()) return;
    const visit = this.context.currentVisit;
    const exam = this.state.exams.find((item) => item.visitId === visit?.id) ?? null;
    const draft = editorDraft(exam, visit?.caseId ?? null);
    this.patch({ anchorVisit: visit, draft, baseline: draft, selected: "current", staleContext: false, recovery: null, addenda: {}, error: null, notice: null });
  }
  canEdit() {
    const state = this.state;
    return state.selected === "current" && this.context.editable && this.context.contextStatus === "ready" && state.loaded && state.access === "ready" && !state.busy && !state.staleContext
      && !state.writeBlocked && !!state.anchorVisit && state.anchorVisit.patientId === this.context.patientId
      && sameVisit(state.anchorVisit, this.context.currentVisit) && !state.anchorVisit.signedAt && !this.currentExam()?.signedAt && !state.recovery;
  }
  changeContext(patch: Partial<Pick<PerioEditorDraft, "doctorId" | "caseId">>) {
    if (this.canEdit()) this.patch({ draft: { ...this.state.draft, ...patch }, notice: null });
  }
  changeSite(toothCode: number, site: PerioSite, patch: Partial<Pick<PerioInputSite, "depthText" | "bleedingOnProbing">>) {
    if (this.canEdit()) this.patch({ draft: editSite(this.state.draft, toothCode, site, patch), notice: null });
  }
  select(selected: WorkspaceState["selected"]) {
    if (!this.state.busy && !this.accessEnded() && (selected === "current" || this.state.exams.some((exam) => exam.id === selected))) this.patch({ selected, notice: null });
  }
  private acceptSaved(exam: PerioExamView) {
    const draft = editorDraft(exam, this.state.anchorVisit?.caseId ?? null);
    this.patch({ exams: [exam, ...this.state.exams.filter((item) => item.id !== exam.id)], draft, baseline: draft,
      recovery: null, error: null, notice: "تم التأكد من حفظ الفحص في السجل." });
    try { this.onPersisted?.(exam); } catch { /* A shell refresh failure cannot undo a confirmed clinical save. */ }
  }
  private async readCanonical(request: AbortController) {
    try {
      const exams = await this.api.list(this.context.patientId, request.signal);
      if (!this.live(request)) return null;
      this.patch({ exams, loaded: true, access: "ready" }); return exams;
    } catch (error) {
      if (!this.redactAccessFailure(error, request) && this.live(request)) {
        // Existing data remains a clearly stale, read-only snapshot until a fresh canonical read.
        this.patch({ access: this.state.loaded ? "stale" : "unverified" });
      }
      throw error;
    }
  }
  async load() {
    const request = this.begin("load"); if (!request) return;
    try {
      const wasDirty = workspacePending(this.state);
      const exams = await this.readCanonical(request); if (!exams) return;
      const current = exams.find((exam) => exam.visitId === this.state.anchorVisit?.id) ?? null;
      if (!wasDirty && !this.state.recovery && !this.state.staleContext) {
        const draft = editorDraft(current, this.state.anchorVisit?.caseId ?? null);
        this.patch({ draft, baseline: draft });
      } else if (this.state.recovery === "reload" || (editorIsDirty(this.state.draft, this.state.baseline) && (this.state.draft.expectedRevision !== (current?.revision ?? null) || !!current?.signedAt))) {
        this.patch({ recovery: "review", notice: "تم تحميل النسخة المحفوظة. راجع الفرق قبل الحفظ." });
      }
      const addenda = { ...this.state.addenda };
      for (const [id, draft] of Object.entries(addenda)) addenda[Number(id)] = { ...draft, needsReload: false };
      this.patch({ addenda });
    } catch (error) {
      if (this.live(request)) this.patch({ error: error instanceof Error ? error.message : "تعذّر تحميل فحوص اللثة.",
        writeBlocked: this.state.writeBlocked });
    } finally { this.finish(request); }
  }
  /** Never called by a background refresh. User has reviewed the canonical comparison. */
  useReviewedRevision() {
    if (this.state.busy || this.state.access !== "ready" || this.state.recovery !== "review" || this.state.staleContext) return;
    const exam = this.currentExam();
    if (exam?.signedAt || this.state.anchorVisit?.signedAt) return;
    this.patch({ draft: { ...this.state.draft, expectedRevision: exam?.revision ?? null },
      baseline: editorDraft(exam, this.state.anchorVisit?.caseId ?? null), recovery: null, error: null,
      notice: "اعتمد إصدار السجل بعد المراجعة؛ لم تُحفظ المسودة بعد." });
  }
  /** Explicitly discard only this workspace's draft; parent clinical drafts remain untouched. */
  discardDraft() {
    if (this.state.busy || this.state.access !== "ready") return;
    const draft = editorDraft(this.currentExam(), this.state.anchorVisit?.caseId ?? null);
    this.patch({ draft, baseline: draft, recovery: null, error: null, notice: null });
  }
  async save() {
    if (!this.canEdit()) return;
    const serialized = serializeEditor(this.state.draft);
    if (!serialized.ok) { this.patch({ error: serialized.message }); return; }
    const visitId = this.state.anchorVisit!.id;
    const attempted = this.state.draft;
    const request = this.begin("save"); if (!request) return;
    try {
      const exam = await this.api.save(this.context.patientId, visitId, serialized.value, request.signal);
      if (this.live(request)) this.acceptSaved(exam);
    } catch (error) {
      if (!this.live(request)) return;
      const apiError = error instanceof PerioApiError ? error : new PerioApiError("تعذّر التأكد من الحفظ.", null);
      if (this.redactAccessFailure(apiError, request)) return;
      this.patch({ error: apiError.message });
      if (apiError.uncertain || apiError.status === 409) {
        this.patch({ recovery: "reload" });
        try {
          const exams = await this.readCanonical(request); if (!exams) return;
          const canonical = exams.find((exam) => exam.visitId === visitId) ?? null;
          if (apiError.uncertain && canonical && draftMatchesExam(attempted, canonical)) this.acceptSaved(canonical);
          else this.patch({ recovery: "review", notice: "مسودتك محفوظة في هذه الشاشة فقط. راجع النسخة المحفوظة قبل إعادة المحاولة." });
        } catch { if (this.live(request)) this.patch({ error: "لم يمكن التحقق من نتيجة الحفظ. المسودة باقية؛ أعد تحميل السجل قبل أي إعادة محاولة." }); }
      }
    } finally { this.finish(request); }
  }
  changeAddendum(examId: number, text: string) {
    const exam = this.state.exams.find((item) => item.id === examId);
    const prior = this.state.addenda[examId];
    if (!this.context.editable || this.context.contextStatus !== "ready" || this.state.access !== "ready" || this.state.busy || this.state.staleContext || !exam?.signedAt || prior?.attemptedText !== null && prior?.attemptedText !== undefined) return;
    this.patch({ addenda: { ...this.state.addenda, [examId]: { text, requestKey: null, attemptedText: null, needsReload: false, blocked: false } }, notice: null });
  }
  async saveAddendum(examId: number) {
    const exam = this.state.exams.find((item) => item.id === examId);
    const draft = this.state.addenda[examId];
    if (!this.context.editable || this.context.contextStatus !== "ready" || this.state.access !== "ready" || this.state.staleContext || this.state.writeBlocked || !exam?.signedAt || !draft || draft.needsReload || draft.blocked || !draft.text.trim() || draft.text.trim().length > 4000) return;
    let key: string;
    try { key = draft.requestKey ?? this.makeKey(); } catch (error) { this.patch({ error: error instanceof Error ? error.message : "تعذّر إعداد مفتاح الملحق." }); return; }
    const body = { text: draft.attemptedText ?? draft.text.trim(), requestKey: key };
    const request = this.begin("addendum"); if (!request) return;
    const attempted = { ...draft, requestKey: key, attemptedText: body.text };
    this.patch({ addenda: { ...this.state.addenda, [examId]: attempted } });
    try {
      const saved = await this.api.addendum(this.context.patientId, examId, body, request.signal);
      if (!this.live(request)) return;
      const addenda = { ...this.state.addenda }; delete addenda[examId];
      this.patch({ exams: this.state.exams.map((item) => item.id === examId ? saved : item), addenda, notice: "تم التأكد من حفظ الملحق؛ أصل الفحص لم يتغيّر." });
      try { this.onPersisted?.(saved); } catch { /* The append succeeded independently of summary refresh. */ }
    } catch (error) {
      if (!this.live(request)) return;
      const apiError = error instanceof PerioApiError ? error : new PerioApiError("تعذّر التأكد من حفظ الملحق.", null);
      if (this.redactAccessFailure(apiError, request)) return;
      const retryNeedsRead = apiError.uncertain || apiError.status === 409;
      this.patch({ error: apiError.message, addenda: { ...this.state.addenda,
        [examId]: { ...attempted, needsReload: retryNeedsRead, blocked: apiError.status === 409,
          // Validation refusals did not append anything; let the user correct the text.
          ...(apiError.status === 400 ? { attemptedText: null, requestKey: null } : {}) } } });
      if (retryNeedsRead) {
        try {
          const exams = await this.readCanonical(request); if (!exams) return;
          this.patch({ addenda: { ...this.state.addenda, [examId]: { ...this.state.addenda[examId], needsReload: false } },
            notice: "تم تحميل السجل. لم يُؤكّد هذا الملحق؛ إعادة المحاولة تحتفظ بالنص ومفتاح الطلب نفسيهما." });
        } catch { if (this.live(request)) this.patch({ error: "نتيجة الملحق غير مؤكدة. أعد تحميل السجل؛ نص المحاولة ومفتاحها محفوظان في هذه الشاشة." }); }
      }
    } finally { this.finish(request); }
  }
}
