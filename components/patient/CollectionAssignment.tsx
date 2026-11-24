"use client";
import { useState } from "react";

export function CollectionAssignment({ patientId }: { patientId: number }) {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(action: "grant" | "revoke") {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/patients/${patientId}/collection-assignment`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, action }) });
      const result = await response.json();
      setMessage(response.ok ? (action === "grant" ? "حُفظ التكليف." : "أُلغي التكليف.") : result.message);
    } catch { setMessage("تعذّر تأكيد حفظ التكليف."); } finally { setBusy(false); }
  }
  return <section className="mb-4 rounded-xl border p-3" aria-label="تكليف التحصيل">
    <label>اسم مستخدم الاستقبال المكلف بتحصيل هذا المريض<input className="mx-2 rounded border p-1" dir="ltr" value={username}
      onChange={event => { setUsername(event.target.value); setMessage(""); }} disabled={busy} /></label>
    <button type="button" className="mx-2 underline" disabled={busy || !username.trim()} onClick={() => void save("grant")}>تكليف</button>
    <button type="button" className="mx-2 underline" disabled={busy || !username.trim()} onClick={() => void save("revoke")}>إلغاء التكليف</button>
    <span role="status">{message}</span>
  </section>;
}
