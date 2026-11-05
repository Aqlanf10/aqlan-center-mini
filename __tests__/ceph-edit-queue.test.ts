import { describe, expect, it } from "vitest";
import { CephEditQueue, type CephDraftEdit, type CephEditResult, type SavedCephLandmark } from "../lib/ceph-edit-queue";

const a: SavedCephLandmark = { code: "S", x: 10, y: 20, source: "manual" };
const b = { ...a, x: 11 };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("Ceph draft edit ordering and failure visibility", () => {
  it("serializes place/undo/redo and builds deletion preconditions from acknowledged state", async () => {
    const requests: (CephDraftEdit & { expectedLandmarks?: SavedCephLandmark[] })[] = [];
    const responses: ((result: CephEditResult) => void)[] = [];
    const state: { count: number; failed: boolean }[] = [];
    const queue = new CephEditQueue([], async (edit) => {
      requests.push(edit); return new Promise((resolve) => responses.push(resolve));
    }, (count, error) => state.push({ count, failed: !!error }));
    const placing = queue.enqueue({ landmarks: [a] });
    const undoing = queue.enqueue({ removeLandmarks: ["S"] });
    const redoing = queue.enqueue({ landmarks: [b] });
    expect(requests).toHaveLength(1);
    expect(requests[0].expectedLandmarks).toEqual([]);
    responses[0]({ ok: true }); await placing; await flush();
    expect(requests[1]).toEqual({ removeLandmarks: ["S"], expectedLandmarks: [a] });
    responses[1]({ ok: true }); await undoing; await flush();
    expect(requests[2].expectedLandmarks).toEqual([]);
    responses[2]({ ok: true }); await redoing;
    expect(state.at(-1)).toEqual({ count: 0, failed: false });
  });

  it("keeps failed writes pending and retries them before newer edits", async () => {
    let fail = true;
    const requests: CephDraftEdit[] = [], counts: number[] = [];
    const queue = new CephEditQueue([a], async (edit) => {
      requests.push(edit);
      return fail ? { ok: false, message: "offline" } : { ok: true };
    }, (count) => counts.push(count));
    const moved = queue.enqueue({ landmarks: [b] });
    const undone = queue.enqueue({ landmarks: [a] });
    await flush();
    expect(requests).toHaveLength(1);
    expect(counts.at(-1)).toBe(2);
    fail = false; queue.retry();
    await Promise.all([moved, undone]);
    expect(requests.map((item) => item.landmarks![0].x)).toEqual([11, 11, 10]);
    expect(counts.at(-1)).toBe(0);
  });

  it("never retries a conflict blindly or sends following edits", async () => {
    const requests: CephDraftEdit[] = [];
    const queue = new CephEditQueue([a], async (edit) => {
      requests.push(edit); return { ok: false, message: "changed in another editor", conflict: true };
    }, () => {});
    void queue.enqueue({ removeLandmarks: ["S"] });
    void queue.enqueue({ landmarks: [b] });
    await flush(); queue.retry(); await flush();
    expect(requests).toHaveLength(1);
  });

  it("keeps calibration ordered and returns authoritative scale in the write response", async () => {
    const requests: CephDraftEdit[] = [];
    const queue = new CephEditQueue([a], async (edit) => {
      requests.push(edit); return { ok: true, mmPerPixel: edit.calibration ? 0.1 : undefined };
    }, () => {});
    void queue.enqueue({ landmarks: [b] });
    const result = await queue.enqueue({ calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 } });
    expect(requests[0].landmarks).toEqual([b]);
    expect(requests[1].calibration?.mm).toBe(10);
    expect(result).toEqual({ ok: true, mmPerPixel: 0.1 });
  });
  it("adopts legacy server suggestions only while the manual queue is idle", async () => {
    const requests: (CephDraftEdit & { expectedLandmarks?: SavedCephLandmark[] })[] = [];
    const queue = new CephEditQueue([], async (edit) => {
      requests.push(edit); return { ok: true };
    }, () => {});
    const suggested: SavedCephLandmark = { ...a, source: "suggested" };
    expect(queue.adoptAcknowledged([suggested])).toBe(true);
    const result = queue.enqueue({ landmarks: [b] });
    expect(queue.adoptAcknowledged([])).toBe(false);
    await result;
    expect(requests[0].expectedLandmarks).toEqual([suggested]);
  });

  it("replays a committed-but-lost response before advancing later edits", async () => {
    let actual = a, loseResponse = true;
    const requests: (CephDraftEdit & { expectedLandmarks?: SavedCephLandmark[] })[] = [];
    const queue = new CephEditQueue([a], async (edit) => {
      requests.push(edit);
      const desired = edit.landmarks![0];
      // The backend protocol accepts exact desired-state replays, but never an
      // unrelated update with stale expected coordinates.
      if (actual.x !== edit.expectedLandmarks![0].x && actual.x !== desired.x)
        return { ok: false, conflict: true, message: "conflict" };
      actual = desired;
      if (loseResponse) { loseResponse = false; throw new Error("response lost after commit"); }
      return { ok: true };
    }, () => {});
    const moved = queue.enqueue({ landmarks: [b] });
    const undone = queue.enqueue({ landmarks: [a] });
    await flush();
    expect(actual.x).toBe(11);
    queue.retry(); await Promise.all([moved, undone]);
    expect(actual.x).toBe(10);
    expect(requests.map((edit) => edit.landmarks![0].x)).toEqual([11, 11, 10]);
  });

  it("undoes unpersisted preview points locally without unguarded deletion", async () => {
    const requests: CephDraftEdit[] = [];
    const queue = new CephEditQueue([], async (edit) => { requests.push(edit); return { ok: true }; }, () => {});
    await queue.enqueue({ removeLandmarks: ["S"] });
    expect(requests).toEqual([]);
    await queue.enqueue({ landmarks: [a] });
    await queue.enqueue({ removeLandmarks: ["S"] });
    expect(requests).toHaveLength(2);
    expect(requests[1].removeLandmarks).toEqual(["S"]);
  });

});
