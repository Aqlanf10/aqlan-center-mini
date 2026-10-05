import { describe, expect, it } from "vitest";
import {
  FULL_SET_VIEWS, fullPhotoSetCheck, savedFullPhotoSetHistory, type PhotoStage,
} from "../lib/ortho-photos";

// Minimal persisted fields actually preserved by /api/ortho's adjustment projection.
interface Photo {
  id: number; patientId: number; orthoCaseId: number | null; adjustmentId: number | null;
  isImage: boolean; removedAt: string | null;
  photoStage: string | null; photoView: string | null; takenOn: string | null;
}
interface Adjustment { id: number; doneOn: string; photos: Photo[] }

function session(id: number, date = "2026-06-01", stage: PhotoStage = "initial"): Adjustment {
  return {
    id, doneOn: date,
    photos: FULL_SET_VIEWS.map((view, index) => ({
      id: id * 100 + index, patientId: 11, orthoCaseId: 21, adjustmentId: id,
      isImage: true, removedAt: null, photoStage: stage, photoView: view, takenOn: date,
    })),
  };
}
type Input = Parameters<typeof savedFullPhotoSetHistory>[0];
function read(adjustments: unknown, overrides: Partial<Input> = {}) {
  return savedFullPhotoSetHistory({
    patientId: 11, orthoCaseId: 21, photosVisible: true,
    today: "2026-10-05", asOfDate: "2026-10-05", adjustments, ...overrides,
  });
}
const empty = { status: "ready", latest: null };
const unknownMetadata = { status: "unknown", reason: "metadata", latest: null };

