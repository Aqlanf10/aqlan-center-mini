"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Logo } from "@/components/Icon";
import { InstallApp } from "@/components/InstallApp";
import { parsePublicDisplayFeed } from "@/lib/display-feed";
import { createDisplaySpeaker, displayVoiceStatus, selectDisplayVoice } from "@/lib/display-speech";
import type { PublicDisplayFeed } from "@/lib/waiting-room";

const REFRESH_MS = 4_000;
const REQUEST_TIMEOUT_MS = 8_000;
const ANNOUNCE_MS = 15_000;

/** Public call only. A failed/overdue refresh clears names and cancels speech. */
export default function DisplayScreen() {
  const [feed, setFeed] = useState<PublicDisplayFeed | null>(null);
  const [stale, setStale] = useState(false);
  const [clock, setClock] = useState("");
  const [dateLine, setDateLine] = useState("");
  const [soundOn, setSoundOn] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [flash, setFlash] = useState(false);
  const [announcementIndex, setAnnouncementIndex] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [checkinQr, setCheckinQr] = useState("");
  const audioRef = useRef<AudioContext | null>(null);
  const soundRef = useRef(false);
  const speakerRef = useRef<ReturnType<typeof createDisplaySpeaker> | null>(null);
  const feedRef = useRef<PublicDisplayFeed | null>(null);
  const lastCallRef = useRef<string | null>(null);
  const baselineRef = useRef(true);
  const flashRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wakeRef = useRef<{ release: () => Promise<void> } | null>(null);

  useEffect(() => {
    void QRCode.toDataURL(`${window.location.origin}/checkin`, { margin: 1, width: 140, color: { dark: "#0f172a", light: "#ffffff" } }).then(setCheckinQr).catch(() => {});
  }, []);
  const chime = useCallback(() => {
    const context = audioRef.current;
    if (!context || !soundRef.current) return;
    const now = context.currentTime;
    [0, 0.22].forEach((offset, index) => {
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.type = "sine"; oscillator.frequency.value = index === 0 ? 880 : 1174;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2);
      oscillator.connect(gain).connect(context.destination); oscillator.start(now + offset); oscillator.stop(now + offset + 0.22);
    });
  }, []);
  const updateVoiceStatus = useCallback(() => {
    const current = feedRef.current;
    setVoiceStatus(!current?.voice ? "" : displayVoiceStatus(selectDisplayVoice(
      "speechSynthesis" in window ? window.speechSynthesis.getVoices() : [], current.speech.voiceURI).status));
  }, []);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    speakerRef.current = createDisplaySpeaker(synth);
    const changed = () => { speakerRef.current?.cancel(); updateVoiceStatus(); };
    updateVoiceStatus(); synth.addEventListener?.("voiceschanged", changed);
    return () => { speakerRef.current?.cancel(); synth.removeEventListener?.("voiceschanged", changed); };
  }, [updateVoiceStatus]);
  const enableSound = useCallback(() => {
    soundRef.current = true; setSoundOn(true); updateVoiceStatus();
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) { audioRef.current ??= new Ctor(); void audioRef.current.resume(); }
      const wake = (navigator as unknown as { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      void wake?.request("screen").then(lock => { wakeRef.current = lock; }).catch(() => {});
    } catch { /* Speech and the visible call still work if the chime is unsupported. */ }
  }, [updateVoiceStatus]);
  const toggleFullscreen = useCallback(() => {
    try { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void document.documentElement.requestFullscreen().catch(() => {});
    } catch { /* Optional TV control. */ }
  }, []);
  useEffect(() => {
    const changed = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  useEffect(() => {
    let disposed = false, active: AbortController | null = null;
    const clear = () => {
      baselineRef.current = true; feedRef.current = null; setFeed(null); setStale(true); setFlash(false);
      clearTimeout(flashRef.current); speakerRef.current?.cancel(); setVoiceStatus("");
    };
    const load = async () => {
      if (active || disposed || document.visibilityState === "hidden") return;
      const controller = new AbortController(); active = controller;
      const timeout = setTimeout(() => { controller.abort(); if (!disposed) clear(); }, REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch("/api/display", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("display unavailable");
        const next = parsePublicDisplayFeed(await response.json());
        if (disposed || controller.signal.aborted) return;
        const call = next.called[0], previous = feedRef.current;
        const key = call ? `${call.at ?? ""}|${call.chair ?? ""}` : null;
        const speechChanged = previous && (previous.voice !== next.voice || JSON.stringify(previous.speech) !== JSON.stringify(next.speech) || previous.called[0]?.speechName !== call?.speechName);
        if (speechChanged || !call) speakerRef.current?.cancel();
        if (!baselineRef.current && key && key !== lastCallRef.current && call) {
          clearTimeout(flashRef.current); setFlash(true); flashRef.current = setTimeout(() => setFlash(false), 30_000);
          chime();
          if (soundRef.current && next.voice) speakerRef.current?.speak(call.speechName, call.chair, next.speech);
        }
        // First connection/reconnection establishes a baseline, never replays a missed call.
        baselineRef.current = false;
        if (key) lastCallRef.current = key;
        feedRef.current = next; setFeed(next); setStale(false); updateVoiceStatus();
      } catch { if (!disposed) clear(); }
      finally { clearTimeout(timeout); if (active === controller) active = null; }
    };
    void load(); const poll = setInterval(() => { void load(); }, REFRESH_MS);
    const visible = () => {
      if (document.visibilityState === "hidden") { active?.abort(); clear(); }
      else void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; active?.abort(); clearInterval(poll); clearTimeout(flashRef.current); speakerRef.current?.cancel(); document.removeEventListener("visibilitychange", visible); };
  }, [chime, updateVoiceStatus]);
  useEffect(() => () => { void audioRef.current?.close(); void wakeRef.current?.release(); }, []);
  useEffect(() => {
    const time = new Intl.DateTimeFormat("ar-YE-u-nu-latn", { hour: "2-digit", minute: "2-digit", hour12: true });
    const date = new Intl.DateTimeFormat("ar-YE-u-nu-latn", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const tick = () => { const now = new Date(); setClock(time.format(now)); setDateLine(date.format(now)); };
    tick(); const timer = setInterval(tick, 30_000); return () => clearInterval(timer);
  }, []);
  const announcements = feed?.announcements ?? [];
  useEffect(() => {
    if (announcements.length <= 1) return;
    const timer = setInterval(() => setAnnouncementIndex(current => (current + 1) % announcements.length), ANNOUNCE_MS);
    return () => clearInterval(timer);
  }, [announcements.length]);
  const announcement = announcements.length ? announcements[announcementIndex % announcements.length]! : null;
  const topCall = feed?.called[0] ?? null;
  return (
    <div data-testid="public-display" className="fixed inset-0 flex flex-col bg-navy-900 text-white">
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
          {checkinQr ? (
            <div className="hidden md:flex items-center gap-2.5 rounded-2xl border border-white/15 bg-white/10 px-3 py-1.5 backdrop-blur-xs">
              <img src={checkinQr} alt="QR Code" className="h-10 w-10 rounded-lg bg-white p-0.5 shadow-xs" />
              <div className="text-right">
                <p className="text-xs font-black text-white">تسجيل الوصول الذاتي</p>
                <p className="text-[10px] font-bold text-brand-orange">امسح بهاتفك لتأكيد دورك</p>
              </div>
            </div>
          ) : null}
          {stale ? (
            <span className="rounded-full bg-amber-400/20 px-3 py-1 text-sm font-bold text-amber-300">
              يُعاد الاتصال…
            </span>
          ) : null}
          {/* (INSTALL-1) تثبيت «شاشة الصالة» تطبيقًا على التلفاز أو جهازه: يُفتح بملء الشاشة بلا رابط. */}
          <InstallApp tone="dark" label="ثبّت شاشة الصالة" installedText="ثُبّتت شاشة الصالة — افتحها من أيقونتها." />
          {/* ملء الشاشة ظاهرٌ على كل عرض: متصفحات التلفاز كثيرًا ما تُبلغ عرضًا أصغر من شاشات الكمبيوتر،
              وكان الزر مخفيًّا فيها — وهو ما يُخفي الرابط حين لا يمكن التثبيت. */}
          <button
            onClick={toggleFullscreen}
            className="rounded-xl bg-white/10 px-3 py-2 text-sm font-bold text-white/70"
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

      {soundOn && voiceStatus ? <p role="status" className="px-6 py-1 text-center text-xs text-amber-200">{voiceStatus}</p> : null}
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-6 lg:px-16">
        <section className={`w-full max-w-6xl rounded-[2.5rem] border-4 px-8 py-10 text-center transition-colors duration-500 lg:py-16 ${flash ? "border-brand-orange bg-brand-orange/20" : "border-white/15 bg-white/5"}`}>
          {topCall ? <div data-testid="current-call">
            <p className="inline-block rounded-full bg-brand-orange px-6 py-1 text-2xl font-black lg:text-3xl">الآن</p>
            <p className="mt-4 break-words text-6xl font-black leading-tight lg:text-[7.5rem]">{topCall.name}</p>
            <p className="mt-6 text-3xl font-extrabold text-white/85 lg:text-5xl">{topCall.chair ? `يرجى التوجّه إلى غرفة العلاج ${topCall.chair}` : "يرجى التوجّه إلى الاستقبال"}</p>
          </div> : <>
            <p className="text-4xl font-black lg:text-6xl">أهلًا بكم</p>
            <p className="mt-6 text-xl font-bold text-white/60 lg:text-3xl">يرجى انتظار النداء</p>
          </>}
        </section>
      </main>
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
