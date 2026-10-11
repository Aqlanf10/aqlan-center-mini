import React from "react";
import { createRoot } from "react-dom/client";
import OrthoCaseStudy from "../../components/OrthoCaseStudy";
import { makeStudyOwner, type StudyOwner } from "../../lib/ortho-case-study-owner";
import { makeStudyRecoveryLedger } from "../../lib/ortho-case-study-recovery";
import { CASE_TEMPLATE_IDENTITY, CASE_TEMPLATE_VERSION, caseLayout } from "../../lib/ortho-case-template";
import { studyBrowserHash } from "../../lib/ortho-case-study-editor-response";
import type { StudyEditorRevision } from "../../lib/ortho-case-study-editor-contract";
import { STUDY_SOURCE_KINDS, type StudySaveCommand } from "../../lib/ortho-case-study";
const root = createRoot(document.getElementById("root")!);
const ledger = makeStudyRecoveryLedger();
let current: StudyOwner, actorId = 7, writable = true, mounted = true, generation = 0, templateHash = "";
let injectPanelFacts = false;
let holdReview = false, wrongReviewHash = false, failReviewAuth = false, readAllowed = true, throwDenial = false;
const heldReviews: { body: unknown; resolve(response: Response): void }[] = [];
let scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
const stored = new Map<number, StudyEditorRevision[]>(), commands = new Map<string, StudyEditorRevision>();
const requests: { path: string; body: string; actorId: number; resolve(response: Response): void; reject(error: Error): void }[] = [];
const unexpected: string[] = [];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
function render() { root.render(<React.StrictMode>{mounted && <OrthoCaseStudy {...scope} patientName={`Synthetic ${scope.patientId}`} ownerKey={`scope_${generation}`}
  owner={current} confirmDiscard={() => false} />}</React.StrictMode>); }
