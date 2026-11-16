import { afterEach, describe, expect, it, vi } from "vitest";
import { createDisplaySpeaker, displayCallPhrases, displaySpeechOptions, localArabicVoices, normalizeArabicCall, selectDisplayVoice } from "../lib/display-speech";
import { parsePublicDisplayFeed } from "../lib/display-feed";
import { projectWaitingRoomDisplay } from "../lib/waiting-room";
import { SETTING_DEFAULTS } from "../lib/settings";
import { validateTypedSetting } from "../lib/settings-validate";
const voice = (name: string, lang = "ar-SA", localService = true): SpeechSynthesisVoice => ({ name, voiceURI: name, lang, localService, default: false });
const naayf = voice("Microsoft Naayf - Arabic (Saudi)");
afterEach(() => vi.useRealTimers());
describe("local Arabic device voices", () => {
  it("selects the saved Windows Arabic voice when the browser actually exposes it", () => expect(selectDisplayVoice([voice("English", "en-US"), naayf], naayf.voiceURI)).toEqual({ voice: naayf, status: "ready" }));
  it("uses an explicitly reported local Arabic fallback on a different device", () => expect(selectDisplayVoice([voice("Other Arabic", "ar-YE")], naayf.voiceURI)).toMatchObject({ voice: { name: "Other Arabic" }, status: "fallback" }));
  it("never chooses English, a language prefix collision, or remote Arabic", () => expect(localArabicVoices([voice("English", "en"), voice("bad", "arn"), voice("Remote", "ar-SA", false)])).toEqual([]));
  it("accepts Arabic locale variants and no foreign fallback when empty", () => {
    expect(localArabicVoices([voice("a", "AR_sa"), voice("b", "ar")])).toHaveLength(2);
    expect(selectDisplayVoice([], "saved")).toEqual({ voice: null, status: "missing" });
  });
  it("preserves Arabic letters/diacritics, conservatively removes controls and normalizes whitespace", () => expect(normalizeArabicCall("  أَحْمَد\u0640\u200f\n  عليّ  ")).toBe("أَحْمَد عليّ"));
  it("removes tatweel inside a name without splitting its letters", () => expect(normalizeArabicCall("أحـمد")).toBe("أحمد"));
  it("separates the public name from the destination, with Arabic digits", () => {
    expect(displayCallPhrases(" أحمد ", 12)).toEqual(["أحمد", "يرجى التوجه إلى غرفة العلاج رقم ١٢"]);
    expect(displayCallPhrases("أحمد", null)[1]).toBe("يرجى التوجه إلى الاستقبال");
  });
  it.each(["NaN", "Infinity", "0.2", "5"])("bounds malformed stored rate %s", rate => expect(displaySpeechOptions({ "display.voice_rate": rate }).rate).toBe(0.9));
  it("bounds invalid pauses and keeps a valid central rate", () => expect(displaySpeechOptions({ "display.voice_rate": "0.8", "display.voice_pause_ms": "3.5" })).toMatchObject({ rate: 0.8, pauseMs: 300 }));
  it("waits until end plus the configured pause; cancelling invalidates late callbacks", () => {
    vi.useFakeTimers(); const spoken: SpeechSynthesisUtterance[] = [];
    const synth = { getVoices: () => [naayf], speak: (u: SpeechSynthesisUtterance) => spoken.push(u), cancel: vi.fn() } as unknown as SpeechSynthesis;
    const speaker = createDisplaySpeaker(synth, text => ({ text } as SpeechSynthesisUtterance));
    speaker.speak("أحمد", 2, { voiceURI: naayf.voiceURI, rate: 0.8, pauseMs: 400 });
    expect(spoken).toHaveLength(1); expect(spoken[0]).toMatchObject({ text: "أحمد", voice: naayf, lang: "ar-SA", rate: 0.8 });
    spoken[0].onend?.call(spoken[0], {} as SpeechSynthesisEvent); vi.advanceTimersByTime(399); expect(spoken).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(spoken).toHaveLength(2);
    speaker.cancel(); spoken[1].onend?.call(spoken[1], {} as SpeechSynthesisEvent); vi.runAllTimers(); expect(spoken).toHaveLength(2);
  });
  it("late voices support future calls only; newer calls cancel the older sequence", () => {
    vi.useFakeTimers(); let voices: SpeechSynthesisVoice[] = []; const spoken: SpeechSynthesisUtterance[] = [];
    const synth = { getVoices: () => voices, speak: (u: SpeechSynthesisUtterance) => spoken.push(u), cancel: vi.fn() } as unknown as SpeechSynthesis;
    const speaker = createDisplaySpeaker(synth, text => ({ text } as SpeechSynthesisUtterance)); const options = displaySpeechOptions({});
    expect(speaker.speak("أحمد", 1, options)).toBe("missing"); expect(spoken).toHaveLength(0);
    voices = [naayf]; speaker.speak("علي", 2, options); speaker.speak("سارة", 3, options);
    spoken[0].onend?.call(spoken[0], {} as SpeechSynthesisEvent); vi.runAllTimers(); expect(spoken.map(u => u.text)).toEqual(["علي", "سارة"]);
  });
});
describe("public projection and central validation", () => {
  const project = (privacy = "first_initial") => projectWaitingRoomDisplay({ now: new Date("2026-10-30T12:00:00Z"), calls: [{ patientName: "أحمد المخفي", calledAt: null, chair: 1 }, { patientName: "اسم سابق", calledAt: null, chair: 2 }], settings: { ...SETTING_DEFAULTS, "display.privacy_mode": privacy }, announcements: [{ title: "عام", body: "نص عام" }] });
  it("only returns the current masked call and derives speech from its public name", () => {
    expect(project().called).toEqual([{ at: null, chair: 1, name: "أحمد م.", speechName: "أحمد" }]);
    expect(project("first_only").called[0].name).toBe("أحمد"); expect(parsePublicDisplayFeed(project())).toEqual(project());
  });
  it("rejects rich old feeds and hidden voice text", () => {
    expect(() => parsePublicDisplayFeed({ ...project(), stats: { done: 8 } })).toThrow();
    expect(() => parsePublicDisplayFeed({ ...project(), called: [{ ...project().called[0], speechName: "أحمد المخفي" }] })).toThrow();
  });
  it.each([["display.voice_rate", "0.6"], ["display.voice_rate", "1.2"], ["display.voice_pause_ms", "1001"], ["display.voice_pause_ms", "1.5"], ["display.voice_uri", "x".repeat(257)]])("refuses invalid central %s", (key, value) => expect(validateTypedSetting(key, value)).not.toBeNull());
  it.each([["display.voice_rate", "0.7"], ["display.voice_rate", "1.1"], ["display.voice_pause_ms", "0"], ["display.voice_pause_ms", "1000"], ["display.voice_uri", naayf.voiceURI]])("accepts bounded central %s", (key, value) => expect(validateTypedSetting(key, value)).toBeNull());
});
