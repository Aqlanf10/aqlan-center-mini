/** Local-device speech only. No remote synthesis and no foreign-language fallback. */
export interface DisplaySpeechOptions { voiceURI: string; rate: number; pauseMs: number }
export const DISPLAY_SPEECH_DEFAULTS: DisplaySpeechOptions = { voiceURI: "", rate: 0.9, pauseMs: 300 };
export function displaySpeechOptions(settings: Record<string, string | undefined>): DisplaySpeechOptions {
  const rate = Number(settings["display.voice_rate"] ?? "0.9");
  const pause = Number(settings["display.voice_pause_ms"] ?? "300");
  return {
    voiceURI: (settings["display.voice_uri"] ?? "").slice(0, 256),
    rate: Number.isFinite(rate) && rate >= 0.7 && rate <= 1.1 ? rate : 0.9,
    pauseMs: Number.isInteger(pause) && pause >= 0 && pause <= 1000 ? pause : 300,
  };
}
export function localArabicVoices<T extends Pick<SpeechSynthesisVoice, "lang" | "localService">>(voices: readonly T[]): T[] {
  return voices.filter(voice => voice.localService === true && /^ar(?:[-_]|$)/i.test(voice.lang));
}
export function selectDisplayVoice(voices: readonly SpeechSynthesisVoice[], preferred: string) {
  const arabic = localArabicVoices(voices);
  const exact = preferred ? arabic.find(voice => voice.voiceURI === preferred) : undefined;
  const voice = exact ?? arabic.find(item => item.default) ?? arabic[0] ?? null;
  return { voice, status: !voice ? "missing" as const : preferred && !exact ? "fallback" as const : "ready" as const };
}
export function displayVoiceStatus(status: "missing" | "fallback" | "ready"): string {
  return status === "missing" ? "لا يوجد صوت عربي محلي على هذا الجهاز؛ يعمل جرس النداء فقط."
    : status === "fallback" ? "الصوت المحفوظ غير متاح هنا؛ يُستخدم صوت عربي محلي بديل." : "";
}
/** Preserve letters/diacritics and names; remove only controls/tatweel and excess whitespace. */
export function normalizeArabicCall(text: string): string {
  // Intentionally remove control characters from public speech, not Arabic letters.
  // eslint-disable-next-line no-control-regex
  return text.normalize("NFC").replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\u0640]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
export function displayCallPhrases(publicName: string, chair: number | null): string[] {
  const number = chair !== null && Number.isInteger(chair) && chair > 0 ? String(chair).replace(/\d/g, d => "٠١٢٣٤٥٦٧٨٩"[Number(d)]!) : null;
  return [normalizeArabicCall(publicName), number ? `يرجى التوجه إلى غرفة العلاج رقم ${number}` : "يرجى التوجه إلى الاستقبال"].filter(Boolean);
}

/** One cancellable sequence. Late onend callbacks cannot restart a cancelled call. */
export function createDisplaySpeaker(synth: SpeechSynthesis, makeUtterance = (text: string) => new SpeechSynthesisUtterance(text)) {
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { epoch++; clearTimeout(timer); try { synth.cancel(); } catch { /* Device failure must not hide the visual call. */ } };
  const speak = (publicName: string, chair: number | null, options: DisplaySpeechOptions) => {
    cancel();
    const selected = selectDisplayVoice(synth.getVoices(), options.voiceURI);
    if (!selected.voice) return selected.status;
    const voice = selected.voice, current = epoch, phrases = displayCallPhrases(publicName, chair);
    const next = (index: number) => {
      if (current !== epoch || !phrases[index]) return;
      const utterance = makeUtterance(phrases[index]);
      utterance.voice = voice; utterance.lang = voice.lang; utterance.rate = options.rate;
      utterance.onend = () => { if (current === epoch) timer = setTimeout(() => next(index + 1), options.pauseMs); };
      utterance.onerror = () => { if (current === epoch) cancel(); };
      try { synth.speak(utterance); } catch { cancel(); }
    };
    next(0);
    return selected.status;
  };
  return { cancel, speak };
}
