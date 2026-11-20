import { describe, expect, it } from "vitest";
import { projectWaitingRoomDisplay } from "../lib/waiting-room";
import { SETTING_DEFAULTS } from "../lib/settings";
import { displayCallPhrases } from "../lib/display-speech";
import { parsePublicDisplayFeed } from "../lib/display-feed";
const now = new Date(2026, 10, 20, 12, 30);
const title = { title: "إعلان اصطناعي", body: "نص عام اصطناعي" };
const old = { patientName: "قديم اصطناعي", calledAt: "2026-11-20T12:27:00.000Z", chair: 1 };
const projection = (chair: number | null, count: string, privacy = "first_initial") => projectWaitingRoomDisplay({
  now, calls: [{ patientName: "أحمد عائلة", calledAt: "2026-11-20T12:29:00.000Z", chair }, old],
  settings: { ...SETTING_DEFAULTS, "clinic.chairs": count, "display.privacy_mode": privacy }, announcements: [title],
});
describe("TV destination contract", () => {
  it.each([0, 1.5, 3, 21])("suppresses only an out-of-contract latest chair %d; never brings back an older call", chair => {
    const publicFeed = projection(chair, "2");
    expect(publicFeed.called).toEqual([]);
    expect(publicFeed.announcements).toEqual([title]);
    expect(parsePublicDisplayFeed(publicFeed)).toEqual(publicFeed);
    expect(JSON.stringify(publicFeed)).not.toMatch(/أحمد|قديم/);
  });
  it("preserves configured upper boundary and masked/speech identities", () => {
    const publicFeed = projection(20, "20");
    expect(parsePublicDisplayFeed(publicFeed).called[0]).toMatchObject({ name: "أحمد ع.", speechName: "أحمد", chair: 20 });
    expect(projection(4, "4", "first_only").called[0]).toMatchObject({ name: "أحمد", speechName: "أحمد", chair: 4 });
    expect(displayCallPhrases("أحمد", 20)).toEqual(["أحمد", "يرجى التوجه إلى غرفة العلاج رقم ٢٠"]);
  });
  it("preserves an explicit null reception destination but never turns corruption into a spoken reception call", () => {
    expect(parsePublicDisplayFeed(projection(null, "2")).called[0].chair).toBeNull();
    expect(displayCallPhrases("أحمد", null)).toEqual(["أحمد", "يرجى التوجه إلى الاستقبال"]);
    expect(displayCallPhrases("أحمد", 21)).toEqual([]);
    expect(displayCallPhrases("أحمد", 0)).toEqual([]);
  });
});
