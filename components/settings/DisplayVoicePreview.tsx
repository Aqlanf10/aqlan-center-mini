"use client";
import { useEffect, useRef, useState } from "react";
import { createDisplaySpeaker, displaySpeechOptions, displayVoiceStatus, localArabicVoices, selectDisplayVoice } from "@/lib/display-speech";

export function DisplayVoicePreview({ values, onVoiceChange }: { values: Record<string, string>; onVoiceChange?: (value: string) => void }) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const speaker = useRef<ReturnType<typeof createDisplaySpeaker> | null>(null);
  const options = displaySpeechOptions(values);
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    speaker.current = createDisplaySpeaker(synth);
    const load = () => { speaker.current?.cancel(); setVoices(localArabicVoices(synth.getVoices())); };
    load(); synth.addEventListener?.("voiceschanged", load);
    return () => { speaker.current?.cancel(); speaker.current = null; synth.removeEventListener?.("voiceschanged", load); };
  }, []);
  useEffect(() => { speaker.current?.cancel(); }, [options.voiceURI, options.rate, options.pauseMs]);
  const selected = selectDisplayVoice(voices, options.voiceURI);
  return <div className="mt-3 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
    {onVoiceChange ? <select aria-label="الصوت العربي المحلي" className="w-full rounded-lg border border-slate-300 p-2" value={options.voiceURI} onChange={event => onVoiceChange(event.target.value)}>
      <option value="">تلقائي — صوت عربي محلي</option>
      {options.voiceURI && !voices.some(voice => voice.voiceURI === options.voiceURI) ? <option value={options.voiceURI}>الصوت المحفوظ غير متاح على هذا الجهاز</option> : null}
      {voices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}
    </select> : null}
    <p>الإعداد مركزي لشاشة الصالة العامة وصوتها. تختلف الأصوات بين الأجهزة؛ اختبر جهاز الصالة أيضًا. لا تُرسل الأسماء إلى خدمة نطق جديدة.</p>
    {selected.status !== "ready" ? <p role="status" className="text-amber-800">{displayVoiceStatus(selected.status)}</p> : <p>الصوت على هذا الجهاز: {selected.voice?.name}</p>}
    <button type="button" disabled={!selected.voice} onClick={() => speaker.current?.speak("أحمد", 2, options)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-bold disabled:opacity-50">تجربة الصوت قبل الحفظ</button>
    <p className="text-slate-500">نص اصطناعي: أحمد، يرجى التوجه إلى غرفة العلاج رقم ٢. التجربة لا تحفظ الإعداد.</p>
  </div>;
}
