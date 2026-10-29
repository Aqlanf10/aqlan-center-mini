"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ROLE_LABEL, type Role } from "@/lib/roles";

/**
 * قسم «الحساب» في محرّر الطاقم الموحّد: الاسم الظاهر والتفعيل/الإيقاف (بقدرات مفوَّضة)،
 * والدور وربط الطبيب وكلمة المرور المؤقتة (للمالك وحده). الواجهة تعرض ما يسمح به الخادم
 * (`allowed`) ولا تقرّر شيئًا: الحفظ دفعة واحدة بنسخة متوقّعة (CAS)، ويُرفض كاملًا إن رُفض
 * أي حقل منه، ويُعرض الرفض كما هو.
 */
export interface StaffAccountView {
  userId: number; username: string; displayName: string; roleLabel: string; active: boolean;
  clinicianPartyId: number | null; clinicianLink: "none" | "active" | "stale"; version: string;
  isOwner: boolean; isSelf: boolean;
  allowed: { displayName: boolean; active: boolean; roleLabel: boolean; clinicianPartyId: boolean; temporaryPassword: boolean };
  roleOptions: string[]; doctorOptions: { id: number; name: string }[];
}
const roleLabel = (role: string) => ROLE_LABEL[role as Role] ?? role;

export function StaffAccountEditor({ userId, onSaved }: { userId: number; onSaved?: () => void }) {
  const uid = useId();
  const [view, setView] = useState<StaffAccountView | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [active, setActive] = useState(true);
  const [role, setRole] = useState("");
  const [party, setParty] = useState<string>("");
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  function adopt(next: StaffAccountView) {
    setView(next); setDisplayName(next.displayName); setActive(next.active); setRole(next.roleLabel);
    setParty(next.clinicianPartyId === null ? "" : String(next.clinicianPartyId)); setPassword(""); setPreview(false);
  }
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/staff-access/${userId}/account`, { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!live.current) return;
      if (!response.ok) { setView(null); setError(body?.message ?? "تعذّر تحميل الحساب."); return; }
      adopt(body);
    } catch { if (live.current) setError("تعذّر الاتصال بالخادم. أعد المحاولة."); }
    finally { if (live.current) setBusy(false); }
  }, [userId]);
  useEffect(() => { void load(); }, [load]);

  if (!view) return busy ? <p role="status" className="text-sm text-slate-600">جارٍ تحميل الحساب…</p> : error ? <p role="alert" className="text-sm text-danger-800">{error}</p> : null;

  const changes: Record<string, unknown> = {};
  const lines: string[] = [];
  if (view.allowed.displayName && displayName.trim() !== view.displayName) { changes.displayName = displayName.trim(); lines.push(`الاسم الظاهر: ${view.displayName} ← ${displayName.trim()}`); }
  if (view.allowed.active && active !== view.active) { changes.active = active; lines.push(active ? "تفعيل الحساب" : "إيقاف الحساب (تسقط جلساته فورًا ولا يدخل حتى يُفعَّل)"); }
  if (view.allowed.roleLabel && role !== view.roleLabel) { changes.roleLabel = role; lines.push(`الدور (تسمية فقط، لا يمنح صلاحيات): ${roleLabel(view.roleLabel)} ← ${roleLabel(role)}`); }
  const nextParty = party === "" ? null : Number(party);
  if (view.allowed.clinicianPartyId && nextParty !== view.clinicianPartyId) {
    changes.clinicianPartyId = nextParty;
    const name = (id: number | null) => id === null ? "بلا ربط" : view.doctorOptions.find(option => option.id === id)?.name ?? `طبيب #${id}`;
    lines.push(`ربط الطبيب: ${name(view.clinicianPartyId)} ← ${name(nextParty)} (يُسجَّل أثره على العمولة من الآن)`);
  }
  if (view.allowed.temporaryPassword && password) { changes.temporaryPassword = password; lines.push("تعيين كلمة مرور مؤقتة (تسقط جلساته القائمة)"); }
  const changed = lines.length > 0;
  const editable = Object.values(view.allowed).some(Boolean);
  const passwordShort = password.length > 0 && password.length < 8;

  async function save() {
    if (!view || busy || !changed) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/staff-access/${userId}/account`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: view.version, changes }),
      });
      const body = await response.json().catch(() => null);
      if (!live.current) return;
      if (!response.ok) {
        setError(body?.message ?? "تعذّر حفظ الحساب.");
        setPreview(false);
        if (response.status === 409) void load();
        return;
      }
      adopt(body);
      setMessage(changes.displayName !== undefined && Object.keys(changes).length === 1
        ? "حُفظ الاسم الظاهر."
        : "حُفظ الحساب وسُجّل في التدقيق. جلسات هذا الموظف القائمة سقطت، وجلسات غيره لم تتأثر.");
      onSaved?.();
    } catch { if (live.current) setError("تعذّر التحقق من الحفظ. حدّث البيانات قبل إعادة المحاولة."); }
    finally { if (live.current) setBusy(false); }
  }

  const field = "mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-2 text-sm disabled:bg-slate-50 disabled:text-slate-500";
  return (
    <section aria-label="الحساب" className="space-y-3 rounded-xl border border-slate-200 p-3" data-testid="account-editor">
      <h3 className="text-sm font-black text-navy-900">الحساب {view.active ? null : <span className="mr-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">غير نشط</span>}</h3>
      {view.isOwner ? <p role="note" className="rounded-xl bg-sky-50 p-2 text-xs text-sky-900">حساب المالك المحمي لا يُعدَّل من هنا.</p>
        : view.isSelf ? <p role="note" className="rounded-xl bg-sky-50 p-2 text-xs text-sky-900">لا يمكنك تعديل حسابك أنت من هنا.</p>
        : !editable ? <p role="note" className="rounded-xl bg-amber-50 p-2 text-xs text-amber-900">لا تملك صلاحية تعديل هذا الحساب.</p> : null}
      {view.clinicianLink === "stale" ? (
        <p role="note" data-testid="stale-link" className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          الحساب مربوط بطبيب غير نشط، فلا يستطيع الدخول. {view.allowed.clinicianPartyId ? "اختر طبيبًا نشطًا أو أزل الربط ثم احفظ." : "إصلاح الربط من صلاحيات المالك."}
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor={`${uid}-name`} className="block text-xs font-bold text-navy-900">الاسم الظاهر</label>
          <input id={`${uid}-name`} value={displayName} maxLength={80} disabled={!view.allowed.displayName || busy}
            onChange={event => setDisplayName(event.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor={`${uid}-active`} className="block text-xs font-bold text-navy-900">الحالة</label>
          <select id={`${uid}-active`} value={active ? "active" : "inactive"} disabled={!view.allowed.active || busy}
            onChange={event => setActive(event.target.value === "active")} className={field}>
            <option value="active">نشط</option>
            <option value="inactive">موقوف</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-role`} className="block text-xs font-bold text-navy-900">الدور (تسمية فقط)</label>
          <select id={`${uid}-role`} value={role} disabled={!view.allowed.roleLabel || busy} onChange={event => setRole(event.target.value)} className={field}>
            {(view.roleOptions.length ? view.roleOptions : [view.roleLabel]).map(option => <option key={option} value={option}>{roleLabel(option)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-party`} className="block text-xs font-bold text-navy-900">ربط بطبيب</label>
          <select id={`${uid}-party`} value={party} disabled={!view.allowed.clinicianPartyId || busy} onChange={event => setParty(event.target.value)} className={field}>
            <option value="">بلا ربط</option>
            {view.clinicianPartyId !== null && !view.doctorOptions.some(option => option.id === view.clinicianPartyId)
              ? <option value={String(view.clinicianPartyId)} disabled>{view.clinicianLink === "stale" ? "طبيب غير نشط" : `طبيب #${view.clinicianPartyId}`}</option> : null}
            {view.doctorOptions.map(option => <option key={option.id} value={String(option.id)}>{option.name}</option>)}
          </select>
        </div>
        {view.allowed.temporaryPassword ? (
          <div className="sm:col-span-2">
            <label htmlFor={`${uid}-password`} className="block text-xs font-bold text-navy-900">كلمة مرور مؤقتة (اتركها فارغة لعدم التغيير)</label>
            <input id={`${uid}-password`} type="password" autoComplete="new-password" value={password} maxLength={1024} disabled={busy}
              onChange={event => setPassword(event.target.value)} className={field} aria-describedby={`${uid}-password-hint`} />
            <p id={`${uid}-password-hint`} className={`mt-1 text-xs ${passwordShort ? "text-danger-800" : "text-slate-600"}`}>8 أحرف على الأقل. سلّمها للموظف مباشرة؛ لا تُحفظ في التدقيق.</p>
          </div>
        ) : null}
      </div>
      {error ? <p role="alert" className="rounded-xl border border-danger-200 bg-danger-50 p-2 text-sm text-danger-800">{error}</p> : null}
      {message ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-900">{message}</p> : null}
      {preview && changed ? (
        <section aria-label="معاينة تعديل الحساب" data-testid="account-preview" className="space-y-1 rounded-xl border border-navy-200 bg-navy-50 p-3 text-sm text-navy-900">
          <h4 className="font-black">معاينة التعديل (يُطبَّق كاملًا أو لا شيء)</h4>
          <ul className="list-inside list-disc">{lines.map(line => <li key={line}>{line}</li>)}</ul>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" onClick={() => void save()} disabled={busy}
              className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">تأكيد حفظ الحساب</button>
            <button type="button" onClick={() => setPreview(false)} disabled={busy}
              className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-navy-900">رجوع للتعديل</button>
          </div>
        </section>
      ) : editable ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setPreview(true)} disabled={busy || !changed || passwordShort || !displayName.trim()}
            className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">حفظ الحساب</button>
          <button type="button" onClick={() => adopt(view)} disabled={busy || !changed}
            className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-navy-900 disabled:opacity-50">تراجع</button>
        </div>
      ) : null}
    </section>
  );
}
