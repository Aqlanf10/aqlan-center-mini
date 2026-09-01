"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/Icon";

/**
 * شاشة الصالة — تلفاز الانتظار.
 *
 * المشكلة التي تحلّها ليست تقنية: المريض ينتظر ولا يعرف هل نُسي أم دوره قادم،
 * فيسأل الاستقبال كل عشر دقائق فتتوقف عن عملها، فيطول الانتظار أكثر. هذه الشاشة
 * تكسر الحلقة: تقول «أحمد م. — غرفة العلاج 2» بصوتٍ ووميض، وتظهر لمن أمامه دور،
 * وتعتذر حين يوجد تأخير، وتذكّر بعناية ما بعد التقويم بين النداءات.
 *
 * قواعد بُنيت عليها:
 * - كل ما يُعرض قادم من الخادم مُقنَّعًا أصلًا — لا هاتف ولا تشخيص ولا حساب ولا
 *   مُعرّفات. لو فُتحت أدوات المتصفح على التلفاز فلا شيء يستحق الحفظ.
 * - انقطاع الشبكة لا يُفرغ الشاشة: يبقى آخر ما وصل ويظهر مؤشّر صغير، لأن شاشة
 *   فارغة تعني أن يقف المرضى ويسألوا من جديد.
 * - النغمة والنطق بضغطة واحدة صباحًا (سياسة المتصفح تمنع الصوت قبل لمسة)،
 *   والنطق نفسه قابل للتعطيل من الإعدادات.
 */

interface CalledEntry { at: string | null; name: string; speechName: string; chair: number | null }
interface ChairEntry { chair: number; state: "busy" | "called" | "free"; name: string | null }
interface QueueEntry { name: string; timeText: string; status: "arrived" | "upcoming"; position: string | null }
interface OrthoSummary { total: number; done: number; waiting: number; upcoming: number }
interface Announcement { title: string; body: string }
interface DisplayFeed {
  now: string;
  called: CalledEntry[];
  chairs: ChairEntry[];
  queue: QueueEntry[];
  stats: { waiting: number; inTreatment: number; done: number; avgWaitMinutes: number | null; ortho: OrthoSummary | null };
  delayNotice: boolean;
  voice: boolean;
  announcements: Announcement[];
  welcomeText: string;
  tagline: string;
}

const REFRESH_MS = 4_000;
/** وميض بطاقة النداء — عشرون إلى ثلاثين ثانية كما يفهم المريض «الآن». */
const FLASH_MS = 30_000;
/** تناوب الإعلانات — أبطأ من الملل وأسرع من النسيان. */
const ANNOUNCE_MS = 15_000;

