'use client';
import { useEffect, useState } from 'react';
import type { StudyOwner } from '@/lib/ortho-case-study-owner';
import type { StudyEditorRevision } from '@/lib/ortho-case-study-editor-contract';
import { fetchSavedStudyImage, savedStudyImageRequest, SavedStudyImageDenied } from '@/lib/ortho-study-review-image-client';
import type { StudyDisplayLocale } from '@/lib/ortho-case-presentation-i18n';
interface Props { owner: StudyOwner; readVersion: number; revision: StudyEditorRevision; panelId: string; locale?: StudyDisplayLocale }
export default function OrthoSavedStudyImages(props: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const panel = props.revision.authored.panels.find(p => p.instanceId === props.panelId);
  const en = props.locale === 'en';
  if (!props.owner.active() || !props.owner.matches(props.revision) || props.owner.readVersion !== props.readVersion || !panel || panel.state !== 'available') return null;
  return <section className="min-w-0 space-y-2" aria-label={en ? 'Saved image review' : 'مراجعة الصور المحفوظة'}>
    <p>{en ? 'Verified saved-use preview only. Local edits are not shown; this is not clinical approval.' : 'معاينة الاستخدام المحفوظ المتحقق فقط. لا تظهر التعديلات المحلية؛ هذه ليست موافقة سريرية.'}</p>
    {!panel.included && <p role="status">{en ? 'Excluded from export; available for saved review.' : 'مستبعد من التصدير؛ متاح للمراجعة المحفوظة.'}</p>}
    <div className="flex flex-wrap gap-2">{panel.images.map((binding, index) => <button type="button" key={`${binding.slot}:${binding.useId}`} className="min-h-11 rounded border p-2" aria-pressed={selected === binding.slot + ':' + binding.useId}
      onClick={() => setSelected(binding.slot + ':' + binding.useId)}>{en ? 'Review saved image' : 'مراجعة الصورة المحفوظة'} {index + 1}</button>)}
      {selected && <button type="button" className="min-h-11 rounded border p-2" onClick={() => setSelected(null)}>{en ? 'Close preview' : 'إغلاق المعاينة'}</button>}</div>
    {panel.images.filter(b => selected === b.slot + ':' + b.useId).map(binding => <SavedImage key={JSON.stringify([props.revision.id, props.revision.contentHash, props.panelId, binding, props.readVersion])} {...props} slot={binding.slot} useId={binding.useId} />)}
  </section>;
}
export function SavedImage({ owner, readVersion, revision, panelId, useId, slot, locale }: Props & { useId: string; slot: string }) {
  const en = locale === 'en';
  const [stored, setStored] = useState<{ owner: StudyOwner; key: string; url: string; current(): boolean } | null>(null);
  const [error, setError] = useState(false);
  const key = JSON.stringify([revision, panelId, useId, slot, readVersion]);
  const permitted = owner.active() && owner.matches(revision) && owner.readVersion === readVersion;
  useEffect(() => {
    const eligible = () => owner.active() && owner.matches(revision) && owner.readVersion === readVersion;
    let alive = true, objectUrl: string | null = null; const abort = new AbortController();
    const current = () => alive && eligible();
    const dispose = () => { abort.abort(); if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; } };
    const unsubscribe = owner.subscribe(() => { if (!eligible()) { dispose(); setStored(null); } });
    setStored(null); setError(false);
    const timer = setTimeout(() => { dispose(); if (current()) setError(true); }, 15000);
    void (async () => {
      try {
        if (!current()) return;
        const request = savedStudyImageRequest(revision, owner.actorId, panelId, useId, slot);
        const blob = await fetchSavedStudyImage(request, abort.signal);
        if (!current() || abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        if (!current()) { dispose(); return; }
        setStored({ owner, key, url: objectUrl, current: () => current() && !abort.signal.aborted });
      } catch (cause) {
        if (current()) { if (cause instanceof SavedStudyImageDenied) owner.denied(); dispose(); setStored(null); setError(true); }
      } finally { clearTimeout(timer); }
    })();
    return () => { alive = false; clearTimeout(timer); unsubscribe(); dispose(); };
  }, [owner, revision, readVersion, panelId, useId, slot, key, permitted]);
  if (!permitted) return null;
  const url = stored?.owner === owner && stored.key === key ? stored.url : null;
  const use = revision.authored.mediaUses.find(u => u.useId === useId);
  if (error) return <p role="alert">{en ? 'Saved image unavailable or access changed. No substitute image is shown.' : 'تعذرت الصورة المحفوظة أو تغيرت الصلاحية. لا تُعرض صورة بديلة.'}</p>;
  if (!url) return <p role="status">{en ? 'Verifying saved image…' : 'جارٍ التحقق من الصورة المحفوظة…'}</p>;
  return <figure className="min-w-0 space-y-2">
    {/* Bounded verified PNG object URL only; never remote or original URLs. */}
    <img src={url} alt={en ? `Saved image from document ${use?.documentId}` : `صورة محفوظة من المستند ${use?.documentId}`} className="block max-h-[32rem] max-w-full object-contain" draggable={false}
      onError={() => { if (!stored?.current()) return; URL.revokeObjectURL(url); setStored(null); setError(true); }} />
    {use?.caption && <figcaption dir="auto" className="whitespace-pre-wrap break-words">{use.caption}</figcaption>}
  </figure>;
}
