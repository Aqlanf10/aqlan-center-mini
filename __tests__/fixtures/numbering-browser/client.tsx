import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PatientNumberingSaveCandidate } from "../../../components/settings/PatientNumberingSaveCandidate";
import type { NumberingSaveOperations } from "../../../components/settings/patient-numbering-save-model";
import type { NumberingDisplaySnapshot } from "../../../components/settings/patient-numbering-preview-model";
async function call(name: string, body: unknown) {
  const response = await fetch("/test/" + name, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return response.json();
}
const operations: NumberingSaveOperations = {
  preview: body => call("preview", body),
  save: ({ prefix, next, expectedRevision, requestId, reason, previewToken }) =>
    call("save", { prefix, next, expectedRevision, requestId, reason, previewToken }),
};
function BrowserFixture() {
  const [current, setCurrent] = useState<NumberingDisplaySnapshot | null>(null);
  const [readId, setReadId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void call("read", {}).then(result => {
      if (!active) return;
      if (!result.ok) { setMessage("صلاحية مالك الاختبار مطلوبة"); return; }
      setCurrent(result.current); setReadId(result.readId);
    });
    return () => { active = false; };
  }, []);
  return <main dir="rtl">
    <h1>مختبر ترقيم محلي ببيانات اصطناعية فقط</h1>
    {message && <p role="alert">{message}</p>}
    {current && readId && <PatientNumberingSaveCandidate current={current} operations={operations}
      readGate={{ state: "verified", readId }} />}
    <button onClick={() => { void call("ordinary", {}).then(p => setMessage(p.number ?? "تعذّر التسجيل")); }}>
      تسجيل مريض اصطناعي
    </button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<BrowserFixture />);
