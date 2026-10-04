"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { friendlyDateLong } from "@/lib/reminders";
import { useSession } from "./SessionProvider";

interface DiagnosisVersionView {
  id: number;
  version: number;
  content: Record<string, string | null>;
  label: string | null;
  orthoCaseId: number;
  createdBy: string;
  createdAt: string;
}

const READ_TIMEOUT_MS = 15_000;
const readFailure = "تعذّر تحميل تشخيص هذه الحالة. هذا لا يعني عدم وجود تشخيص مسجل.";
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

/** The case panel must never promote standalone/another case's diagnosis. */
function decodeVersions(payload: unknown, caseId: number): DiagnosisVersionView[] {
  if (!payload || typeof payload !== "object" || !("diagnoses" in payload) || !Array.isArray(payload.diagnoses)) {
    throw new Error(readFailure);
  }
  const ids = new Set<number>();
  for (const row of payload.diagnoses) {
    if (!row || typeof row !== "object" || !positiveId(row.id) || ids.has(row.id)
      || !positiveId(row.version) || row.orthoCaseId !== caseId
      || !row.content || typeof row.content !== "object" || Array.isArray(row.content)
      || Object.values(row.content).some(value => value !== null && typeof value !== "string")
      || (row.label !== null && typeof row.label !== "string") || typeof row.createdBy !== "string"
      || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))) throw new Error(readFailure);
    ids.add(row.id);
  }
  return payload.diagnoses as DiagnosisVersionView[];
}

type Owner = { scope: readonly unknown[]; active: boolean; ready: boolean; readSequence: number; controller: AbortController | null; saving: boolean; timer: ReturnType<typeof setTimeout> | null };
type Writer = { owner: Owner; active: boolean };
type Snapshot = { owner: Owner; status: "loading" | "ready" | "error"; versions: DiagnosisVersionView[] };

