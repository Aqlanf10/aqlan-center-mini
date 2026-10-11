"use client";
import { useEffect, useState } from "react";
import type { StudyOwner } from "@/lib/ortho-case-study-owner";
import type { StudyEditorRevision } from "@/lib/ortho-case-study-editor-contract";
import { caseLayout } from "@/lib/ortho-case-template";
import { readStudyPanelReview, type StudyPanelReview } from "@/lib/ortho-case-study-review-contract";
interface Props { owner: StudyOwner; readVersion: number; revision: StudyEditorRevision }
export default function OrthoSavedStudyReview(props: Props) {
  const { revision, readVersion } = props;
  const [selected, setSelected] = useState("");
  const panel = revision.authored.panels.find(value => value.instanceId === selected) ?? revision.authored.panels[0];
  return <section className="min-w-0 rounded border p-3 space-y-2" aria-label="مراجعة الدراسة المحفوظة">
    <h3>مراجعة النسخة المحفوظة {revision.version} — {revision.kind === "draft" ? "مسودة" : "موثقة"}</h3>
    <p>هذا العرض من النسخة المحفوظة المحددة. التعديلات المحلية لا تظهر فيه قبل الحفظ؛ توثيق الدراسة لا يعني اعتمادًا سريريًا جديدًا.</p>
    <label>القسم المحفوظ المعروض <select className="min-h-11 max-w-full rounded border p-2" value={panel?.instanceId ?? ""}
      onChange={event => setSelected(event.currentTarget.value)}>{revision.authored.panels.map(value => <option key={value.instanceId} value={value.instanceId}>{caseLayout(value.layoutKey)?.titleAr} — {value.instanceId}</option>)}</select></label>
    {panel && <SavedPanel key={JSON.stringify([revision.patientId, revision.orthoCaseId, revision.clinicalCaseId, revision.id, revision.contentHash, panel.instanceId, readVersion])}
      {...props} panelId={panel.instanceId} />}
  </section>;
}
function SavedPanel({ owner, readVersion, revision, panelId }: Props & { panelId: string }) {
  const [stored, setStored] = useState<{ owner: StudyOwner; readVersion: number; value: StudyPanelReview } | null>(null), [error, setError] = useState(false);
  const value = stored?.owner === owner && stored.readVersion === readVersion && stored.value.revisionId === revision.id
    && stored.value.revisionHash === revision.contentHash && stored.value.panelId === panelId ? stored.value : null;
  useEffect(() => {
    let active = true; const abort = new AbortController(); setError(false);
    const current = () => active && owner.active() && owner.matches(revision) && owner.readVersion === readVersion;
    const panel = revision.authored.panels.find(item => item.instanceId === panelId);
    if (!panel) return () => { active = false; abort.abort(); };
    void (async () => {
      try {
        const query = new URLSearchParams({ patientId: String(revision.patientId), revisionId: String(revision.id), panelId });
        const response = await fetch(`/api/ortho/${revision.orthoCaseId}/case-study/review?${query}`, { cache: "no-store", credentials: "same-origin", signal: abort.signal });
        if (!current()) return;
        if (response.status === 401 || response.status === 403) { owner.denied(); throw new Error("restricted"); }
        if (!response.ok || !response.headers.get("cache-control")?.includes("no-store")) throw new Error("review_unavailable");
        const text = await response.text(); if (new TextEncoder().encode(text).length > 4 * 1024 * 1024) throw new Error("review_limit");
        const checked = readStudyPanelReview(JSON.parse(text), { patientId: revision.patientId, orthoCaseId: revision.orthoCaseId,
          clinicalCaseId: revision.clinicalCaseId, revisionId: revision.id, revisionHash: revision.contentHash, kind: revision.kind,
          panelId, layoutKey: panel.layoutKey, sourceKeys: panel.sourceKeys, panelState: panel.state, included: panel.included,
          comments: [revision.authored.comment, panel.comment].filter(comment => comment.length > 0) });
        if (current()) setStored({ owner, readVersion, value: checked });
      } catch { if (current()) setError(true); }
    })();
    return () => { active = false; abort.abort(); };
  }, [owner, readVersion, revision, panelId]);
  if (!owner.active() || !owner.matches(revision) || owner.readVersion !== readVersion) return <p role="status">تغيرت صلاحية أو هوية العرض؛ يلزم تحقق جديد.</p>;
  if (error) return <p role="alert">تعذّرت مراجعة هذا القسم أو تغيّرت صلاحية مصدره. لا تعني النتيجة خلو السجل ولا تعرض نسخة بديلة.</p>;
  if (!value) return <p role="status">جارٍ قراءة القسم المحفوظ…</p>;
  return <div className="min-w-0 space-y-3">
    <h4>{value.title}</h4><p>وقت التقاط النسخة: <time dateTime={value.capturedAt} dir="ltr" className="inline-block">{value.capturedAt}</time> — {value.included ? "مضمّن في العرض المختار" : "مستبعد من العرض المختار؛ محفوظ للمراجعة"}</p>
    <p role="status">حالة القسم المحفوظة: {{ available: "متاح", not_recorded: "غير مسجل", unavailable: "غير متاح", restricted: "مقيّد" }[value.panelState]}</p>
    {value.panelState !== "available" && <p>لا تُعرض حقائق سريرية أو صور لهذا القسم وفق حالته المحفوظة. بقيت المراجع والتعليقات في النسخة دون تغيير؛ هذه الحالة لا تمنح صلاحية وصول.</p>}
    {value.blocks.map((block, index) => block.kind === "paragraph" ? <p key={index} className="whitespace-pre-wrap break-words">{block.text}</p>
      : <div key={index} className="max-w-full overflow-x-auto" tabIndex={0} aria-label={`جدول محفوظ ${index + 1}`}><table className="w-full border-collapse text-sm"><thead><tr>{block.headers.map((header, col) => <th key={col} scope="col" className="border p-2 text-start">{header}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.cells.map((cell, col) => <td key={col} className="border p-2 whitespace-pre-wrap break-words align-top">{cell}</td>)}</tr>)}</tbody></table></div>)}
    {value.panelState === "available" && !value.blocks.length && !value.unavailable.length && !value.unmapped.length && <p>لا توجد حقائق نصية مسجلة ومطابقة لهذا القسم. لا تُفترض نتائج طبيعية.</p>}
    {!!value.unavailable.length && <div role="status"><p>مصادر غير متاحة في الالتقاط المحفوظ:</p><ul>{value.unavailable.map(issue => <li key={issue.sourceKey}>{issue.sourceKey} — {issue.reason}</li>)}</ul></div>}
    {!!value.unmapped.length && <div role="status"><p>مصادر محفوظة لم يكتمل عرضها في هذا القسم:</p><ul>{value.unmapped.map(issue => <li key={issue.sourceKey}>{issue.sourceKey} — {issue.reason}</li>)}</ul></div>}
    {!!value.pendingMediaCount && value.panelState === "available" && <p role="status">الصور المختارة لهذا القسم: {value.pendingMediaCount}. المعاينة المتحققة غير متاحة هنا بعد؛ لم تُستبدل الصور بصور افتراضية.</p>}
    {!!value.pendingMediaCount && value.panelState !== "available" && <p>مراجع الصور المحتفظ بها دون عرض: {value.pendingMediaCount}.</p>}
    {!!value.comments.length && <aside><h5>تعليقات مؤلف الدراسة المحفوظة</h5>{value.comments.map((comment, index) => <p key={index} className="whitespace-pre-wrap break-words">{comment}</p>)}</aside>}
  </div>;
}
