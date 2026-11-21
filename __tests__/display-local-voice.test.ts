import { expect, it, vi } from "vitest";
import { findLocalArabicDisplayVoice, speakDisplayCallOnDevice } from "../lib/display-local-voice";

function voice(lang: string, localService: boolean): SpeechSynthesisVoice {
  return { lang, localService, default: false, name: "Synthetic voice", voiceURI: lang };
}
const remoteArabic = voice("ar-SA", false);
const localEnglish = voice("en-US", true);
const localArabic = voice("AR-ye", true);
const makeUtterance = () => vi.fn((text: string) => ({ text }) as SpeechSynthesisUtterance);

it("keeps the first eligible local Arabic voice instead of a system default", () => {
  expect(findLocalArabicDisplayVoice([
    remoteArabic, localEnglish, voice("arg", true), localArabic, voice("ar-EG", true),
  ])).toBe(localArabic);
});

it.each([{ voices: [] }, { voices: [remoteArabic, localEnglish] }])("does not construct or dispatch speech without a local Arabic voice (%j)", ({ voices }) => {
  const synthesis = { getVoices: () => voices, cancel: vi.fn(), speak: vi.fn() };
  const make = makeUtterance();
  expect(speakDisplayCallOnDevice(synthesis, "Synthetic call", make)).toBe(false);
  expect(make).not.toHaveBeenCalled();
  expect(synthesis.cancel).not.toHaveBeenCalled();
  expect(synthesis.speak).not.toHaveBeenCalled();
});

it("uses voices that become available only on the next explicit call and never retains the earlier text", () => {
  let voices: SpeechSynthesisVoice[] = [];
  const synthesis = { getVoices: () => voices, cancel: vi.fn(), speak: vi.fn() };
  const make = makeUtterance();
  expect(speakDisplayCallOnDevice(synthesis, "نداء تجريبي سابق", make)).toBe(false);
  voices = [remoteArabic, localArabic];
  expect(synthesis.speak).not.toHaveBeenCalled();
  expect(speakDisplayCallOnDevice(synthesis, "نداء تجريبي جديد", make)).toBe(true);
  expect(synthesis.speak).toHaveBeenCalledTimes(1);
  expect(synthesis.speak).toHaveBeenCalledWith({
    text: "نداء تجريبي جديد", voice: localArabic, lang: localArabic.lang, rate: 0.95,
  });
});

it("leaves the ordinary display usable if the device speech engine throws", () => {
  const synthesis = {
    getVoices: () => [localArabic],
    cancel: vi.fn(),
    speak: vi.fn(() => { throw new Error("Synthetic device unavailable"); }),
  };
  expect(speakDisplayCallOnDevice(synthesis, "Synthetic call", makeUtterance())).toBe(false);
});