export function PatientDiagnosis({ patientId, orthoCaseId, onError }: {
  patientId: number; orthoCaseId: number;
  onError: (message: string | null) => void;
}) {
  const session = useSession();
  const canRead = !!session?.username?.trim() && ["admin", "doctor", "reception", "assistant"].includes(session.role);
  const canWrite = canRead && (session?.role === "doctor" || session?.role === "admin");
  const permissionScope = JSON.stringify(session?.permissions ?? null);
  const owner = useMemo<Owner>(() => ({ scope: [patientId, orthoCaseId, session?.username, session?.role, permissionScope],
    active: false, ready: false, readSequence: 0, controller: null, saving: false, timer: null }),
    [patientId, orthoCaseId, session?.username, session?.role, permissionScope]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [writer, setWriter] = useState<Writer | null>(null);
  const [savingOwner, setSavingOwner] = useState<Owner | null>(null);
  useLayoutEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false; owner.ready = false; owner.controller?.abort();
      if (owner.timer !== null) clearTimeout(owner.timer);
    };
  }, [owner]);

  const load = useCallback(async () => {
    if (!owner.active) return;
    owner.ready = false;
    owner.controller?.abort();
    if (owner.timer !== null) clearTimeout(owner.timer);
    const controller = new AbortController();
    owner.controller = controller;
    const sequence = ++owner.readSequence;
    const current = () => owner.active && !controller.signal.aborted && owner.readSequence === sequence;
    setSnapshot({ owner, status: "loading", versions: [] });
    const timeout = setTimeout(() => {
      if (!current()) return;
      controller.abort();
      setSnapshot({ owner, status: "error", versions: [] });
    }, READ_TIMEOUT_MS);
    owner.timer = timeout;
    try {
      if (!canRead || !positiveId(patientId) || !positiveId(orthoCaseId)) throw new Error(readFailure);
      const response = await fetch(`/api/patients/${patientId}/diagnoses?orthoCaseId=${orthoCaseId}`,
        { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(readFailure);
      const versions = decodeVersions(await response.json(), orthoCaseId);
      if (current()) { owner.ready = true; setSnapshot({ owner, status: "ready", versions }); }
    } catch {
      if (current()) setSnapshot({ owner, status: "error", versions: [] });
    } finally {
      clearTimeout(timeout);
      if (owner.timer === timeout) owner.timer = null;
    }
  }, [owner, patientId, orthoCaseId, canRead]);
  useEffect(() => { void load(); }, [load]);

  const ready = snapshot?.owner === owner && snapshot.status === "ready";
  const failed = snapshot?.owner === owner && snapshot.status === "error";
  const versions = ready ? snapshot.versions : [];
  const current = versions[0];
  const writing = writer?.owner === owner && writer.active;
  const saving = savingOwner === owner;

  const save = async (content: Record<string, string>, label: string) => {
    if (!owner.active || !canWrite || !owner.ready || !writer?.active || writer.owner !== owner || owner.saving) return;
    owner.saving = true;
    setSavingOwner(owner);
    onError(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/diagnoses`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, label, orthoCaseId }),
      });
      const payload = await response.json().catch(() => null);
      if (!owner.active) return;
      if (!response.ok) { onError(payload?.message ?? "تعذّر الحفظ."); return; }
      writer.active = false;
      setWriter(null);
      // The POST has settled. A bounded refresh must not keep the write latch
      // held if an old transport ignores abort after its read deadline.
      void load();
    } catch {
      if (owner.active) onError("تعذّر الاتصال بالخادم.");
    } finally {
      owner.saving = false;
      if (owner.active) setSavingOwner(null);
    }
  };

  const lines = (content: Record<string, string | null>): string[] => {
    const names: Record<string, string> = {
      skeletal: "الصنف الهيكلي", dental: "الصنف السني", crowding: "الازدحام",
      overjet: "Overjet", bite: "الإطباق",
    };
    return Object.entries(content).filter(([, value]) => value)
      .map(([key, value]) => key === "note" ? String(value) : `${names[key] ?? key}: ${value}`);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-black text-navy-900 flex items-center gap-1.5">
          <span>📝</span> التشخيص السريري لهذه الحالة {current ? `(نسخة ${current.version})` : ""}
        </h4>
        <span className="text-[10px] text-slate-500 font-bold">
          {current ? friendlyDateLong(current.createdAt.slice(0, 10)) : ready ? "غير مسجل لهذه الحالة" : ""}
        </span>
      </div>
      <p className="mb-2 text-[10px] text-slate-500">نسخ هذه الحالة فقط؛ أرقام النسخ تتبع سجل المريض الكامل.</p>
      <div className="space-y-2">
        {failed ? (
          <div role="alert" className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
            <p>{readFailure}</p>
            <button type="button" onClick={() => { if (owner.active) void load(); }}
              className="mt-2 font-bold underline">إعادة تحميل التشخيص</button>
          </div>
        ) : !ready ? (
          <p className="text-xs text-slate-400">جارٍ التحميل…</p>
        ) : versions.length === 0 ? (
          <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500 text-center">
            لا تشخيص سريري مسجل لهذه الحالة بعد.
          </p>
        ) : versions.map((version, index) => (
          <div key={version.id} className={`rounded-xl p-3 ${index === 0 ? "border border-navy-200 bg-navy-50/50" : "bg-slate-50"}`}>
            <p className="mb-1 text-[11px] font-extrabold text-slate-800">
              {index === versions.length - 1 ? "أول تشخيص مسجل لهذه الحالة" : "تحديث التشخيص"} · نسخة {version.version}
              {version.label ? ` · ${version.label}` : ""}
              {" · "}{friendlyDateLong(version.createdAt.slice(0, 10))} · {version.createdBy}
            </p>
            <ul className="list-inside list-disc text-xs text-slate-700 space-y-0.5">
              {lines(version.content).map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        ))}
        {canWrite && ready && (!writing ? (
          <button type="button" onClick={() => { if (owner.active && owner.ready && !owner.saving) setWriter({ owner, active: true }); }}
            className="w-full rounded-xl border border-navy-800 bg-white py-2 text-xs font-bold text-navy-800 hover:bg-navy-50 transition-colors">
            {current ? "+ تحديث التشخيص (نسخة جديدة — لا يمسح القديم)" : "+ سجّل تشخيص هذه الحالة"}
          </button>
        ) : (
          <DiagnosisForm key={`${patientId}:${orthoCaseId}:${session?.username}:${session?.role}`} saving={saving}
            onCancel={() => { if (owner.active && writer && !owner.saving) { writer.active = false; setWriter(null); } }} onSave={save} />
        ))}
      </div>
    </div>
  );
}

function DiagnosisForm({ saving, onCancel, onSave }: {
  saving: boolean;
  onCancel: () => void;
  onSave: (content: Record<string, string>, label: string) => void;
}) {
  const [skeletal, setSkeletal] = useState("");
  const [dental, setDental] = useState("");
  const [crowding, setCrowding] = useState("");
  const [overjet, setOverjet] = useState("");
  const [bite, setBite] = useState("");
  const [note, setNote] = useState("");
  const [label, setLabel] = useState("");

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-xs">
      <div className="mb-2 grid grid-cols-2 gap-2">
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الصنف الهيكلي</span>
          <input value={skeletal} onChange={(event) => setSkeletal(event.target.value)}
            placeholder="Class II هيكلي" aria-label="الصنف الهيكلي"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الصنف السني</span>
          <input value={dental} onChange={(event) => setDental(event.target.value)}
            placeholder="Class II Div 1" aria-label="الصنف السني" dir="ltr"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الازدحام</span>
          <input value={crowding} onChange={(event) => setCrowding(event.target.value)}
            placeholder="علوي 5 مم" aria-label="الازدحام"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">Overjet</span>
          <input value={overjet} onChange={(event) => setOverjet(event.target.value)}
            placeholder="7 مم" aria-label="البعد الأفقي" dir="ltr"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">الإطباق</span>
          <input value={bite} onChange={(event) => setBite(event.target.value)}
            placeholder="عضة عميقة 60%" aria-label="الإطباق"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
        <label>
          <span className="mb-1 block text-[10px] font-bold text-slate-500">سبب التحديث</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)}
            placeholder="بعد ٦ أشهر من العلاج" aria-label="سبب التحديث"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
        </label>
      </div>
      <label className="mb-2 block">
        <span className="mb-1 block text-[10px] font-bold text-slate-500">ملاحظات حرة</span>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2}
          aria-label="ملاحظات التشخيص"
          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
      </label>
      <div className="flex gap-2">
        <button type="button" disabled={saving}
          onClick={() => onSave({ skeletal, dental, crowding, overjet, bite, note }, label)}
          className="flex-1 rounded-xl bg-navy-800 py-2 text-xs font-black text-white disabled:opacity-50 hover:bg-navy-900">
          {saving ? "جارٍ الحفظ…" : "احفظ النسخة الجديدة"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel}
          className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">
          إلغاء
        </button>
      </div>
    </div>
  );
}

