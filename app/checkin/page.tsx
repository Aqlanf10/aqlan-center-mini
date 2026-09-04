"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  CHIEF_COMPLAINTS,
  CHECKIN_MEDICAL_QUESTIONS,
  type ChiefComplaintId,
  type CheckinInput,
} from "@/lib/checkin";
import { Logo } from "@/components/Icon";

type Step = "phone" | "complaint" | "medical" | "sign" | "ticket";

interface TicketData {
  visitId: number;
  patientName: string;
  patientNumber: string;
  queuePosition: number;
  waitingAhead: number;
  positionText: string;
  estimatedWaitMinutes: number;
  status: "waiting" | "called" | "in_chair" | "done" | string;
  chair: number | null;
  calledAt: string | null;
}

export default function CheckinPage() {
  const [step, setStep] = useState<Step>("phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // بيانات المريض
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [age, setAge] = useState("");
  const [isExisting, setIsExisting] = useState(false);
  const [maskedName, setMaskedName] = useState<string | null>(null);

  // الشكوى
  const [complaintId, setComplaintId] = useState<ChiefComplaintId>("routine_checkup");
  const [complaintNote, setComplaintNote] = useState("");

  // الاستمارة الطبية
  const [selectedConditions, setSelectedConditions] = useState<string[]>([]);
  const [allergies, setAllergies] = useState("");
  const [medications, setMedications] = useState("");
  const [emergencyName, setEmergencyName] = useState("");
  const [emergencyPhone, setEmergencyPhone] = useState("");
  const [smoker, setSmoker] = useState(false);
  const [khat, setKhat] = useState(false);

  // التوقيع الرقمي
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasSignature, setHasSignature] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);

  // التذكرة الرقمية
  const [ticket, setTicket] = useState<TicketData | null>(null);

  // استعلام فوري عن الجوال عند كتابته
  const checkPhone = useCallback(async (targetPhone: string) => {
    const clean = targetPhone.replace(/\D/g, "");
    if (clean.length < 8) return;
    try {
      const res = await fetch(`/api/checkin?phone=${encodeURIComponent(targetPhone)}`);
      const data = await res.json();
      if (data.ok && data.exists && data.patient) {
        setIsExisting(true);
        setFullName(data.patient.fullName);
        setMaskedName(data.patient.maskedName);
      } else {
        setIsExisting(false);
        setMaskedName(null);
      }
    } catch {
      // تجاهل أخطاء الشبكة أثناء الكتابة
    }
  }, []);

  const handlePhoneBlur = () => {
    if (phone.trim()) {
      void checkPhone(phone.trim());
    }
  };

  const toggleCondition = (key: string) => {
    setSelectedConditions((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  // لوحة التوقيع الرقمي
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    setIsDrawing(true);
    const rect = canvas.getBoundingClientRect();
    const x = "touches" in e ? e.touches[0].clientX - rect.left : e.clientX - rect.left;
    const y = "touches" in e ? e.touches[0].clientY - rect.top : e.clientY - rect.top;

    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const x = "touches" in e ? e.touches[0].clientX - rect.left : e.clientX - rect.left;
    const y = "touches" in e ? e.touches[0].clientY - rect.top : e.clientY - rect.top;

    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0f172a";
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasSignature(true);
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  // إرسال التسجيل وإصدار التذكرة
  const submitCheckin = async () => {
    setBusy(true);
    setError(null);

    let signatureDataUrl: string | null = null;
    if (canvasRef.current && hasSignature) {
      signatureDataUrl = canvasRef.current.toDataURL("image/png");
    }

    const payload: CheckinInput = {
      phone: phone.trim(),
      fullName: fullName.trim(),
      gender,
      birthYear: age ? new Date().getFullYear() - Number(age) : null,
      complaintId,
      complaintNote: complaintNote.trim() || null,
      conditions: selectedConditions,
      allergies: allergies.trim() || null,
      medications: medications.trim() || null,
      emergencyName: emergencyName.trim() || null,
      emergencyPhone: emergencyPhone.trim() || null,
      habits: { smoking: smoker, khat },
      signatureDataUrl,
    };

    try {
      const res = await fetch("/api/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "تعذّر إتمام التسجيل.");
        setBusy(false);
        return;
      }

      setTicket({
        visitId: data.visitId,
        patientName: data.fullName,
        patientNumber: data.patientNumber,
        queuePosition: data.queuePosition,
        waitingAhead: data.waitingAhead,
        positionText: data.positionText,
        estimatedWaitMinutes: data.estimatedWaitMinutes,
        status: data.status,
        chair: data.chair,
        calledAt: null,
      });
      setStep("ticket");
    } catch {
      setError("تعذّر الاتصال بخادم المركز.");
    } finally {
      setBusy(false);
    }
  };

  // تحديث دور التذكرة تلقائياً (Live Polling كل 6 ثوانٍ)
  useEffect(() => {
    if (step !== "ticket" || !ticket?.visitId) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/checkin?visitId=${ticket.visitId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.ok) {
          setTicket((prev) =>
            prev
              ? {
                  ...prev,
                  status: data.status,
                  chair: data.chair,
                  calledAt: data.calledAt,
                  waitingAhead: data.waitingAhead,
                  positionText: data.positionText,
                  estimatedWaitMinutes: data.estimatedWaitMinutes,
                }
              : null,
          );
        }
      } catch {
        // تجاهل أخطاء الشبكة أثناء التحديث
      }
    }, 6000);

    return () => clearInterval(interval);
  }, [step, ticket?.visitId]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-sky-50/30 to-slate-100 text-slate-800 font-sans antialiased pb-12">
      {/* الترويسة الرئيسية للكشك */}
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur-md border-b border-slate-200/80 px-4 py-3 sm:px-6 shadow-xs">
        <div className="max-w-xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-brand-blue to-sky-600 flex items-center justify-center text-white shadow-xs">
              <Logo className="w-6 h-6 text-white fill-white" />
            </div>
            <div>
              <h1 className="text-base font-black text-slate-900 tracking-tight">مركز عقلان لطب الأسنان</h1>
              <p className="text-xs font-semibold text-slate-500">كشك الخدمة والتسجيل السريع</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            العيادة تعمل
          </span>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-6 sm:px-6">
        {/* شريط خطوات التسجيل */}
        {step !== "ticket" && (
          <div className="mb-6">
            <div className="flex items-center justify-between text-xs font-bold text-slate-500 mb-2">
              <span className={step === "phone" ? "text-brand-blue font-black" : ""}>١. البيانات</span>
              <span className={step === "complaint" ? "text-brand-blue font-black" : ""}>٢. الشكوى</span>
              <span className={step === "medical" ? "text-brand-blue font-black" : ""}>٣. الصحة</span>
              <span className={step === "sign" ? "text-brand-blue font-black" : ""}>٤. التوقيع</span>
            </div>
            <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-blue transition-all duration-300"
                style={{
                  width:
                    step === "phone"
                      ? "25%"
                      : step === "complaint"
                      ? "50%"
                      : step === "medical"
                      ? "75%"
                      : "100%",
                }}
              />
            </div>
          </div>
        )}

        {/* رسائل الخطأ */}
        {error && (
          <div className="mb-4 p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-sm font-bold flex items-center gap-2">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
        )}

        {/* ─── الخطوة الأولى: رقم الهاتف والبيانات الأساسية ─────────────────── */}
        {step === "phone" && (
          <div className="bg-white rounded-3xl border border-slate-200/80 p-5 sm:p-6 shadow-xs space-y-5">
            <div className="text-center space-y-1">
              <span className="text-3xl">📱</span>
              <h2 className="text-lg font-black text-slate-900">مرحباً بك في صالة الانتظار</h2>
              <p className="text-xs sm:text-sm text-slate-500 font-medium">
                أدخل رقم جوالك لتأكيد وصولك وإدراجك في قائمة الدور فوراً
              </p>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                رقم الجوال <span className="text-rose-500">*</span>
              </label>
              <input
                type="tel"
                dir="ltr"
                placeholder="770 123 456"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onBlur={handlePhoneBlur}
                className="w-full text-center text-lg font-bold tracking-wider rounded-2xl border border-slate-300 px-4 py-3 focus:outline-hidden focus:ring-2 focus:ring-brand-blue"
              />
            </div>

            {isExisting && maskedName && (
              <div className="p-3.5 rounded-2xl bg-sky-50 border border-sky-200 text-sky-900 text-sm font-bold flex items-center gap-3">
                <span className="text-2xl">👋</span>
                <div>
                  <p>أهلاً بك مجدداً يا <strong>{maskedName}</strong>!</p>
                  <p className="text-xs text-sky-700 font-normal mt-0.5">ملفك مسجل لدينا. سنقوم بتأكيد وصولك اليوم.</p>
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                الاسم الكامل <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                placeholder="الاسم الثلاثي أو الرباعي"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-2xl border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-brand-blue"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">الجنس</label>
                <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 rounded-2xl">
                  <button
                    type="button"
                    onClick={() => setGender("male")}
                    className={`py-2 text-xs font-bold rounded-xl transition-all ${
                      gender === "male" ? "bg-white text-brand-blue shadow-xs" : "text-slate-600"
                    }`}
                  >
                    ذكر
                  </button>
                  <button
                    type="button"
                    onClick={() => setGender("female")}
                    className={`py-2 text-xs font-bold rounded-xl transition-all ${
                      gender === "female" ? "bg-white text-rose-600 shadow-xs" : "text-slate-600"
                    }`}
                  >
                    أنثى
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">العمر التقريبي</label>
                <input
                  type="number"
                  placeholder="مثال: 28"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-sm font-bold text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-brand-blue text-center"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                if (phone.replace(/\D/g, "").length < 7) {
                  setError("يرجى إدخال رقم جوال صحيح.");
                  return;
                }
                if (fullName.trim().length < 3) {
                  setError("يرجى إدخال الاسم الكامل.");
                  return;
                }
                setError(null);
                setStep("complaint");
              }}
              className="w-full py-3.5 px-4 rounded-2xl bg-brand-blue hover:bg-sky-700 active:scale-[0.99] text-white font-black text-sm shadow-md transition-all flex items-center justify-center gap-2"
            >
              <span>متابعة لتحديد سبب الزيارة</span>
              <span>←</span>
            </button>
          </div>
        )}

        {/* ─── الخطوة الثانية: سبب الزيارة والشكوى الرئيسية ───────────────── */}
        {step === "complaint" && (
          <div className="bg-white rounded-3xl border border-slate-200/80 p-5 sm:p-6 shadow-xs space-y-5">
            <div className="text-center space-y-1">
              <span className="text-3xl">🦷</span>
              <h2 className="text-lg font-black text-slate-900">ما سبب زيارتك اليوم؟</h2>
              <p className="text-xs sm:text-sm text-slate-500 font-medium">
                اختر الخدمة أو الشكوى الرئيسية ليتم توجيهك للعيادة والكرسي المناسب
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
              {CHIEF_COMPLAINTS.map((c) => {
                const selected = complaintId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setComplaintId(c.id)}
                    className={`p-3 rounded-2xl border text-right transition-all flex flex-col justify-between gap-1.5 ${
                      selected
                        ? c.isUrgent
                          ? "bg-rose-50 border-rose-400 text-rose-950 ring-2 ring-rose-400/40"
                          : "bg-sky-50 border-brand-blue text-sky-950 ring-2 ring-brand-blue/30"
                        : "bg-slate-50/60 border-slate-200 hover:border-slate-300 text-slate-800"
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="text-2xl">{c.icon}</span>
                      {c.isUrgent && (
                        <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-rose-200/80 text-rose-800">
                          طوارئ
                        </span>
                      )}
                    </div>
                    <div>
                      <p className="text-xs sm:text-sm font-black">{c.label}</p>
                      <p className="text-[10px] text-slate-500 font-medium line-clamp-1 mt-0.5">{c.hint}</p>
                    </div>
                  </button>
                );
              })}
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                ملاحظات إضافية أو مكان السن المزعج (اختياري)
              </label>
              <textarea
                rows={2}
                placeholder="صف لنا ما تشعر به باختصار..."
                value={complaintNote}
                onChange={(e) => setComplaintNote(e.target.value)}
                className="w-full rounded-2xl border border-slate-300 p-3 text-xs sm:text-sm font-medium text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-brand-blue"
              />
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setStep("phone")}
                className="py-3 px-4 rounded-2xl border border-slate-200 text-slate-600 font-bold text-xs hover:bg-slate-50"
              >
                رجوع
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep("medical");
                }}
                className="flex-1 py-3.5 px-4 rounded-2xl bg-brand-blue hover:bg-sky-700 active:scale-[0.99] text-white font-black text-sm shadow-md transition-all flex items-center justify-center gap-2"
              >
                <span>متابعة للفحص الصحي</span>
                <span>←</span>
              </button>
            </div>
          </div>
        )}

        {/* ─── الخطوة الثالثة: الفحص الصحي والسلامة السريرية ───────────────── */}
        {step === "medical" && (
          <div className="bg-white rounded-3xl border border-slate-200/80 p-5 sm:p-6 shadow-xs space-y-5">
            <div className="text-center space-y-1">
              <span className="text-3xl">🛡️</span>
              <h2 className="text-lg font-black text-slate-900">سلامتك أولويتنا القصوى</h2>
              <p className="text-xs sm:text-sm text-slate-500 font-medium">
                يرجى الإفصاح عن أي حالات صحية لحمايتك واختيار التخدير والعلاج الآمن
              </p>
            </div>

            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {CHECKIN_MEDICAL_QUESTIONS.map((q) => {
                const checked = selectedConditions.includes(q.key);
                return (
                  <button
                    key={q.key}
                    type="button"
                    onClick={() => toggleCondition(q.key)}
                    className={`w-full p-3 rounded-2xl border flex items-center justify-between gap-3 text-right transition-all ${
                      checked
                        ? q.category === "critical"
                          ? "bg-rose-50 border-rose-300 text-rose-950"
                          : "bg-amber-50 border-amber-300 text-amber-950"
                        : "bg-slate-50/70 border-slate-200/80 hover:bg-slate-100 text-slate-800"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-xl shrink-0">{q.icon}</span>
                      <span className="text-xs sm:text-sm font-bold truncate">{q.label}</span>
                    </div>
                    <span
                      className={`shrink-0 px-2.5 py-1 rounded-xl text-xs font-black transition-all ${
                        checked
                          ? q.category === "critical"
                            ? "bg-rose-500 text-white"
                            : "bg-amber-500 text-white"
                          : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      {checked ? "نعم ⚠️" : "لا"}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="space-y-3 pt-2 border-t border-slate-100">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  أدوية تتناولها بانتظام حالياً (إن وجدت)
                </label>
                <input
                  type="text"
                  placeholder="مثال: أسبرين، علاج سكر، ضغط..."
                  value={medications}
                  onChange={(e) => setMedications(e.target.value)}
                  className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-xs font-medium focus:outline-hidden focus:ring-2 focus:ring-brand-blue"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  حساسية من أدوية أو بنسلين (إن وجدت)
                </label>
                <input
                  type="text"
                  placeholder="مثال: حساسية شديدة من البنسلين ومشتقاته..."
                  value={allergies}
                  onChange={(e) => setAllergies(e.target.value)}
                  className="w-full rounded-2xl border border-slate-300 px-3 py-2 text-xs font-medium focus:outline-hidden focus:ring-2 focus:ring-brand-blue"
                />
              </div>

              {/* عادات التدخين والقات */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setSmoker(!smoker)}
                  className={`p-2.5 rounded-2xl border text-xs font-bold flex items-center justify-center gap-2 ${
                    smoker ? "bg-amber-50 border-amber-300 text-amber-900" : "bg-slate-50 border-slate-200 text-slate-600"
                  }`}
                >
                  <span>🚬</span>
                  <span>مدخن: {smoker ? "نعم" : "لا"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setKhat(!khat)}
                  className={`p-2.5 rounded-2xl border text-xs font-bold flex items-center justify-center gap-2 ${
                    khat ? "bg-emerald-50 border-emerald-300 text-emerald-900" : "bg-slate-50 border-slate-200 text-slate-600"
                  }`}
                >
                  <span>🌿</span>
                  <span>مستهلك قات: {khat ? "نعم" : "لا"}</span>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setStep("complaint")}
                className="py-3 px-4 rounded-2xl border border-slate-200 text-slate-600 font-bold text-xs hover:bg-slate-50"
              >
                رجوع
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep("sign");
                }}
                className="flex-1 py-3.5 px-4 rounded-2xl bg-brand-blue hover:bg-sky-700 active:scale-[0.99] text-white font-black text-sm shadow-md transition-all flex items-center justify-center gap-2"
              >
                <span>متابعة للإقرار والتوقيع</span>
                <span>←</span>
              </button>
            </div>
          </div>
        )}

        {/* ─── الخطوة الرابعة: الإقرار والتوقيع باللمس ─────────────────────── */}
        {step === "sign" && (
          <div className="bg-white rounded-3xl border border-slate-200/80 p-5 sm:p-6 shadow-xs space-y-5">
            <div className="text-center space-y-1">
              <span className="text-3xl">✍️</span>
              <h2 className="text-lg font-black text-slate-900">الإقرار والتوقيع الرقمي</h2>
              <p className="text-xs sm:text-sm text-slate-500 font-medium">
                تأكيد دقة المعلومات الطبية وتفويض الطبيب بالفحص السريري
              </p>
            </div>

            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 text-slate-700 text-xs leading-relaxed">
              <p className="font-bold text-slate-900 mb-1">إقرار المريض / ولي الأمر:</p>
              أقر بأن جميع البيانات الصحية المذكورة أعلاه صحيحة ودقيقة، وأفوض الفريق الطبي بمركز عقلان
              بإجراء الفحص والمعاينة السريرية اللازمة، واتخاذ ما يلزم لسلامتي وصحتي.
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-bold text-slate-700">توقيعك بالإصبع على الشاشة</label>
                {hasSignature && (
                  <button
                    type="button"
                    onClick={clearSignature}
                    className="text-[11px] font-bold text-rose-600 hover:underline"
                  >
                    مسح التوقيع
                  </button>
                )}
              </div>
              <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/50 overflow-hidden touch-none">
                <canvas
                  ref={canvasRef}
                  width={340}
                  height={130}
                  className="w-full h-32 cursor-crosshair bg-transparent"
                  onMouseDown={startDrawing}
                  onMouseMove={draw}
                  onMouseUp={stopDrawing}
                  onMouseLeave={stopDrawing}
                  onTouchStart={startDrawing}
                  onTouchMove={draw}
                  onTouchEnd={stopDrawing}
                />
              </div>
              <p className="text-[10px] text-slate-400 mt-1 text-center font-medium">
                وقّع بإصبعك في المربع أعلاه (اختياري، يمكنك المتابعة مباشرة)
              </p>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setStep("medical")}
                className="py-3 px-4 rounded-2xl border border-slate-200 text-slate-600 font-bold text-xs hover:bg-slate-50"
              >
                رجوع
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={submitCheckin}
                className="flex-1 py-4 px-4 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 active:scale-[0.99] text-white font-black text-sm shadow-md transition-all flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {busy ? (
                  <span>جاري تسجيل وصولك...</span>
                ) : (
                  <>
                    <span>✅ تأكيد وحجز الدور في الصالة</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ─── الخطوة الخامسة: التذكرة الرقمية الحية ────────────────────────── */}
        {step === "ticket" && ticket && (
          <div className="space-y-4">
            {/* بطاقة التذكرة الفاخرة */}
            <div className="bg-gradient-to-br from-slate-900 via-navy-950 to-slate-900 rounded-3xl p-6 text-white shadow-xl border border-white/10 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-brand-blue/20 rounded-full blur-2xl pointer-events-none" />
              <div className="absolute bottom-0 left-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-2xl pointer-events-none" />

              <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">🎫</span>
                  <div>
                    <p className="text-xs font-bold text-white/60">تذكرة صالة الانتظار</p>
                    <p className="text-sm font-black text-white">{ticket.patientName}</p>
                  </div>
                </div>
                <div className="text-left">
                  <span className="text-xs font-bold text-white/50 block">رقم الملف</span>
                  <span className="text-sm font-mono font-black text-brand-orange">{ticket.patientNumber}</span>
                </div>
              </div>

              {/* رقم التذكرة الضخم */}
              <div className="text-center py-4">
                <p className="text-xs font-bold text-sky-400 mb-1">رقمك في قائمة الدور</p>
                <div className="text-6xl font-black tracking-tight text-white font-mono drop-shadow-sm">
                  #{ticket.queuePosition}
                </div>
                <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 text-xs font-bold text-white/90">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>{ticket.positionText}</span>
                </div>
              </div>

              {/* حالة النداء الحية */}
              <div className="mt-4 pt-4 border-t border-white/10">
                {ticket.status === "called" ? (
                  <div className="p-4 rounded-2xl bg-amber-400 text-slate-950 text-center font-black animate-bounce shadow-lg">
                    <p className="text-lg">🔔 تم النداء على اسمك الآن!</p>
                    <p className="text-sm mt-0.5">
                      {ticket.chair ? `يرجى التوجه إلى غرفة العلاج رقم (${ticket.chair})` : "يرجى التوجه إلى الاستقبال"}
                    </p>
                  </div>
                ) : ticket.status === "in_chair" ? (
                  <div className="p-3.5 rounded-2xl bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-center font-bold text-xs">
                    🦷 أنت مسجل حالياً داخل غرفة العلاج
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 text-center">
                    <div className="p-3 rounded-2xl bg-white/5 border border-white/5">
                      <p className="text-xl font-black font-mono text-white">{ticket.waitingAhead}</p>
                      <p className="text-[11px] font-bold text-white/50">أشخاص قبلك</p>
                    </div>
                    <div className="p-3 rounded-2xl bg-white/5 border border-white/5">
                      <p className="text-xl font-black font-mono text-white">
                        {ticket.estimatedWaitMinutes > 0 ? `~${ticket.estimatedWaitMinutes} د` : "قريباً"}
                      </p>
                      <p className="text-[11px] font-bold text-white/50">الوقت التقديري</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* تنبيه الإرشادات */}
            <div className="p-4 rounded-2xl bg-white border border-slate-200 text-slate-700 text-xs space-y-2">
              <div className="flex items-center gap-2 font-bold text-slate-900">
                <span>📺</span>
                <span>تابع شاشة الصالة الرئيسية</span>
              </div>
              <p className="leading-relaxed">
                تم تسجيل وصولك بنجاح وسيتلقى الطبيب ملفك واستمارتك الصحية مباشرة. سيعرض اسمك على شاشة
                العرض بالصالة فور جهوزية الكرسي.
              </p>
              <div className="pt-2 flex items-center justify-between text-[11px] text-slate-400 font-medium">
                <span>يتم تحديث حالتك تلقائياً</span>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="font-bold text-brand-blue hover:underline"
                >
                  تحديث يدوي ↻
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
