import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[], cleanups: [] as (() => void)[] }));
vi.mock('react', async original => {
  const effect = (callback: () => unknown, deps: unknown[]) => {
    const index = hooks.cursor++, old = hooks.slots[index] as unknown[] | undefined;
    if (!old || deps.some((value, offset) => value !== old[offset])) { hooks.slots[index] = deps; hooks.effects.push(callback); }
  };
  return { ...await original<typeof import('react')>(),
    useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = initial;
      return [hooks.slots[index], (next: unknown) => { hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next; }]; },
    useRef: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }; return hooks.slots[index]; },
    useEffect: effect, useLayoutEffect: effect,
  };
});
import OrthoCaseStudy, { SourcePicker } from '../components/OrthoCaseStudy';
import { spaceStudyFixture } from './fixtures/ortho-study-space';
import { readStudyEditorDraft } from '../lib/ortho-case-study-editor-draft';
import OrthoSavedStudyReview from '../components/OrthoSavedStudyReview';
import { makeStudyOwner } from '../lib/ortho-case-study-owner';
import { makeStudyRecoveryLedger, type StudyRecoveryLedger } from '../lib/ortho-case-study-recovery';
import { journeyContentHash } from '../lib/ortho-case-journey-hash';
import { CASE_TEMPLATE_IDENTITY, CASE_TEMPLATE_VERSION } from '../lib/ortho-case-template';
import { serializeStudyEditorDraft } from '../lib/ortho-case-study-editor-draft';
import type { StudySaveExpectation } from '../lib/ortho-case-study-editor-response';
type Element = ReactElement<Record<string, unknown>>;
const elements = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === 'object' && 'props' in node
  ? [node as Element, ...elements((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' && 'props' in node ? text((node as Element).props.children as ReactNode) : typeof node === 'string' ? node : '';
const scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
function fixture(ledger: StudyRecoveryLedger = makeStudyRecoveryLedger(), writable = true) {
  const template = { key: 'full-orthodontic-case', version: CASE_TEMPLATE_VERSION, contentHash: journeyContentHash(CASE_TEMPLATE_IDENTITY) } as const;
  const expected: StudySaveExpectation = { scope, actorId: 7, previousVersion: 0, command: { schemaVersion: 1, clientRequestId: 'synthetic_ui_command_001', kind: 'draft', expectedHead: null,
    baseDocumentedRevision: null, documentedFrom: null, reason: 'Synthetic submitted text', content: { template, identityDisclosure: 'case_only', sources: [], groups: [], mediaUses: [], panels: [], comment: 'Synthetic note' } } };
  const metadata = { id: 91, version: 1, kind: 'draft', contentHash: 'a'.repeat(64), createdAt: '2026-10-01T00:00:00.000Z', predecessorId: null, documentedFromId: null, baseDocumentedId: null };
  const editor = { ok: true, ...scope, template, revision: { ...scope, ...metadata, actorId: 7, reason: expected.command.reason, authored: expected.command.content, authoredHash: journeyContentHash(expected.command.content) },
    head: { id: metadata.id, contentHash: metadata.contentHash }, history: [metadata], canAppend: true };
  const identity = { id: 11, commandId: expected.command.clientRequestId, requestFingerprint: journeyContentHash(expected.command) };
  const owner = makeStudyOwner({ ...scope, actorId: 7, recovery: ledger, authorized: () => true, writable: () => writable, deny() {} }); owner.activate();
  const render = () => {
    hooks.cursor = 0;
    const wrapper = OrthoCaseStudy({ ...scope, patientName: 'Synthetic Patient Name', ownerKey: 'synthetic', owner, confirmDiscard: () => false }) as Element;
    const tree = (wrapper.type as (props: Record<string, unknown>) => ReactNode)(wrapper.props);
    for (const effect of hooks.effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === 'function') hooks.cleanups.push(cleanup as () => void); }
    return elements(tree);
  };
  return { expected, editor, identity, owner, render, ledger };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Cache-Control': 'no-store' } });
beforeEach(() => { hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups = []; });
afterEach(() => { for (const cleanup of hooks.cleanups) cleanup(); vi.unstubAllGlobals(); });
const recoveryResponse = (f: ReturnType<typeof fixture>, state: 'pending' | 'committed' = 'pending') => ({ ok: true, actorId: 7, scope, recovery: { state, expected: f.expected, identity: f.identity } });
const button = (tree: Element[], label: string) => tree.find(node => node.type === 'button' && text(node).includes(label));
const click = (node: Element | undefined) => { expect(node).toBeDefined(); (node!.props.onClick as () => void)(); };
const resetHooks = () => { for (const cleanup of hooks.cleanups) cleanup(); hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups = []; };
describe('study workspace durable recovery controls', () => {
  it('does not expose the editor before recovery is verified, then adopts pending text and blocks new saves', async () => {
    const f = fixture(); let resolve!: (response: Response) => void;
    const response = new Promise<Response>(done => { resolve = done; }), fetcher = vi.fn().mockReturnValueOnce(response).mockResolvedValueOnce(json(f.editor));
    vi.stubGlobal('fetch', fetcher); f.render();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toContain('/recovery?');
    expect(f.render().some(node => node.props['aria-label'] === 'سبب حفظ النسخة')).toBe(false);
    resolve(json(recoveryResponse(f)));
    await vi.waitFor(() => expect(f.render().some(node => node.props['aria-label'] === 'سبب حفظ النسخة')).toBe(true));
    const tree = f.render(), reason = tree.find(node => node.props['aria-label'] === 'سبب حفظ النسخة')!;
    expect(reason.props.value).toBe(f.expected.command.reason); expect(reason.props.disabled).toBe(true);
    expect(button(tree, 'حفظ مسودة الدراسة')!.props.disabled).toBe(true);
    expect(button(tree, 'إعادة التحقق بنفس الطلب')!.props.disabled).toBe(false);
    expect(tree.some(node => node.type === OrthoSavedStudyReview)).toBe(true);
    const confirm = vi.fn().mockReturnValue(false); vi.stubGlobal('window', { confirm });
    click(button(tree, 'إلغاء طلب الحفظ المعلّق'));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce()); expect(fetcher).toHaveBeenCalledTimes(2); expect(f.owner.uncertain).toBe(true);
  });
  it('quarantines a conflicting local draft and offers explicit loss-confirmed discard without overwriting it', async () => {
    const f = fixture(); f.owner.change(serializeStudyEditorDraft({ content: { ...f.expected.command.content, comment: 'Distinct local draft' }, reason: 'Local reason', expectedHead: null, previousVersion: 0, baseDocumentedRevision: null }));
    const before = f.owner.document;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(recoveryResponse(f))).mockResolvedValueOnce(json(f.editor)));
    f.render(); await vi.waitFor(() => expect(f.render().some(node => node.type === OrthoSavedStudyReview)).toBe(true));
    const tree = f.render(); expect(f.owner.document).toBe(''); expect(f.owner.draftQuarantined).toBe(true);
    expect(f.ledger.forDraftOwner(scope, 7).read()?.owned?.document).toBe(before);
    expect(tree.some(node => node.props['aria-label'] === 'تعليق الدراسة')).toBe(false);
    expect(button(tree, 'حفظ مسودة الدراسة')).toBeUndefined();
    expect(button(tree, 'حذف المسودة المحلية المحجوبة بعد التأكيد')).toBeDefined();
  });
  it('keeps saved review visible but hides unreauthorized local draft and foreign cancellation controls', async () => {
    const f = fixture(); f.owner.change(serializeStudyEditorDraft({ content: f.expected.command.content, reason: 'Local source data', expectedHead: null, previousVersion: 0, baseDocumentedRevision: null }));
    const before = f.owner.document;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ ok: true, actorId: 7, scope, recovery: { state: 'blocked', identity: null, canCancel: false } })).mockResolvedValueOnce(json(f.editor)));
    f.render(); await vi.waitFor(() => expect(f.render().some(node => node.type === OrthoSavedStudyReview)).toBe(true));
    const tree = f.render(); expect(f.owner.document).toBe(''); expect(f.ledger.forDraftOwner(scope, 7).read()?.owned?.document).toBe(before);
    expect(tree.some(node => node.props['aria-label'] === 'سبب حفظ النسخة')).toBe(false);
    expect(button(tree, 'إلغاء طلب الحفظ المعلّق')).toBeUndefined();
  });
  it.each(['blocked','pending','none'] as const)('allows independently authorized %s metadata cancellation after editor 403, keeping bytes hidden through ack, null, and remount', async state => {
    const f = fixture(); f.owner.restore(f.expected); const before = f.owner.document;
    let acknowledged = false;
    const fetcher = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes('/editor?')) return new Response('DO NOT DISPLAY clinical source details', { status: 403 });
      if (!options?.method) return json({ ok: true, actorId: 7, scope, recovery: acknowledged || state === 'none' ? null : state === 'blocked' ? { state: 'blocked', identity: f.identity, canCancel: true } : recoveryResponse(f,'pending').recovery });
      const action = JSON.parse(String(options.body)).action; if (action === 'acknowledge') acknowledged = true;
      return json({ ok: true, actorId: 7, scope, identity: f.identity, state: 'cancelled', acknowledged });
    });
    vi.stubGlobal('fetch', fetcher); vi.stubGlobal('window', { confirm: vi.fn().mockReturnValue(true) });
    f.render(); await vi.waitFor(() => expect(button(f.render(), 'إلغاء طلب الحفظ المعلّق')).toBeDefined());
    let tree = f.render(); expect(f.owner.active()).toBe(true); expect(f.owner.document).toBe(''); expect(f.owner.draftQuarantined).toBe(true);
    expect(tree.some(node => node.type === OrthoSavedStudyReview)).toBe(false); expect(tree.some(node => text(node).includes('Synthetic Patient Name'))).toBe(false);
    expect(button(tree, 'حذف المسودة المحلية المحجوبة بعد التأكيد')).toBeUndefined();
    click(button(tree, 'إلغاء طلب الحفظ المعلّق'));
    await vi.waitFor(() => expect(f.owner.uncertain).toBe(false));
    await vi.waitFor(() => expect(button(f.render(), 'حذف المسودة المحلية المحجوبة بعد التأكيد')).toBeDefined());
    expect(f.owner.document).toBe(''); expect(f.owner.draftQuarantined).toBe(true); expect(f.owner.editable()).toBe(false);
    expect(f.ledger.forDraftOwner(scope, 7).read()?.owned?.document).toBe(before);
    f.owner.retire(); resetHooks(); const remount = fixture(f.ledger);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => url.includes('/editor?') ? json(remount.editor) : json({ ok: true, actorId: 7, scope, recovery: null })));
    remount.render(); await vi.waitFor(() => expect(button(remount.render(), 'حذف المسودة المحلية المحجوبة بعد التأكيد')).toBeDefined());
    tree = remount.render(); expect(remount.owner.document).toBe(''); expect(remount.owner.draftQuarantined).toBe(true);
    expect(tree.some(node => node.props['aria-label'] === 'سبب حفظ النسخة')).toBe(false); expect(remount.ledger.forDraftOwner(scope, 7).read()?.owned?.document).toBe(before);
    const confirm = vi.fn().mockReturnValue(false); vi.stubGlobal('window', { confirm }); click(button(tree, 'حذف المسودة المحلية المحجوبة بعد التأكيد'));
    expect(remount.owner.draftQuarantined).toBe(true); expect(remount.ledger.forDraftOwner(scope, 7).read()?.owned?.document).toBe(before);
    confirm.mockReturnValue(true); click(button(remount.render(), 'حذف المسودة المحلية المحجوبة بعد التأكيد'));
    expect(remount.owner.draftQuarantined).toBe(false); expect(remount.ledger.forDraftOwner(scope, 7).read()).toBeNull();
    expect(confirm.mock.calls[0][0]).toContain('تعديلاتها غير المحفوظة');
  });
  it('resolves the committed-receipt plus distinct local draft dead end only after explicit local discard', async () => {
    const f = fixture(); f.owner.change(serializeStudyEditorDraft({ content: { ...f.expected.command.content, comment: 'Discard only by consent' }, reason: 'Distinct local', expectedHead: null, previousVersion: 0, baseDocumentedRevision: null }));
    const before = f.owner.document;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => url.includes('/editor?') ? json(f.editor) : json(recoveryResponse(f, 'committed'))));
    const confirm = vi.fn().mockReturnValue(false); vi.stubGlobal('window', { confirm });
    f.render(); await vi.waitFor(() => expect(button(f.render(), 'حذف المسودة المحلية المحجوبة بعد التأكيد')).toBeDefined());
    expect(button(f.render(), 'إلغاء طلب الحفظ المعلّق')).toBeUndefined(); expect(f.owner.retryExpectation).toBeNull();
    click(button(f.render(), 'حذف المسودة المحلية المحجوبة بعد التأكيد')); expect(f.ledger.forDraftOwner(scope, 7).read()?.owned?.document).toBe(before);
    confirm.mockReturnValue(true); click(button(f.render(), 'حذف المسودة المحلية المحجوبة بعد التأكيد'));
    await vi.waitFor(() => expect(f.render().some(node => node.props['aria-label'] === 'سبب حفظ النسخة')).toBe(true));
    expect(f.owner.retryExpectation).toEqual(f.expected); expect(f.owner.uncertain).toBe(true); expect(button(f.render(), 'إعادة التحقق بنفس الطلب')!.props.disabled).toBe(false);
  });
  it.each(['committed', 'foreign', 'none'] as const)('does not offer an isolated cancellation action for %s metadata after editor denial', async state => {
    const f = fixture(); const receipt = state === 'foreign' ? { state: 'blocked', identity: null, canCancel: false } : state === 'none' ? null : recoveryResponse(f, state).recovery;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ ok: true, actorId: 7, scope, recovery: receipt })).mockResolvedValueOnce(new Response(null, { status: 403 })));
    f.render(); await vi.waitFor(() => expect(f.render().some(node => text(node).includes('قراءة محتوى الدراسة مقيّدة حاليًا'))).toBe(true));
    expect(button(f.render(), 'إلغاء طلب الحفظ المعلّق')).toBeUndefined(); expect(button(f.render(), 'تأكيد استلام نتيجة الإلغاء')).toBeUndefined();
  });
  it('does not offer cancelled-receipt acknowledgment to a non-writable owner', async () => {
    const f = fixture(undefined, false); vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ ok: true, actorId: 7, scope, recovery: { state: 'cancelled', identity: f.identity } })).mockResolvedValueOnce(new Response(null, { status: 403 })));
    f.render(); await vi.waitFor(() => expect(f.render().some(node => text(node).includes('قراءة محتوى الدراسة مقيّدة حاليًا'))).toBe(true));
    expect(button(f.render(), 'تأكيد استلام نتيجة الإلغاء')).toBeUndefined();
  });
  it('clears the prior save failure notice after exact retry and committed acknowledgment succeed', async () => {
    const f = fixture(); let submitted: StudySaveExpectation | null = null, attempts = 0, acknowledged = false;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST' && url.endsWith('/editor')) {
        const body = JSON.parse(String(options.body)); submitted = { scope, actorId: 7, previousVersion: 1, command: body.command }; attempts++;
        if (attempts === 1) return new Response(null, { status: 503 });
        return json({ ok: true, replayed: true, ...scope, revision: { ...f.editor.revision, id: 92, version: 2, predecessorId: 91, contentHash: 'b'.repeat(64),
          reason: submitted.command.reason, authored: submitted.command.content, authoredHash: journeyContentHash(submitted.command.content) } });
      }
      if (options?.method === 'POST') {
        acknowledged = true; const body = JSON.parse(String(options.body));
        return json({ ok: true, actorId: 7, scope, identity: { id: 11, commandId: body.commandId, requestFingerprint: body.requestFingerprint }, state: 'committed', acknowledged: true });
      }
      if (url.includes('/editor?')) return json(f.editor);
      return json({ ok: true, actorId: 7, scope, recovery: submitted && !acknowledged ? { state: 'pending', expected: submitted,
        identity: { id: 11, commandId: submitted.command.clientRequestId, requestFingerprint: journeyContentHash(submitted.command) } } : null });
    }));
    f.render(); await vi.waitFor(() => expect(f.render().some(node => node.props['aria-label'] === 'سبب حفظ النسخة')).toBe(true));
    const reason = f.render().find(node => node.props['aria-label'] === 'سبب حفظ النسخة')!;
    (reason.props.onChange as (event: unknown) => void)({ currentTarget: { value: 'Synthetic retry reason' } }); click(button(f.render(), 'حفظ مسودة الدراسة'));
    await vi.waitFor(() => expect(f.render().some(node => text(node).includes('لم يُؤكد الحفظ. احتُفظ بالمسودة'))).toBe(true));
    await vi.waitFor(() => expect(button(f.render(), 'إعادة التحقق بنفس الطلب')!.props.disabled).toBe(false));
    click(button(f.render(), 'إعادة التحقق بنفس الطلب'));
    await vi.waitFor(() => expect(acknowledged).toBe(true));
    await vi.waitFor(() => expect(f.render().some(node => text(node).includes('لم يُؤكد الحفظ. احتُفظ بالمسودة'))).toBe(false));
    expect(f.owner.uncertain).toBe(false);
  });
  it('still revokes the entire owner on editor 401', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ ok: true, actorId: 7, scope, recovery: { state: 'blocked', identity: f.identity, canCancel: true } })).mockResolvedValueOnce(new Response(null, { status: 401 })));
    f.render(); await vi.waitFor(() => expect(f.owner.active()).toBe(false)); expect(button(f.render(), 'إلغاء طلب الحفظ المعلّق')).toBeUndefined();
  });
});

