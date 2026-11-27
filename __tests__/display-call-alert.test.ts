import { describe, expect, it } from "vitest";
import { readDisplayCallAlert, type DisplayCallCursor } from "../lib/display-call-alert";

function display() {
  let cursor: DisplayCallCursor;
  return (feedReady: boolean, callKey: string | null, allowSpeech = true) => {
    const step = readDisplayCallAlert(cursor, feedReady, callKey, allowSpeech);
    cursor = step.cursor;
    return [step.alert, step.speech];
  };
}

describe("waiting-room call baseline", () => {
  it("alerts once on the first call after a successful empty feed", () => {
    const poll = display();
    expect(poll(false, null)).toEqual([false, false]); // Not loaded yet.
    expect(poll(true, null)).toEqual([false, false]); // Loaded empty.
    expect(poll(true, "fresh")).toEqual([true, true]);
    expect(poll(true, "fresh")).toEqual([false, false]);
    expect(poll(true, null)).toEqual([false, false]);
    expect(poll(true, "fresh")).toEqual([false, false]);
    expect(poll(true, "recalled")).toEqual([true, true]);
  });

  it("ignores a failed initial fetch and establishes an already-populated baseline silently", () => {
    const poll = display();
    expect(poll(false, null)).toEqual([false, false]);
    expect(poll(true, "previous")).toEqual([false, false]);
    expect(poll(true, "previous")).toEqual([false, false]);
    expect(poll(true, "fresh")).toEqual([true, true]);
  });

  it("allows the visual alert and chime under speech mute without replay upon enabling speech", () => {
    const poll = display();
    expect(poll(true, null, false)).toEqual([false, false]);
    expect(poll(true, "fresh", false)).toEqual([true, false]);
    expect(poll(true, "fresh", true)).toEqual([false, false]);
    expect(poll(true, "next", true)).toEqual([true, true]);
  });
});
