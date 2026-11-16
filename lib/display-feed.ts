import type { PublicDisplayFeed } from "./waiting-room";
/** Defence in depth at the TV: malformed/old rich responses clear the display. */
export function parsePublicDisplayFeed(value: unknown): PublicDisplayFeed {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join("|") === expected.sort().join("|");
  const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
  if (!record(value) || !keys(value, ["now", "called", "delayNotice", "voice", "speech", "announcements", "welcomeText", "tagline"]) ||
      !text(value.now, 40) || !Number.isFinite(Date.parse(value.now)) || typeof value.delayNotice !== "boolean" || typeof value.voice !== "boolean" ||
      !text(value.welcomeText, 500) || !text(value.tagline, 500) || !Array.isArray(value.called) || value.called.length > 1 ||
      !Array.isArray(value.announcements) || !record(value.speech) || !keys(value.speech, ["voiceURI", "rate", "pauseMs"]) ||
      !text(value.speech.voiceURI, 256) || typeof value.speech.rate !== "number" || value.speech.rate < 0.7 || value.speech.rate > 1.1 ||
      typeof value.speech.pauseMs !== "number" || !Number.isInteger(value.speech.pauseMs) || value.speech.pauseMs < 0 || value.speech.pauseMs > 1000 ||
      !value.called.every(call => record(call) && keys(call, ["at", "name", "speechName", "chair"]) &&
        (call.at === null || (text(call.at, 40) && Number.isFinite(Date.parse(call.at)))) && text(call.name, 500) && text(call.speechName, 500) &&
        call.speechName === call.name.trim().split(/\s+/)[0] && (call.chair === null || (Number.isInteger(call.chair) && Number(call.chair) > 0 && Number(call.chair) <= 20))) ||
      !value.announcements.every(item => record(item) && keys(item, ["title", "body"]) && text(item.title, 500) && text(item.body, 2000))) {
    throw new Error("INVALID_PUBLIC_DISPLAY_FEED");
  }
  return value as unknown as PublicDisplayFeed;
}