describe('study space snapshot explicit selection', () => {
  it('offers the documentary space/IPR source in the existing source picker', () => {
    const f = fixture();hooks.cursor = 0;
    const tree = elements(SourcePicker({...scope,owner:f.owner,patientName:'Synthetic',ownerKey:'synthetic',locale:'en',editable:true,onChoose:vi.fn(),confirmDiscard:()=>false}));
    expect(text(tree.find(node=>node.type==='option'&&node.props.value==='space_ledger'))).toBe('Documentary space/IPR ledger snapshot');
  });

  async function ready(layoutKey = 'model-measurements') {
    const f = fixture();
    f.editor.revision.authored.panels = [{instanceId:'space_panel',layoutKey,included:true,state:'not_recorded',sourceKeys:[],images:[],comment:''}];
    f.editor.revision.authoredHash = journeyContentHash(f.editor.revision.authored);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ok:true,actorId:7,scope,recovery:null})).mockResolvedValueOnce(json(f.editor)));
    f.render(); await vi.waitFor(() => expect(f.render().some(node => node.type === SourcePicker)).toBe(true));
    return f;
  }
  it('adds one complete source and refuses a different head without explicit removal', async () => {
    const f = await ready(), selection = spaceStudyFixture().selection;
    const choose = () => f.render().find(node => node.type === SourcePicker)!.props.onChoose as (source: typeof selection) => void;
    choose()(selection);
    expect(readStudyEditorDraft(f.owner.document).content.sources).toEqual([selection]);
    const before = f.owner.document;
    choose()({...selection,key:'space_new_head',id:107,version:7,contentHash:'f'.repeat(64)});
    expect(f.owner.document).toBe(before);expect(f.render().map(text).join(' ')).toContain('لا تُجمع لقطتان للسجل نفسه');
    choose()(selection);expect(readStudyEditorDraft(f.owner.document).content.panels[0].sourceKeys).toEqual([selection.key]);
  });
  it('does not attach a space prefix to an unsupported layout', async () => {
    const f = await ready('interview'), selection = spaceStudyFixture().selection, before = f.owner.document;
    (f.render().find(node => node.type === SourcePicker)!.props.onChoose as (source: typeof selection) => void)(selection);
    expect(f.owner.document).toBe(before);expect(f.render().map(text).join(' ')).toContain('اختر قسم تحليل المسافة');
  });
});
