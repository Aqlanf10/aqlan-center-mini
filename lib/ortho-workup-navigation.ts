export type WorkupAssessmentSection = "interview" | "extraoral" | "intraoral" | "measurements" | "records" | "ceph" | "diagnosis";
/** Navigation of existing record owners; a visited step is never clinical approval. */
export const ORTHO_WORKUP_STEPS: readonly {
  id: string; title: string; hint: string;
  pillar: "diagnostics" | "prescription" | "wires" | "retention" | "presentation";
  section?: WorkupAssessmentSection; focus?: "identity" | "financial";
}[] = [
  { id: "identity", title: "الوصول وبيانات الحالة", pillar: "diagnostics", focus: "identity", hint: "راجع هوية المريض والحالة وسياق الزيارة المتاح قبل بدء المقابلة." },
  { id: "interview", title: "المقابلة والشكوى", pillar: "diagnostics", section: "interview", hint: "وثّق الشكوى والتوقعات والتاريخ من مصدرها. تبقى المعلومات المحفوظة مع الحالة عند استكمال الفحص." },
  { id: "extraoral", title: "الفحص خارج الفم", pillar: "diagnostics", section: "extraoral", hint: "وثّق فحص الوجه والابتسامة، وافتح قياسات صور الوجه عند توفر صورة مناسبة." },
  { id: "intraoral", title: "الفحص داخل الفم", pillar: "diagnostics", section: "intraoral", hint: "سجّل فحص الأسنان والإطباق مع الجهة والمصدر وما لم يُفحص." },
  { id: "measurements", title: "القياسات وتحليل الموديلات", pillar: "diagnostics", section: "measurements", hint: "استخدم قياسات الأسنان والقوس المحفوظة، وراجع المدخلات الناقصة قبل تشغيل التحليل." },
  { id: "radiographs", title: "البانوراما وسجلات الصور", pillar: "diagnostics", section: "records", hint: "أرفق الصور المتوفرة وتاريخها ومرحلتها من المصدر. وجود هذه الخطوة لا يطلب تصويراً جديداً." },
  { id: "ceph", title: "السيفالو", pillar: "diagnostics", section: "ceph", hint: "راجع الصورة والمرحلة والمعايرة والمعالم، ثم النتائج والتفسير قبل اعتماد الدراسة." },
  { id: "diagnosis", title: "خلاصة التشخيص والمشكلات", pillar: "diagnostics", section: "diagnosis", hint: "راجع نتائج الفحص والتحاليل ومصادرها، ثم وثّق التشخيص وقائمة المشكلات." },
  { id: "strategy", title: "الأهداف والخطة والميكانيكا", pillar: "prescription", hint: "اربط المشكلة بالهدف والبدائل وقرار الطبيب والاستراتيجية، ثم احفظ الخطة في سجلها." },
  { id: "agreement", title: "الاتفاق المالي والموافقة", pillar: "prescription", focus: "financial", hint: "راجع الاتفاق المرتبط وشموله والموافقة والحساب القائم بحسب صلاحيتك." },
  { id: "visits", title: "التركيب والزيارات والتحصيل", pillar: "wires", hint: "وثّق ما نُفذ في الزيارة وصوره وتعليماته. استخدم الحساب القائم للتحصيل دون إعادة المقابلة." },
  { id: "retention", title: "النتيجة والإنهاء والتثبيت", pillar: "retention", hint: "راجع قرار إنهاء العلاج ومتابعة التثبيت لكل فك، دون افتراض تواريخ أو أجهزة غير مسجلة." },
  { id: "presentation", title: "دراسة الحالة المحفوظة", pillar: "presentation", hint: "احفظ دراسة الحالة وراجع مصادرها وصلاحية مراجعتها؛ التصدير خطوة اختيارية مستقلة." },
];
const id = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
export function workupBookmark(patientId: number, caseId: number, step: number) {
  if (!id(patientId) || !id(caseId) || !Number.isInteger(step) || !ORTHO_WORKUP_STEPS[step]) throw Error("invalid_workup_bookmark");
  return `#ortho-workup/${patientId}/${caseId}/${step + 1}`;
}
export function readWorkupBookmark(hash: string, patientId: number) {
  const match = /^#ortho-workup\/([1-9]\d*)\/([1-9]\d*)\/([1-9]\d*)$/.exec(hash);
  if (!match || !id(patientId) || Number(match[1]) !== patientId || !id(Number(match[2])) || !ORTHO_WORKUP_STEPS[Number(match[3]) - 1]) return null;
  return { caseId: Number(match[2]), step: Number(match[3]) - 1 };
}
/** Replace only this patient page's bookmark, preserving existing context query. */
export function replaceWorkupBookmark(host: Window, patientId: number, caseId: number, step: number) {
  if (host.location.pathname !== `/patients/${patientId}`) return false;
  host.history.replaceState(host.history.state, "", `${host.location.pathname}${host.location.search}${workupBookmark(patientId, caseId, step)}`);
  host.dispatchEvent(new Event("ortho-workup-bookmark")); return true;
}

export function subscribeWorkupBookmark(listener: () => void) {
  window.addEventListener("hashchange", listener);
  window.addEventListener("ortho-workup-bookmark", listener);
  return () => { window.removeEventListener("hashchange", listener); window.removeEventListener("ortho-workup-bookmark", listener); };
}
/** Clear only our bookmark, leaving other page and visit context untouched. */
export function clearWorkupBookmark(host: Window, patientId: number, caseId: number) {
  if (host.location.pathname !== `/patients/${patientId}` || readWorkupBookmark(host.location.hash, patientId)?.caseId !== caseId) return false;
  host.history.replaceState(host.history.state, "", `${host.location.pathname}${host.location.search}`);
  host.dispatchEvent(new Event("ortho-workup-bookmark")); return true;
}

/** The accepted URL owns visibility: a hash edit cannot hide a pending command.
 * Subscribe only in the browser; the server snapshot remains empty. */
export function makeWorkupBookmarkStore(host: () => Window, canNavigate: () => boolean, blocked: () => void) {
  let snapshot = "", initialized = false;
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const sync = () => {
    const window = host(), next = window.location.hash;
    if (next === snapshot) return;
    if (!canNavigate()) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${snapshot}`);
      blocked(); return;
    }
    snapshot = next; for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        const window = host();
        if (!initialized) { snapshot = window.location.hash; initialized = true; }
        window.addEventListener("hashchange", sync); window.addEventListener("ortho-workup-bookmark", sync);
        stop = () => { window.removeEventListener("hashchange", sync); window.removeEventListener("ortho-workup-bookmark", sync); };
        sync(); listener();
      }
      return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = undefined; } };
    },
  };
}