function replace(next: typeof scope, actor = actorId) {
  current?.retire(); readAllowed = true; scope = next; actorId = actor; generation++;
  const value: StudyOwner = makeStudyOwner({ ...scope, actorId, recovery: ledger, authorized: () => current === value && readAllowed, writable: () => current === value && writable, deny: () => { if (throwDenial) throw new Error("synthetic parent denial failure"); readAllowed = false; writable = false; } });
  current = value; current.activate(); render();
}
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  const match = /^\/api\/ortho\/(41|42)\/case-study\/(editor|sources|review)$/.exec(url.pathname);
  if (url.origin !== location.origin || !match) { unexpected.push(url.pathname); throw new Error("unexpected fixture request"); }
  const caseId = Number(match[1]), own = caseId === 41 ? { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 } : { patientId: 20, orthoCaseId: 42, clinicalCaseId: 52 };
  if ((init?.method ?? "GET") === "POST" && match[2] === "editor" && !url.search && typeof init?.body === "string") {
    return new Promise<Response>((resolve, reject) => requests.push({ path: url.pathname, body: init.body as string, actorId, resolve, reject }));
  }
  if ((init?.method ?? "GET") !== "GET" || url.searchParams.get("patientId") !== String(own.patientId)) { unexpected.push(url.pathname + url.search); throw new Error("unexpected fixture scope"); }
  const allowedQuery = match[2] === "sources" ? ["patientId", "kind"] : match[2] === "review" ? ["patientId", "revisionId", "panelId"] : ["patientId", "revisionId"];
  if ([...url.searchParams.keys()].some(key => !allowedQuery.includes(key) || url.searchParams.getAll(key).length !== 1)) { unexpected.push(url.pathname + url.search); throw new Error("unexpected fixture query"); }
  if (match[2] === "sources") {
    const kind = url.searchParams.get("kind");
    if (!STUDY_SOURCE_KINDS.some(value => value === kind)) { unexpected.push(url.pathname + url.search); throw new Error("unexpected source kind"); }
    const choiceId = caseId === 41 ? 91 : 92;
    const choices = kind === "diagnosis" ? [{ id: choiceId, version: 1, kind, state: "available", unavailableReason: null,
      selection: { key: `diagnosis_${choiceId}`, kind, id: choiceId, version: 1, contentHash: "d".repeat(64) } }] : [];
    return response({ ok: true, ...own, kind, state: "available", choices, nextAfterId: null });
  }
  const history = stored.get(caseId) ?? [], selectedId = url.searchParams.get("revisionId");
  const revision = selectedId ? history.find(row => row.id === Number(selectedId)) : history.at(-1) ?? null;
  if (selectedId && !revision) return response({ ok: false, code: "study_revision_not_found" }, 404);
  if (match[2] === "review") {
    if (failReviewAuth) return response({ ok: false, code: "study_source_restricted" }, 403);
    const panelId = url.searchParams.get("panelId"), panel = revision?.authored.panels.find(value => value.instanceId === panelId);
    if (!selectedId || !revision || !panel || [...url.searchParams.keys()].some(key => !["patientId", "revisionId", "panelId"].includes(key))) return response({ ok: false, code: "invalid_review" }, 400);
    const body = { ok: true, ...own, revisionId: revision.id, revisionHash: wrongReviewHash ? "f".repeat(64) : revision.contentHash,
      kind: revision.kind, panelId: panel.instanceId, layoutKey: panel.layoutKey, panelState: panel.state, title: caseLayout(panel.layoutKey)!.titleAr,
      included: panel.included, capturedAt: revision.createdAt, blocks: injectPanelFacts ? [{ kind: "paragraph", text: "Synthetic clinical facts forbidden by panel state", sourceKeys: [...panel.sourceKeys], review: revision.kind }] : [], comments: [revision.authored.comment, panel.comment].filter(Boolean),
      unavailable: [], unmapped: (panel.state === "available" ? panel.sourceKeys : []).map(sourceKey => ({ sourceKey, kind: revision.authored.sources.find(source => source.key === sourceKey)!.kind,
        reason: "synthetic_fixture_has_no_clinical_capture" })), pendingMediaCount: panel.images.length };
    if (holdReview) return new Promise<Response>(resolve => heldReviews.push({ body, resolve }));
    return response(body);
  }
  return response({ ok: true, ...own, template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: templateHash }, revision,
    head: history.length ? { id: history.at(-1)!.id, contentHash: history.at(-1)!.contentHash } : null, canAppend: writable,
    history: history.map(({ id, version, kind, contentHash, createdAt, predecessorId, documentedFromId, baseDocumentedId }) => ({ id, version, kind, contentHash, createdAt, predecessorId, documentedFromId, baseDocumentedId })) });
};
async function commit(index: number, lost: boolean) {
  const request = requests[index]; if (!request) throw new Error("missing request");
  const parsed = JSON.parse(request.body) as { patientId: number; command: StudySaveCommand }, command = parsed.command;
  const caseId = Number(request.path.split("/")[3]), own = caseId === 41 ? { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 } : { patientId: 20, orthoCaseId: 42, clinicalCaseId: 52 };
  if (parsed.patientId !== own.patientId) throw new Error("wrong fixture write scope");
  const key = `${caseId}:${request.actorId}:${command.clientRequestId}`; let revision = commands.get(key); const replayed = !!revision;
  if (!revision) {
    const history = stored.get(caseId) ?? [], head = history.at(-1);
    if ((head?.id ?? null) !== (command.expectedHead?.id ?? null)) { request.resolve(response({ ok: false, code: "study_head_changed" }, 409)); return; }
    if (command.kind === "documented" && (!head || head.kind !== "draft" || command.documentedFrom?.id !== head.id
      || command.documentedFrom.contentHash !== head.contentHash || await studyBrowserHash(command.content) !== head.authoredHash)) {
      request.resolve(response({ ok: false, code: "study_documented_content_changed" }, 409)); return;
    }
    revision = { ...own, id: 100 + caseId + history.length, actorId: request.actorId, version: history.length + 1, kind: command.kind,
      contentHash: command.kind === "documented" ? head!.contentHash : await studyBrowserHash({ fixtureCapture: command.content, version: history.length + 1 }),
      predecessorId: head?.id ?? null, documentedFromId: command.documentedFrom?.id ?? null, baseDocumentedId: command.baseDocumentedRevision?.id ?? null,
      createdAt: "2026-10-01T00:00:00.000Z", reason: command.reason, authored: command.content, authoredHash: await studyBrowserHash(command.content) };
    commands.set(key, revision); stored.set(caseId, [...history, revision]);
  }
  if (lost) request.reject(new Error("synthetic committed reply lost"));
  else request.resolve(response({ ok: true, replayed, ...own, revision }, replayed ? 200 : 201));
}
async function seedAuthoredState(state: "not_recorded" | "unavailable" | "restricted", malformed = false) {
  const authored: StudyEditorRevision["authored"] = { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: templateHash },
    identityDisclosure: "case_only", sources: [{ key: "diagnosis_91", kind: "diagnosis", id: 91, version: 1, contentHash: "d".repeat(64) }],
    groups: [], mediaUses: [], comment: "Preserved synthetic authored comment", panels: [{ instanceId: "state_panel", layoutKey: "diagnosis", state,
      included: true, sourceKeys: state === "not_recorded" ? [] : ["diagnosis_91"], images: [], comment: "" }] };
  const own = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
  stored.set(41, [{ ...own, id: 141, actorId: 7, version: 1, kind: "draft", contentHash: await studyBrowserHash({ captured: authored }),
    authored, authoredHash: await studyBrowserHash(authored), predecessorId: null, documentedFromId: null, baseDocumentedId: null,
    createdAt: "2026-10-01T00:00:00.000Z", reason: "Synthetic pre-existing state" }]);
  injectPanelFacts = malformed; replace(own);
}
const api = {
  seedAuthoredState,
  snapshot: () => ({ requests: requests.map(({ path, body, actorId }) => ({ path, body, actorId })), unexpected: [...unexpected],
    readAllowed, ownerActive: current.active(), heldReviews: heldReviews.length, pending: current.busy, uncertain: current.uncertain, readVersion: current.readVersion, unload: ledger.needsUnloadWarning(), count: [...stored.values()].reduce((n, rows) => n + rows.length, 0) }),
  revokeReview: (failParent = false) => { throwDenial = failParent; failReviewAuth = true; current.refresh(); },
  holdReviews: () => { holdReview = true; },
  releaseReviews: () => { holdReview = false; heldReviews.splice(0).forEach(request => request.resolve(response(request.body))); },
  wrongReview: () => { wrongReviewHash = true; current.refresh(); },
  refresh: () => current.refresh(),
  commit, detach: () => { mounted = false; render(); }, remount: () => { mounted = true; render(); },
  forceA: () => replace({ patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 }),
  forceB: () => replace({ patientId: 20, orthoCaseId: 42, clinicalCaseId: 52 }),
  readonly: () => { writable = false; current.invalidateRead(); render(); },
  otherActor: () => replace(scope, 8),
};
declare global { interface Window { __studyEditorFixture: typeof api } }
window.__studyEditorFixture = api;
void studyBrowserHash(CASE_TEMPLATE_IDENTITY).then(hash => { templateHash = hash; replace(scope); });