export default function DisplayScreen() {
  const [feed, setFeed] = useState<DisplayFeed | null>(null);
  const [stale, setStale] = useState(false);
  const [clock, setClock] = useState("");
  const [dateLine, setDateLine] = useState("");
  const [soundOn, setSoundOn] = useState(false);
  const [flash, setFlash] = useState(false);
  const [announcementIndex, setAnnouncementIndex] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const lastCallRef = useRef<string | null>(null);
  const wakeRef = useRef<{ release: () => Promise<void> } | null>(null);

  /**
   * نغمة النداء.
   *
   * ولّدناها برمجيًا بدل ملف صوت: لا تحميل، ولا ملف قد يضيع من النشر فتصمت
   * الشاشة بلا سبب. نغمتان هادئتان متتاليتان — تنبيهٌ لا صيحة.
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

  /**
   * نطق الاسم صوتيًا — بصوتٍ عربي إن وُجد في الجهاز.
   *
   * يُنطق الاسم الأول فقط كما يُنادى به في الصالة أصلًا، ولا يُنطق حرف العائلة
   * المُقنَّع («أحمد ميم» لا معنى لها). وصوت التقويم غائب في بعض أجهزة التلفاز:
   * حين لا يوجد صوت عربي تُتخطى النطقة بصمت — النغمة تكفي، ولا رسالة خطأ أمام
   * المرضى.
   */
  const speak = useCallback((speechName: string, chair: number | null) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      const utterance = new SpeechSynthesisUtterance(
        chair
          ? `${speechName}، يرجى التوجه إلى غرفة العلاج رقم ${chair}`
          : `${speechName}، يرجى التوجه إلى الاستقبال`,
      );
      const voices = window.speechSynthesis.getVoices();
      const arabic = voices.find((voice) => voice.lang?.toLowerCase().startsWith("ar"));
      if (arabic) utterance.voice = arabic;
      utterance.lang = arabic?.lang ?? "ar-SA";
      utterance.rate = 0.95;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch {
      // لا نطق: الشاشة تعمل بالنغمة وحدها.
    }
  }, []);

  // أصوات النطق تُحمَّل في الخلفية متأخرة على بعض الأجهزة — نطلبها مرة عند
  // الفتح ونستمع لوصولها، وإلا كانت قائمة الأصوات فارغة عند أول نداء.
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => window.speechSynthesis.getVoices();
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", load);
  }, []);

  const requestWakeLock = useCallback(async () => {
    // التلفاز معلّق ساعات: شاشة تنام بعد دقيقة خمول تعني صالةً شاشتها سوداء.
    // و`wakeLock` غير مدعوم في كل الأجهزة — غيابه يعني أن صاحب المركز يضبط
    // «السكون» من إعدادات الشاشة نفسها، فلا نُعطّل شيئًا ولا نُظهر خطأً.
    try {
      const wakelock = (navigator as unknown as {
        wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
      }).wakeLock;
      if (wakelock) wakeRef.current = await wakelock.request("screen");
    } catch {
      // لا قفل شاشة: يُترك لضبط الجهاز.
    }
  }, []);

  const enableSound = useCallback(() => {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const context = new Ctor();
      void context.resume();
      audioRef.current = context;
      setSoundOn(true);
      void requestWakeLock();
    } catch {
      // متصفّح لا يدعم الصوت: الشاشة تعمل بلا نغمة، ولا داعي لرسالة خطأ أمام المرضى.
      setSoundOn(false);
    }
  }, [requestWakeLock]);

  const toggleFullscreen = useCallback(() => {
    try {
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      } else {
        // الرفض وارد (بلا إيماءة مستخدم) — ملء الشاشة اختياري لا شرط للشاشة.
        void document.documentElement.requestFullscreen().catch(() => {});
      }
    } catch {
      // ملء الشاشة اختياري — رفضه لا يعطّل الشاشة.
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
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
    // العودة من السكون أو تبديل مصدر الإدخال تُحدّث فورًا لا بعد أربع ثوانٍ.
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEffect(() => {
    // أرقام لاتينية عمدًا (`-u-nu-latn`): ساعة بأرقام هندية فوق شريطٍ بأرقام
    // لاتينية تجعل الشاشة تبدو بخطّين مختلفين.
    const timeFormat = new Intl.DateTimeFormat("ar-YE-u-nu-latn", {
      hour: "2-digit", minute: "2-digit", hour12: true,
    });
    const dateFormat = new Intl.DateTimeFormat("ar-YE-u-nu-latn", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
    const tick = () => {
      const now = new Date();
      setClock(timeFormat.format(now));
      setDateLine(dateFormat.format(now));
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);

  // النداء الجديد يُعرف بختم وقته لا باسمه: مريضان بنفس الاسم الأول في يوم واحد
  // أمر عادي، وتمييزهما بالاسم كان سيبتلع نداء الثاني بلا صوت ولا وميض.
  // إعادة النداء تُحدّث الختمة فيصدر الصوت والوميض من جديد بلا ضغطة ثانية.
  const topCall = feed?.called[0] ?? null;
  useEffect(() => {
    const key = topCall ? `${topCall.at ?? ""}|${topCall.chair ?? ""}` : null;
    if (!key || !topCall || key === lastCallRef.current) return;
    const isFirstLoad = lastCallRef.current === null;
    lastCallRef.current = key;
    if (isFirstLoad) return; // فتح الشاشة على نداء قديم لا يستحق تنبيهًا.
    setFlash(true);
    chime();
    if (soundOn && feed?.voice) speak(topCall.speechName, topCall.chair);
    const stop = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(stop);
  }, [topCall, chime, speak, soundOn, feed?.voice]);

  // تناوب الإعلانات: يتوقف حساب المؤشر حين لا توجد إعلانات، والقسمة تُعيد
  // المؤشر إلى أول القائمة حين تُحذف إعلاناتٌ والشاشة تعمل.
  const announcements = feed?.announcements ?? [];
  useEffect(() => {
    if (announcements.length <= 1) return;
    const timer = setInterval(
      () => setAnnouncementIndex((current) => (current + 1) % announcements.length),
      ANNOUNCE_MS,
    );
    return () => clearInterval(timer);
  }, [announcements.length]);
  const announcement = announcements.length > 0 ? announcements[announcementIndex % announcements.length]! : null;

  const busyChairs = (feed?.chairs ?? []).filter((chair) => chair.state === "busy");
  const previousCalls = (feed?.called ?? []).slice(1);
  const queue = feed?.queue ?? [];
  const stats = feed?.stats;

  return (
    <div className="fixed inset-0 flex flex-col bg-navy-900 text-white">
      {/*
        الشاشة يراها كل مريض ينتظر — وهي أطول ما يُنظر إليه في المركز. الشعار
        واسم المركز والترحيب عليها ليسوا زينة: هم ما يجعل الصالة تبدو مركزًا
        منظّمًا يهتم بمن جاء.
      */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 px-6 py-3 lg:px-8">
        <div className="flex min-w-0 items-center gap-4">
          <Logo variant="white" className="h-11 w-11 shrink-0 lg:h-14 lg:w-14" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-white/90 lg:text-2xl">
              {feed?.welcomeText ?? "أهلًا بكم"}
            </h1>
            <p className="truncate text-sm font-bold text-brand-orange lg:text-base">
              {dateLine}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {stale ? (
            <span className="rounded-full bg-amber-400/20 px-3 py-1 text-sm font-bold text-amber-300">
              يُعاد الاتصال…
            </span>
          ) : null}
          <button
            onClick={toggleFullscreen}
            className="hidden rounded-xl bg-white/10 px-3 py-2 text-sm font-bold text-white/70 lg:block"
            title={isFullscreen ? "الخروج من ملء الشاشة" : "ملء الشاشة"}
          >
            {isFullscreen ? "تصغير" : "ملء الشاشة"}
          </button>
          {!soundOn ? (
            <button
              onClick={enableSound}
              className="rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white"
            >
              تشغيل صوت النداء
            </button>
          ) : null}
          <span className="text-2xl font-bold tabular-nums text-white/80 lg:text-4xl">{clock}</span>
        </div>
      </header>

      {feed?.delayNotice ? (
        <div className="shrink-0 bg-amber-400/15 px-6 py-2 text-center text-base font-bold text-amber-200 lg:text-xl">
          نعتذر لوجود تأخير بسيط في بعض الحالات، ونشكركم على تفهّمكم.
        </div>
      ) : null}

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden px-4 py-4 lg:grid-cols-5 lg:px-6">
        {/*
          بطاقة النداء — أكبر شيء على الشاشة، تُقرأ من خمسة أمتار. تبقى ظاهرة ما دام
          النداء قائمًا، وتتجدد بالوميض والنغمة عند النداء الأول وعند إعادته.
        */}
        <section className="flex min-h-0 flex-col gap-3 lg:col-span-3">
          <div className="flex flex-1 items-center justify-center">
            {topCall ? (
              <div className={`w-full rounded-[2.5rem] border-4 px-8 py-8 text-center transition-colors duration-500 lg:py-12 ${
                flash ? "border-brand-orange bg-brand-orange/20" : "border-white/15 bg-white/5"
              }`}>
                <p className="inline-block rounded-full bg-brand-orange px-6 py-1 text-2xl font-black text-white lg:text-3xl">الآن</p>
                <p className="mt-4 break-words text-6xl font-black leading-tight lg:text-[7.5rem]">{topCall.name}</p>
                {topCall.chair ? (
                  <p className="mt-4 text-4xl font-extrabold text-white/85 lg:text-6xl">
                    يرجى التوجّه إلى غرفة العلاج {topCall.chair}
                  </p>
                ) : (
                  <p className="mt-4 text-4xl font-extrabold text-white/85 lg:text-6xl">يرجى التوجّه إلى الاستقبال</p>
                )}
              </div>
            ) : (
              <div className="w-full rounded-[2.5rem] border-4 border-white/10 bg-white/5 px-8 py-10 text-center lg:py-14">
                <p className="text-4xl font-black lg:text-6xl">أهلًا بكم</p>
                <p className="mt-5 text-xl font-bold text-white/60 lg:text-3xl">
                  {stats && stats.waiting > 0
                    ? "سيُنادى على اسمكم عند جاهزية الكرسي"
                    : "لا يوجد انتظار الآن"}
                </p>
              </div>
            )}
          </div>

          {/*
            في الكراسي الآن + من نُودي عليهم قبل قليل — سطران صغيران يمنعان السؤال
            «وين فلان؟» بلا أن يزاحما بطاقة النداء على المساحة.
          */}
          <div className="flex flex-wrap items-center justify-center gap-3 text-center">
            {busyChairs.map((chair) => (
              <span key={chair.chair} className="rounded-2xl bg-white/10 px-4 py-2 text-xl font-extrabold text-white/80 lg:text-2xl">
                {chair.name} · كرسي {chair.chair}
              </span>
            ))}
            {previousCalls.map((entry, index) => (
              <span key={`${entry.at ?? "prev"}-${index}`} className="rounded-2xl bg-white/5 px-4 py-2 text-lg font-bold text-white/40 lg:text-xl">
                {entry.name}
                {entry.chair ? ` · كرسي ${entry.chair}` : ""}
              </span>
            ))}
          </div>
        </section>

        {/*
          القادمون — من وصل وينتظر دوره، ومواعيد اليوم التي لم تصل بعد. الدور كرقم
          وعبارة عربية يفهمها المريض: «أمامك مريضان» لا «7 دقائق» قد لا تصدق.
        */}
        <section className="flex min-h-0 flex-col rounded-[2rem] border border-white/10 bg-white/5 p-4 lg:col-span-2 lg:p-5">
          <h2 className="mb-3 flex shrink-0 items-center justify-between text-xl font-black text-white/80 lg:text-2xl">
            <span>القادمون</span>
            {stats ? <span className="text-base font-bold text-white/40">{stats.waiting} في الانتظار</span> : null}
          </h2>
          <div className="min-h-0 flex-1 space-y-2 overflow-hidden">
            {queue.length === 0 ? (
              <p className="rounded-2xl bg-white/5 px-4 py-6 text-center text-lg font-bold text-white/40">
                لا أحد ينتظر الآن
              </p>
            ) : (
              queue.map((entry, index) => (
                <div key={`${entry.name}-${entry.timeText}-${index}`} className="flex items-center gap-3 rounded-2xl bg-white/5 px-4 py-2.5 lg:py-3">
                  <span className="w-7 shrink-0 text-2xl font-black text-white/30 tabular-nums lg:w-8 lg:text-3xl">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-2xl font-extrabold lg:text-3xl">{entry.name}</p>
                    {entry.position ? (
                      <p className="text-sm font-bold text-brand-orange lg:text-base">{entry.position}</p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-left">
                    <p className="text-xl font-bold tabular-nums text-white/80 lg:text-2xl">{entry.timeText}</p>
                    <p className="text-xs font-bold text-white/45 lg:text-sm">
                      {entry.status === "arrived" ? "بانتظار النداء" : "بانتظار الدخول"}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      {/*
        شريط الأرقام — أعداد لا أسماء. بطاقة التقويم تُخفى تلقائيًا في يومٍ بلا
        جلسات تقويم، ومتوسط الانتظار يظهر «—» حين لا يوجد قياس بعد لا صفرًا كاذبًا.
      */}
      <section className="grid shrink-0 grid-cols-2 gap-3 border-t border-white/10 px-4 py-3 lg:grid-cols-4 lg:px-6">
        <div className="rounded-2xl bg-white/5 px-4 py-2.5 text-center">
          <p className="text-3xl font-black lg:text-4xl">{stats?.waiting ?? "—"}</p>
          <p className="text-sm font-bold text-white/50 lg:text-base">في الانتظار</p>
        </div>
        <div className="rounded-2xl bg-white/5 px-4 py-2.5 text-center">
          <p className="text-3xl font-black tabular-nums lg:text-4xl">
            {stats?.avgWaitMinutes != null ? `~${stats.avgWaitMinutes} د` : "—"}
          </p>
          <p className="text-sm font-bold text-white/50 lg:text-base">متوسط الانتظار اليوم</p>
        </div>
        {stats?.ortho ? (
          <div className="rounded-2xl bg-brand-orange/15 px-4 py-2.5 text-center">
            <p className="text-3xl font-black tabular-nums text-brand-orange lg:text-4xl">{stats.ortho.total}</p>
            <p className="text-sm font-bold text-white/50 lg:text-base">
              جلسات تقويم اليوم · تم {stats.ortho.done} · ينتظرون {stats.ortho.waiting} · قادمون {stats.ortho.upcoming}
            </p>
          </div>
        ) : (
          <div className="rounded-2xl bg-white/5 px-4 py-2.5 text-center">
            <p className="text-3xl font-black lg:text-4xl">{stats?.inTreatment ?? "—"}</p>
            <p className="text-sm font-bold text-white/50 lg:text-base">في العلاج الآن</p>
          </div>
        )}
        <div className="rounded-2xl bg-white/5 px-4 py-2.5 text-center">
          <p className="text-3xl font-black lg:text-4xl">{stats?.done ?? "—"}</p>
          <p className="text-sm font-bold text-white/50 lg:text-base">أُنجز اليوم</p>
        </div>
      </section>

      {/*
        الثلث الأدنى — رسالة توعوية واحدة تتناوب بهدوء كل ربع دقيقة، والشعار
        الثابت تحتها. لا فيديو ولا صوت مستمر: هدوءٌ يُحترم لا ضجيج يُطرد.
      */}
      <footer className="shrink-0 border-t border-white/10 px-6 py-3 lg:px-8 lg:py-4">
        {announcement ? (
          <div key={announcementIndex} className="display-fade text-center">
            <p className="text-lg font-black text-brand-orange lg:text-2xl">{announcement.title}</p>
            <p className="mt-0.5 text-base font-bold text-white/70 lg:text-xl">{announcement.body}</p>
          </div>
        ) : null}
        <p className="mt-2 text-center text-sm font-bold text-white/35 lg:text-lg">{feed?.tagline ?? ""}</p>
      </footer>
    </div>
  );
}
