import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { baseUrl } from "./_server";

// Real built display, synthetic public feed and browser audio devices only.
type DeviceVoice = { lang: string; localService: boolean; voiceURI: string };
type Call = { at: string; chair: number; name: string; speechName: string };
type AudioEvidence = {
  toneStarts: number;
  utterances: { text: string; voiceURI: string | null; lang: string }[];
  voiceReads: number;
};
type FixtureWindow = Window & {
  __roomAudio: AudioEvidence;
  __roomSetVoices: (voices: DeviceVoice[]) => void;
};
const localArabic: DeviceVoice = { lang: "ar-YE", localService: true, voiceURI: "synthetic-local-ar" };
const remoteArabic: DeviceVoice = { lang: "ar-SA", localService: false, voiceURI: "synthetic-remote-ar" };
const localEnglish: DeviceVoice = { lang: "en-US", localService: true, voiceURI: "synthetic-local-en" };
const old = { at: "2026-01-01T09:00:00Z", chair: 1, name: "السابق التجريبي", speechName: "السابق" };
const fresh = { at: "2026-01-01T09:01:00Z", chair: 2, name: "الجديد التجريبي", speechName: "الجديد" };
const next = { ...fresh, at: "2026-01-01T09:02:00Z", name: "اللاحق التجريبي", speechName: "اللاحق" };
const sound = "تشغيل صوت النداء";
let browser: Browser;

beforeAll(async () => {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") {
    throw new Error("Waiting-room browser witness requires a loopback built-app harness");
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
});
afterAll(async () => { await browser?.close(); });

function installSyntheticAudio(initialVoices: DeviceVoice[]) {
  const win = window as unknown as FixtureWindow;
  let voices = initialVoices;
  const events = new EventTarget();
  const evidence: AudioEvidence = { toneStarts: 0, utterances: [], voiceReads: 0 };
  win.__roomAudio = evidence;
  win.__roomSetVoices = (updated) => {
    voices = updated;
    events.dispatchEvent(new Event("voiceschanged"));
  };
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: class {
      currentTime = 0;
      destination = {};
      resume() { return Promise.resolve(); }
      createOscillator() {
        return {
          type: "",
          frequency: { value: 0 },
          start() { evidence.toneStarts++; },
          stop() {},
          connect<T>(target: T) { return target; },
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect<T>(target: T) { return target; },
        };
      }
    },
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices() { evidence.voiceReads++; return voices; },
      cancel() {},
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      speak(utterance: SpeechSynthesisUtterance) {
        evidence.utterances.push({
          text: utterance.text, voiceURI: utterance.voice?.voiceURI ?? null, lang: utterance.lang,
        });
      },
    },
  });
  // Native implementations accept only native SpeechSynthesisVoice instances;
  // keep the utterance constructor at the same synthetic device boundary.
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    configurable: true,
    value: class { constructor(public readonly text: string) {} },
  });
}

async function settle(page: Page) {
  // The marker observes a committed React render, then let passive effects run.
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}
const audio = (page: Page) => page.evaluate(() => (window as unknown as FixtureWindow).__roomAudio);
const renderCall = (page: Page, call: Call) => page.getByText(call.name, { exact: true }).waitFor({ state: "visible" });
async function enableSound(page: Page) {
  const button = page.getByRole("button", { name: sound, exact: true });
  await button.click();
  await button.waitFor({ state: "hidden" });
  await settle(page);
}
const counts = async (page: Page) => {
  const { toneStarts, utterances } = await audio(page);
  return [toneStarts, utterances.length];
};

