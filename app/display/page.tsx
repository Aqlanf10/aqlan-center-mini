"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useClinicName } from "@/components/SettingsProvider";
import { Logo } from "@/components/Icon";

/**
 * شاشة الصالة.
 *
 * المشكلة التي تحلّها ليست تقنية: المريض ينتظر ساعتين ولا يعرف هل نُسي أم دوره قادم،
 * فيسأل الاستقبال كل عشر دقائق، فتتوقف الاستقبال عن عملها، فيطول الانتظار أكثر. شاشة
 * تقول «عبدالله — كرسي ١» تكسر هذه الحلقة بلا أن يتكلّم أحد.
 *
 * قواعد بُنيت عليها الصفحة:
 * - تُقرأ من آخر الصالة: أكبر خط ممكن، ولا شيء على الشاشة لا يُقرأ من خمسة أمتار.
 * - الاسم الأول وحده — الشاشة يراها كل من في الصالة.
 * - انقطاع الشبكة لا يُفرغ الشاشة: يبقى آخر ما وصل ويظهر مؤشّر صغير، لأن شاشة فارغة
 *   تعني أن يقف المرضى ويسألوا من جديد.
 */

interface CalledEntry { at: string | null; name: string; chair: number | null }
interface ChairEntry { chair: number; state: "busy" | "called" | "free"; name: string | null }
interface DisplayFeed { called: CalledEntry[]; chairs: ChairEntry[]; waiting: number }

const REFRESH_MS = 5_000;

