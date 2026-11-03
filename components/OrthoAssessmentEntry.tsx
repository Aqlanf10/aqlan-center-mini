"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "./SessionProvider";
import { clinicalContextHref } from "@/lib/patient-navigation";
type Choice = {
    id: number;
    fullName: string;
    patientNumber: string;
};
export function OrthoAssessmentEntry() { const session = useSession(); return <Entry key={JSON.stringify([session?.username, session?.role, session?.permissions])}/>; }
function Entry() {
    const [query, setQuery] = useState(""), [choices, setChoices] = useState<Choice[]>([]), [status, setStatus] = useState(""), [busy, setBusy] = useState(false), run = useRef(0), controller = useRef<AbortController | null>(null);
    useEffect(() => () => { run.current++; controller.current?.abort(); }, []);
    async function search(event: React.FormEvent) {
        event.preventDefault();
        if (query.trim().length < 2)
            return;
        const ticket = ++run.current;
        controller.current?.abort();
        const request = new AbortController();
        controller.current = request;
        setChoices([]);
        setBusy(true);
        setStatus("");
        const timer = setTimeout(() => request.abort(), 15000);
        try {
            const response = await fetch(`/api/patients?q=${encodeURIComponent(query.trim())}`, { cache: "no-store", signal: request.signal });
            if (!response.ok || response.redirected)
                throw Error("unavailable");
            const raw: unknown = await response.json();
            if (!Array.isArray(raw) || raw.some(p => !p || typeof p !== "object" || !Number.isSafeInteger(p.id) || p.id <= 0 || typeof p.fullName !== "string" || typeof p.patientNumber !== "string"))
                throw Error("invalid");
            if (run.current === ticket) {
                setChoices(raw.map(p => ({ id: p.id, fullName: p.fullName, patientNumber: p.patientNumber })));
                setStatus(raw.length ? "اختر ملف المريض؛ فتح التقييم أو استكماله يتم داخل الملف نفسه." : "لم توجد نتيجة لهذا البحث.");
            }
        }
        catch {
            if (run.current === ticket)
                setStatus("تعذّر التحقق من نتائج البحث؛ حاول مرة أخرى.");
        }
        finally {
            clearTimeout(timer);
            if (run.current === ticket)
                setBusy(false);
        }
    }
    return <section aria-label="الدخول إلى تقييم حالة تقويم" className="mb-4 space-y-3 rounded-xl border border-navy-200 bg-white p-4">
  <h2 className="font-bold">تقييم حالة تقويم أو استكمالها</h2><form onSubmit={search} className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1">اسم المريض أو رقم ملفه<input aria-label="بحث مريض لملف التقويم" className="block min-h-11 w-full rounded-lg border p-2" value={query} onChange={e => { run.current++; controller.current?.abort(); setQuery(e.target.value); setChoices([]); setStatus(""); setBusy(false); }}/></label><button type="submit" disabled={busy || query.trim().length < 2} className="min-h-11 rounded-lg bg-navy-800 px-4 text-white disabled:opacity-50">البحث عن ملف التقويم</button></form>
  {status && <p role="status" className="text-sm">{status}</p>}{busy && <p role="status">جارٍ البحث في الملفات المسموح بها…</p>}
  <ul className="space-y-2">{choices.map(p => <li key={p.id}><a href={clinicalContextHref(p.id, { pillar: "diagnostics" }, "ortho")} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border p-3"><span>{p.fullName} · {p.patientNumber}</span><span>فتح ملف التقويم</span></a></li>)}</ul>
 </section>;
}
