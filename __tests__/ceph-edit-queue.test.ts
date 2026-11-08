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
      requests.push(edit); return { ok: true, mmPerPixel: edit.calibration ? 0.1 : undefined, calibration: edit.calibration };
    }, () => {});
    void queue.enqueue({ landmarks: [b] });
    const result = await queue.enqueue({ calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 } });
    expect(requests[0].landmarks).toEqual([b]);
    expect(requests[1].calibration?.mm).toBe(10);
    expect(result).toEqual({ ok: true, mmPerPixel: 0.1, calibration: requests[1].calibration });
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

describe('acknowledged calibration compare-and-set', () => {
  const initial = { calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, mmPerPixel: 0.1 };
  const second = { x1: 0, y1: 0, x2: 200, y2: 0, mm: 10 };
  const third = { x1: 0, y1: 0, x2: 250, y2: 0, mm: 10 };
  it('builds each ruler precondition from the last acknowledged save, not queued optimistic state', async () => {
    const requests: any[] = [], replies: ((r: CephEditResult) => void)[] = [];
    const queue = new CephEditQueue([], async edit => { requests.push(edit); return new Promise(resolve => replies.push(resolve)); }, () => {}, initial);
    const one = queue.enqueue({ calibration: second }), two = queue.enqueue({ calibration: third });
    expect(requests).toHaveLength(1); expect(requests[0].expectedCalibration).toEqual(initial);
    replies[0]({ ok: true, calibration: second, mmPerPixel: 0.05 }); await one; await flush();
    expect(requests[1].expectedCalibration).toEqual({ calibration: second, mmPerPixel: 0.05 });
    replies[1]({ ok: true, calibration: third, mmPerPixel: 0.04 }); await two;
  });
  it('retains the old expected ruler for a lost-response replay before advancing', async () => {
    const requests: any[] = []; let lost = true;
    const queue = new CephEditQueue([], async edit => { requests.push(edit); if (lost) { lost = false; throw new Error('lost committed reply'); }
      return { ok: true, calibration: edit.calibration!, mmPerPixel: edit.calibration!.mm / edit.calibration!.x2 }; }, () => {}, initial);
    const one = queue.enqueue({ calibration: second }), two = queue.enqueue({ calibration: third }); await flush();
    queue.retry(); await Promise.all([one, two]); expect(requests.map(r => r.expectedCalibration)).toEqual([initial, initial, { calibration: second, mmPerPixel: 0.05 }]);
  });
  it('accepts harmless cross-runtime rounding but keeps the authoritative scale', async () => {
    const authoritative = 0.05 * (1 + Number.EPSILON);
    const queue = new CephEditQueue([], async () => ({ ok: true, calibration: second, mmPerPixel: authoritative }), () => {}, initial);
    const result = queue.enqueue({ calibration: second });
    const state = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('pending'), 100))]);
    expect(state).toEqual({ ok: true, calibration: second, mmPerPixel: authoritative });
  });
  it('does not retry a stale ruler conflict or allow later points to bypass it', async () => {
    const requests: any[] = []; const queue = new CephEditQueue([], async edit => { requests.push(edit); return { ok: false, conflict: true, message: 'stale ruler' }; }, () => {}, initial);
    void queue.enqueue({ calibration: second }); void queue.enqueue({ landmarks: [a] }); await flush(); queue.retry(); await flush();
    expect(requests).toHaveLength(1); expect(requests[0].expectedCalibration).toEqual(initial);
  });
  it.each([{}, { calibration: second, mmPerPixel: NaN }, { calibration: third, mmPerPixel: 0.04 }, { calibration: second, mmPerPixel: 0.5 }])('keeps a missing or mismatched authoritative acknowledgment pending: %j', async incomplete => {
    const requests: any[] = [], states: any[] = []; let valid = false;
    const queue = new CephEditQueue([], async edit => { requests.push(edit); return valid ? { ok: true, calibration: second, mmPerPixel: 0.05 } : { ok: true, ...incomplete }; }, (count, error) => states.push({ count, error }), initial);
    const promise = queue.enqueue({ calibration: second }); await flush(); expect(states.at(-1)).toMatchObject({ count: 1, error: { ok: false } });
    valid = true; queue.retry(); await promise; expect(requests.map(r => r.expectedCalibration)).toEqual([initial, initial]);
  });
});

 it('terminal retirement settles all waiters as failure and suppresses late send/notify/retry',async()=>{
  let reply!:(value:CephEditResult)=>void;const sent:CephDraftEdit[]=[],notifications:number[]=[];
  const q=new CephEditQueue([],edit=>{sent.push(edit);return new Promise(r=>{reply=r;});},n=>notifications.push(n));
  const first=q.enqueue({landmarks:[a]}),second=q.enqueue({landmarks:[b]});const count=notifications.length;
  q.retire();expect(await first).toEqual(CephEditQueue.retiredResult);expect(await second).toEqual(CephEditQueue.retiredResult);
  expect(await q.enqueue({landmarks:[a]})).toEqual(CephEditQueue.retiredResult);q.retry();reply({ok:true});await flush();
  expect(sent).toHaveLength(1);expect(notifications).toHaveLength(count);expect(q.adoptAcknowledged([b])).toBe(false);q.retire();
 });

it('audit proof: lost committed reply is pending, not proof of an unsaved write',async()=>{
 let committed=false;const notices:(import('../lib/ceph-edit-queue').CephEditResult|null)[]=[];
 const queue=new CephEditQueue([],async()=>{committed=true;throw new Error('reply lost after commit');},(_pending,error)=>notices.push(error));
 void queue.enqueue({landmarks:[{code:'S',x:10,y:20,source:'manual'}]});
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(committed).toBe(true);
 const error=notices.at(-1);
 expect(error?.ok).toBe(false);
 if(!error||error.ok)throw new Error('Expected uncertain acknowledgment');
 expect(error.message).not.toContain('لم تُحفظ بعد');
 expect(error.message).toContain('قد يكون الطلب الجاري حُفظ');
 queue.retire();
});