export default function DisplayScreen() {
  const clinicName = useClinicName();
  const [feed, setFeed] = useState<DisplayFeed | null>(null);
  const [stale, setStale] = useState(false);
  const [clock, setClock] = useState("");
  const [soundOn, setSoundOn] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const lastCallRef = useRef<string | null>(null);
  const [flash, setFlash] = useState(false);

  /**
   * نغمة النداء.
   *
   * المتصفحات تمنع الصوت قبل أول لمسة من المستخدم، فلا يمكن تشغيلها تلقائيًا عند فتح
   * الصفحة. لذلك زر واحد يُضغط مرة عند تعليق الشاشة صباحًا، ثم يختفي. ولّدنا النغمة
   * برمجيًا بدل ملف صوت: لا تحميل، ولا ملف قد يضيع من النشر فتصمت الشاشة بلا سبب.
   */
  const chime = useCallback(() => {
    const context = audioRef.current;
    if (!context) return;
    const now = context.currentTime;
    [0, 0.22].forEach((offset, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = index === 0 ? 880 : 1174;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.22);
    });
  }, []);

  const enableSound = useCallback(() => {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const context = new Ctor();
      void context.resume();
      audioRef.current = context;
      setSoundOn(true);
    } catch {
      // متصفّح لا يدعم الصوت: الشاشة تعمل بلا نغمة، ولا داعي لرسالة خطأ أمام المرضى.
      setSoundOn(false);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/display", { cache: "no-store" });
      if (!response.ok) throw new Error("feed");
      const payload = (await response.json()) as DisplayFeed;
      setFeed(payload);
      setStale(false);
    } catch {
      // لا تُمسح البيانات القديمة: عرض اسم قبل دقيقة أفضل من شاشة سوداء.
      setStale(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(poll);
  }, [load]);

  useEffect(() => {
    // أرقام لاتينية عمدًا (`-u-nu-latn`): أرقام الكراسي على الشاشة وفي اللوحة لاتينية،
    // وساعة بأرقام هندية بجانبها تجعل الشاشة تبدو بخطّين مختلفين.
    const tick = () => setClock(new Intl.DateTimeFormat("ar-YE-u-nu-latn", {
      hour: "2-digit", minute: "2-digit", hour12: true,
    }).format(new Date()));
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);

  // النداء الجديد يُعرف بختم وقته لا باسمه: مريضان بنفس الاسم الأول في يوم واحد أمر
  // عادي في تعز، وتمييزهما بالاسم كان سيبتلع نداء الثاني بلا صوت ولا وميض.
  const topCall = feed?.called[0] ?? null;
  useEffect(() => {
    const key = topCall ? `${topCall.at ?? ""}|${topCall.chair ?? ""}` : null;
    if (!key || key === lastCallRef.current) return;
    const isFirstLoad = lastCallRef.current === null;
    lastCallRef.current = key;
    if (isFirstLoad) return; // فتح الشاشة على نداء قديم لا يستحق تنبيهًا.
    setFlash(true);
    chime();
    const stop = setTimeout(() => setFlash(false), 6_000);
    return () => clearTimeout(stop);
  }, [topCall, chime]);

  const previous = (feed?.called ?? []).slice(1);

  return (
    <div className="fixed inset-0 flex flex-col bg-navy-900 text-white">
      {/* هذه الشاشة يراها كل مريض ينتظر — وهي أطول ما يُنظر إليه في المركز. فالشعار
          واسم المركز عليها ليسا زينة: هما ما يجعل الصالة تبدو مركزًا منظّمًا. */}
      <header className="flex items-center justify-between gap-4 border-b border-white/10 px-8 py-4">
        <div className="flex min-w-0 items-center gap-4">
          <Logo className="h-11 w-11 shrink-0 text-white lg:h-14 lg:w-14" />
          <h1 className="truncate text-2xl font-bold text-white/90 lg:text-3xl">{clinicName}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          {stale ? (
            <span className="rounded-full bg-amber-400/20 px-3 py-1 text-sm font-bold text-amber-300">
              يُعاد الاتصال…
            </span>
          ) : null}
          {!soundOn ? (
            <button
              onClick={enableSound}
              className="rounded-xl bg-white/10 px-4 py-2 text-sm font-bold text-white/80"
            >
              تشغيل صوت النداء
            </button>
          ) : null}
          <span className="text-2xl font-bold tabular-nums text-white/70 lg:text-3xl">{clock}</span>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        {topCall ? (
          <div className={`w-full rounded-[2.5rem] border-4 px-8 py-10 transition-colors duration-500 ${flash ? "border-brand-orange bg-brand-orange/20" : "border-white/15 bg-white/5"}`}>
            <p className="text-3xl font-bold text-brand-orange lg:text-5xl">نداء</p>
            <p className="mt-4 break-words text-7xl font-black leading-tight lg:text-[9rem]">{topCall.name}</p>
            {topCall.chair ? (
              <p className="mt-6 text-5xl font-extrabold text-white/85 lg:text-7xl">
                توجّه إلى كرسي {topCall.chair}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="w-full rounded-[2.5rem] border-4 border-white/10 bg-white/5 px-8 py-14">
            <p className="text-5xl font-black lg:text-7xl">أهلًا بكم</p>
            <p className="mt-6 text-2xl font-bold text-white/60 lg:text-4xl">
              {feed ? (feed.waiting > 0 ? "سيُنادى على الاسم عند جاهزية الكرسي" : "لا يوجد انتظار الآن") : "جارٍ التحميل…"}
            </p>
          </div>
        )}

        {previous.length > 0 ? (
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <span className="text-xl font-bold text-white/40 lg:text-2xl">نُودي قبل قليل:</span>
            {previous.map((entry, index) => (
              <span
                key={`${entry.at ?? index}`}
                className="rounded-2xl bg-white/10 px-5 py-2 text-2xl font-extrabold text-white/70 lg:text-3xl"
              >
                {entry.name}
                {entry.chair ? <span className="text-white/40"> · كرسي {entry.chair}</span> : null}
              </span>
            ))}
          </div>
        ) : null}
      </main>

      <footer className="grid grid-cols-2 gap-4 border-t border-white/10 px-8 py-5 lg:grid-cols-4">
        <div className="rounded-2xl bg-white/5 px-4 py-3 text-center">
          <p className="text-4xl font-black lg:text-5xl">{feed?.waiting ?? "—"}</p>
          <p className="text-lg font-bold text-white/50">في الانتظار</p>
        </div>
        {(feed?.chairs ?? []).map((chair) => (
          <div key={chair.chair} className="rounded-2xl bg-white/5 px-4 py-3 text-center">
            <p className={`truncate text-3xl font-black lg:text-4xl ${
              chair.state === "busy" ? "text-white" : chair.state === "called" ? "text-brand-orange" : "text-emerald-400"
            }`}>
              {chair.state === "free" ? "فارغ" : chair.name}
            </p>
            <p className="text-lg font-bold text-white/50">
              كرسي {chair.chair}{chair.state === "called" ? " · في الطريق" : ""}
            </p>
          </div>
        ))}
      </footer>
    </div>
  );
}