async function withDisplay(
  initialCall: Call | null,
  voices: DeviceVoice[],
  run: (page: Page, publish: (call: Call | null, voice?: boolean) => Promise<void>) => Promise<void>,
) {
  const context = await browser.newContext({ locale: "ar-YE", serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.addInitScript(installSyntheticAudio, voices);
    await page.clock.install();
    let edition = 0;
    let clockMs = Date.parse("2026-01-01T09:00:30Z");
    const fixture = (call: Call | null, voice: boolean, nowIso: string) => ({
      now: nowIso, called: call ? [call] : [],
      delayNotice: false, voice, speech: { voiceURI: "", rate: 0.9, pauseMs: 300 },
      announcements: [], welcomeText: `شاشة اختبار رقم ${++edition}`, tagline: "",
    });
    let feed = fixture(initialCall, true, new Date(clockMs).toISOString());
    await page.route(url => url.origin === baseUrl && url.pathname === "/api/display", route =>
      route.fulfill({ json: feed, headers: { "cache-control": "no-store" } }));
    const loaded = async () => {
      await page.getByRole("heading", { name: feed.welcomeText, exact: true }).waitFor({ state: "visible" });
      await settle(page);
    };
    const response = await page.goto(`${baseUrl}/display`);
    expect(response?.status()).toBe(200);
    await loaded();
    await run(page, async (call, voice = true) => {
      const callMs = call?.at ? Date.parse(call.at) : 0;
      clockMs = Math.max(clockMs + 1_000, callMs + 1_000);
      feed = fixture(call, voice, new Date(clockMs).toISOString());
      await page.clock.fastForward(4_001);
      await loaded();
    });
  } finally {
    await context.close();
  }
}

it("alerts once on the first fresh call after an empty successful feed", async () => {
  await withDisplay(null, [remoteArabic, localEnglish, localArabic], async (page, publish) => {
    await page.getByText("يرجى انتظار النداء", { exact: true }).waitFor({ state: "visible" });
    for (const metric of ["في الانتظار", "متوسط الانتظار اليوم", "في العلاج الآن", "أُنجز اليوم", "جلسات تقويم اليوم"]) {
      expect(await page.getByText(metric, { exact: metric !== "جلسات تقويم اليوم" }).count()).toBe(0);
    }
    await enableSound(page);
    expect(await counts(page)).toEqual([0, 0]);
    await publish(fresh);
    await renderCall(page, fresh);
    // One actual chime comprises two oscillator starts.
    await expect.poll(() => counts(page)).toEqual([2, 1]);
    expect((await audio(page)).utterances).toEqual([{
      text: fresh.speechName,
      voiceURI: localArabic.voiceURI, lang: localArabic.lang,
    }]);
    await publish(fresh);
    expect(await counts(page)).toEqual([2, 1]);
  });
});

it("displays the preexisting first call silently, including when sound is primed", async () => {
  await withDisplay(old, [localArabic], async (page, publish) => {
    await renderCall(page, old);
    await enableSound(page);
    await publish(old);
    expect(await counts(page)).toEqual([0, 0]);
    await publish(fresh);
    await renderCall(page, fresh);
    await expect.poll(() => counts(page)).toEqual([2, 1]);
  });
});

it("keeps speech mute separate from chime and does not replay when speech is enabled", async () => {
  await withDisplay(null, [localArabic], async (page, publish) => {
    await enableSound(page);
    await publish(fresh, false);
    await renderCall(page, fresh);
    await expect.poll(() => counts(page)).toEqual([2, 0]);
    await publish(fresh, true);
    expect(await counts(page)).toEqual([2, 0]);
    await publish(next);
    await renderCall(page, next);
    await expect.poll(() => counts(page)).toEqual([4, 1]);
  });
});

it("shows the call and chimes with only remote Arabic or non-Arabic local voices", async () => {
  await withDisplay(null, [remoteArabic, localEnglish], async (page, publish) => {
    await enableSound(page);
    await publish(fresh);
    await renderCall(page, fresh);
    await expect.poll(() => counts(page)).toEqual([2, 0]);
    await publish(fresh);
    expect(await counts(page)).toEqual([2, 0]);
  });
});

it("uses a late local voice only for a subsequent fresh call, not a replay", async () => {
  await withDisplay(null, [], async (page, publish) => {
    await enableSound(page);
    await publish(fresh);
    await renderCall(page, fresh);
    await expect.poll(() => counts(page)).toEqual([2, 0]);
    const prior = (await audio(page)).voiceReads;
    await page.evaluate((voice) => (window as unknown as FixtureWindow).__roomSetVoices([voice]), localArabic);
    await expect.poll(async () => (await audio(page)).voiceReads).toBeGreaterThan(prior);
    await publish(fresh);
    expect(await counts(page)).toEqual([2, 0]);
    await publish(next);
    await renderCall(page, next);
    await expect.poll(() => counts(page)).toEqual([4, 1]);
    expect((await audio(page)).utterances[0]?.text).toContain(next.speechName);
  });
});