describe("saved full photo-set history", () => {
  it("distinguishes a known empty history from unavailable image evidence", () => {
    expect(read([])).toEqual(empty);
    expect(read([], { photosVisible: false })).toEqual({ status: "unknown", reason: "visibility", latest: null });
    expect(read([], { photosVisible: undefined })).toEqual({ status: "unknown", reason: "visibility", latest: null });
    expect(read(null)).toEqual(unknownMetadata);
    expect(read(undefined)).toEqual(unknownMetadata);
  });

  it.each([1, 7])("does not treat %i initial views as a saved full set", count => {
    const row = session(1); row.photos = row.photos.slice(0, count);
    expect(read([row])).toEqual(empty);
    const history = read([row]);
    if (history.status !== "ready") throw new Error("Expected readable synthetic history");
    expect(fullPhotoSetCheck({
      sessionDate: "2026-07-01", startDate: "2026-06-01",
      lastFullSetDate: history.latest?.takenOn ?? null, intervalMonths: 6,
      phase: "aligning", capturedViews: [],
    })).toMatchObject({ required: true, missingViews: FULL_SET_VIEWS });
  });

  it("recognizes all eight distinct saved views with explicit provenance", () => {
    const row = session(1);
    expect(read([row])).toEqual({
      status: "ready",
      latest: { adjustmentId: 1, stage: "initial", takenOn: "2026-06-01", documentIds: row.photos.map(photo => photo.id) },
    });
  });

  it("selects the latest complete saved progress set, not the first initial image or response order", () => {
    const initial = session(1, "2026-01-01");
    const progress = session(2, "2026-08-01", "progress");
    const partial = session(3, "2026-09-01"); partial.photos = partial.photos.slice(0, 1);
    for (const rows of [[initial, partial, progress], [progress, initial, partial]]) {
      const history = read(rows);
      expect(history).toMatchObject({ status: "ready", latest: { adjustmentId: 2, takenOn: "2026-08-01", stage: "progress" } });
      if (history.status !== "ready") throw new Error("Expected readable synthetic history");
      expect(fullPhotoSetCheck({
        sessionDate: "2026-10-05", startDate: "2026-01-01", lastFullSetDate: history.latest?.takenOn ?? null,
        intervalMonths: 6, phase: "aligning", capturedViews: [],
      }).required).toBe(false);
    }
  });

  it("does not count duplicate views toward eight different views", () => {
    const row = session(1);
    row.photos[7] = { ...row.photos[7], photoView: row.photos[0].photoView };
    expect(read([row])).toEqual(empty);
  });

  it("does not combine different adjustments on the same date", () => {
    const first = session(1); first.photos = first.photos.slice(0, 4);
    const second = session(2); second.photos = second.photos.slice(4);
    expect(read([first, second])).toEqual(empty);
  });

  it("does not combine different stored stages within an adjustment", () => {
    const row = session(1);
    row.photos = row.photos.map((photo, index) => ({ ...photo, photoStage: index < 4 ? "initial" : "progress" }));
    expect(read([row])).toEqual(empty);
  });

  it("does not combine different recorded capture dates within an adjustment", () => {
    const row = session(1);
    row.photos = row.photos.map((photo, index) => ({ ...photo, takenOn: index < 4 ? "2026-05-31" : "2026-06-01" }));
    expect(read([row])).toEqual(empty);
  });

  it("uses the stored capture date without silently substituting the adjustment date", () => {
    const row = session(1, "2026-08-01");
    row.photos = row.photos.map(photo => ({ ...photo, takenOn: "2026-06-01" }));
    expect(read([row])).toMatchObject({ status: "ready", latest: { takenOn: "2026-06-01" } });
    row.photos[0].takenOn = null;
    expect(read([row])).toEqual(unknownMetadata);
  });

  it.each([
    { patientId: 12 }, { orthoCaseId: 22 }, { orthoCaseId: null },
    { adjustmentId: 2 }, { adjustmentId: null },
  ])("never trusts a photo identity inferred from its parent array: %j", change => {
    const row = session(1); row.photos[0] = { ...row.photos[0], ...change };
    expect(read([row])).toEqual(unknownMetadata);
  });

  it.each([
    { photoStage: null }, { photoStage: "toString" }, { photoStage: "future" },
    { photoView: null }, { photoView: "selfie" },
    { takenOn: null }, { takenOn: "2026-02-30" }, { takenOn: "0000-01-01" },
  ])("keeps legacy or malformed image metadata explicitly unknown: %j", change => {
    const row = session(1); row.photos[0] = { ...row.photos[0], ...change };
    expect(read([row])).toEqual(unknownMetadata);
  });

  it("does not hide unknown metadata behind an otherwise complete earlier set", () => {
    const valid = session(1);
    const unknown = session(2); unknown.photos[0].takenOn = null;
    expect(read([valid, unknown])).toEqual(unknownMetadata);
  });

  it("excludes known non-images, removed images and archived images from saved completeness", () => {
    for (const change of [{ isImage: false }, { removedAt: "2026-06-02T00:00:00Z" }, { photoStage: "archived" }]) {
      const row = session(1); row.photos[0] = { ...row.photos[0], ...change };
      expect(read([row])).toEqual(empty);
    }
  });

  it.each(["", "not-a-timestamp", "2026-02-30T00:00:00Z"])("does not turn malformed removal metadata into confirmed removal: %s", removedAt => {
    const row = session(1); row.photos[0].removedAt = removedAt;
    expect(read([row])).toEqual(unknownMetadata);
  });

  it("does not substitute the extra records-gallery views for a required view", () => {
    const row = session(1);
    row.photos[7].photoView = "panoramic";
    expect(read([row])).toEqual(empty);
  });

  it("rejects duplicate document or adjustment IDs rather than manufacturing independent evidence", () => {
    const row = session(1); row.photos[7].id = row.photos[0].id;
    expect(read([row])).toEqual(unknownMetadata);
    expect(read([session(1), session(1)])).toEqual(unknownMetadata);
  });

  it("keeps future-dated evidence relative to explicit clinic today unknown instead of suppressing reminders", () => {
    expect(read([session(1, "2026-11-01")])).toEqual(unknownMetadata);
    const futureCapture = session(2); futureCapture.photos.forEach(photo => { photo.takenOn = "2026-11-01"; });
    expect(read([futureCapture])).toEqual(unknownMetadata);
    const futureSession = session(3, "2026-11-01"); futureSession.photos.forEach(photo => { photo.takenOn = "2026-06-01"; });
    expect(read([futureSession])).toEqual(unknownMetadata);
    expect(read([session(4, "2026-10-05")])).toMatchObject({ status: "ready", latest: { takenOn: "2026-10-05" } });
    expect(read([], { asOfDate: "2026-11-01" })).toEqual(unknownMetadata);
  });

  it("does not use a later valid historical session/capture as prior evidence for a backdated form", () => {
    expect(read([session(1, "2026-08-01")], { asOfDate: "2026-07-01" })).toEqual(empty);
    const laterCapture = session(2, "2026-06-01");
    laterCapture.photos.forEach(photo => { photo.takenOn = "2026-08-01"; });
    expect(read([laterCapture], { asOfDate: "2026-07-01" })).toEqual(empty);
  });

  it("validates real calendar dates, including leap days, without timezone parsing", () => {
    expect(read([session(1, "2024-02-29")])).toMatchObject({ status: "ready", latest: { takenOn: "2024-02-29" } });
    for (const asOfDate of ["2026-02-29", "2026-13-01", "2026-01-00", "2026-1-01", "not a date"]) {
      expect(read([], { asOfDate })).toEqual(unknownMetadata);
    }
    expect(read([{ ...session(1), doneOn: "2026-02-29" }])).toEqual(unknownMetadata);
  });

  it("fails closed for malformed envelopes and missing canonical projection fields", () => {
    expect(read([], { patientId: 0 })).toEqual(unknownMetadata);
    expect(read([], { orthoCaseId: Number.NaN })).toEqual(unknownMetadata);
    expect(read([], { today: "2026-02-30" })).toEqual(unknownMetadata);
    for (const row of [null, {}, { id: 1, doneOn: "2026-06-01", photos: null }]) expect(read([row])).toEqual(unknownMetadata);
    const row = session(1);
    const missingField: Partial<Photo> = { ...row.photos[0] };
    delete missingField.removedAt;
    expect(read([{ ...row, photos: [missingField, ...row.photos.slice(1)] }])).toEqual(unknownMetadata);
  });

  it("keeps queued or failed-upload views separate from persisted saved history", () => {
    const row = session(1); row.photos = row.photos.slice(0, 7);
    const queuedViews = [FULL_SET_VIEWS[7]];
    const beforeUpload = read([row]);
    expect(beforeUpload).toEqual(empty);
    // Queue completeness is prospective UI information, never a saved-history write.
    expect(fullPhotoSetCheck({
      sessionDate: "2026-06-01", startDate: "2026-06-01", lastFullSetDate: null,
      intervalMonths: 6, phase: "aligning", capturedViews: [...FULL_SET_VIEWS.slice(0, 7), ...queuedViews],
    }).missingViews).toEqual([]);
    expect(read([row])).toEqual(empty); // no persisted eighth document after a failed upload
    expect(read([session(1)])).toMatchObject({ status: "ready", latest: { adjustmentId: 1 } });
  });

  it("does not depend on visit signing or impose a photographic sign-off gate", () => {
    const row = session(1);
    expect(read([{ ...row, visitSigned: false }])).toEqual(read([{ ...row, visitSigned: true }]));
  });

  it("is deterministic for tied dates/duplicate views and never mutates its input", () => {
    const older = session(1);
    const newer = session(2);
    newer.photos.push({ ...newer.photos[0], id: 299 });
    const before = JSON.stringify([older, newer]);
    const first = read([older, newer]);
    expect(first).toEqual(read([newer, older]));
    expect(first).toMatchObject({ status: "ready", latest: { adjustmentId: 2, documentIds: FULL_SET_VIEWS.map((_, index) => 200 + index) } });
    expect(JSON.stringify([older, newer])).toBe(before);
  });
});
