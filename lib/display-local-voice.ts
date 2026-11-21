/** Use only a voice the browser reports as both Arabic and on-device.
 * Do not pass call text to a browser default or network voice. */
export function findLocalArabicDisplayVoice<
  T extends Pick<SpeechSynthesisVoice, "lang" | "localService">,
>(voices: readonly T[]): T | undefined {
  return voices.find(voice => voice.localService === true && /^ar(?:[-_]|$)/i.test(voice.lang));
}

/** Synchronous: an unavailable voice does not queue text for a future call. */
export function speakDisplayCallOnDevice(
  synthesis: Pick<SpeechSynthesis, "getVoices" | "cancel" | "speak">,
  text: string,
  makeUtterance: (text: string) => SpeechSynthesisUtterance,
): boolean {
  try {
    const voice = findLocalArabicDisplayVoice(synthesis.getVoices());
    if (!voice) return false;
    const utterance = makeUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = 0.95;
    synthesis.cancel();
    synthesis.speak(utterance);
    return true;
  } catch {
    // Visual call and its separate chime remain available.
    return false;
  }
}
