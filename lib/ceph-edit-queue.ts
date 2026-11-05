import type { LandmarkCode, Pt } from "./ceph";

export type SavedCephLandmark = Pt & { code: LandmarkCode; source: "manual" | "suggested" };
export interface CephDraftEdit {
  landmarks?: SavedCephLandmark[];
  removeLandmarks?: LandmarkCode[];
  calibration?: { x1: number; y1: number; x2: number; y2: number; mm: number };
}
export type CephEditResult = { ok: true; mmPerPixel?: number | null } | { ok: false; message: string; conflict?: boolean };

/** Serializes optimistic drawing edits. Preconditions are built at send time from
 * acknowledged state, never from a later optimistic cursor or an earlier timer.
 * Failed writes and everything after them stay pending until an explicit retry. */
export class CephEditQueue {
  private acknowledged = new Map<LandmarkCode, SavedCephLandmark>();
  private pending: { edit: CephDraftEdit; resolve: (result: CephEditResult) => void }[] = [];
  private running = false;
  private failure: Exclude<CephEditResult, { ok: true }> | null = null;

  constructor(initial: SavedCephLandmark[], private send: (edit: CephDraftEdit & { expectedLandmarks?: SavedCephLandmark[] }) => Promise<CephEditResult>,
    private notify: (pending: number, error: Exclude<CephEditResult, { ok: true }> | null) => void) {
    for (const point of initial) this.acknowledged.set(point.code, { ...point });
  }

  enqueue(edit: CephDraftEdit): Promise<CephEditResult> {
    const promise = new Promise<CephEditResult>((resolve) => this.pending.push({ edit, resolve }));
    this.notify(this.pending.length, this.failure);
    void this.drain();
    return promise;
  }

  /** Adopt a separately acknowledged legacy suggestion operation only while idle. */
  adoptAcknowledged(landmarks: SavedCephLandmark[]): boolean {
    if (this.pending.length || this.failure) return false;
    this.acknowledged = new Map(landmarks.map((point) => [point.code, { ...point }]));
    return true;
  }

  retry() {
    // A 409 means another editor changed the study. Never blindly overwrite it.
    if (this.failure?.conflict) return;
    this.failure = null;
    void this.drain();
  }

  private async drain() {
    if (this.running || this.failure) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const item = this.pending[0];
        // Preview-only points were never acknowledged by the server. Undoing a
        // preview must not delete someone else's newly persisted landmark.
        const edit = { ...item.edit, ...(item.edit.removeLandmarks ? {
          removeLandmarks: item.edit.removeLandmarks.filter((code) => this.acknowledged.has(code)),
        } : {}) };
        if (!edit.landmarks?.length && !edit.removeLandmarks?.length && !edit.calibration) {
          this.pending.shift(); item.resolve({ ok: true }); this.notify(this.pending.length, null); continue;
        }
        const touched = new Set([...(edit.landmarks ?? []).map((point) => point.code), ...(edit.removeLandmarks ?? [])]);
        const expectedLandmarks = [...touched].flatMap((code) => {
          const value = this.acknowledged.get(code); return value ? [{ ...value }] : [];
        });
        let result: CephEditResult;
        try { result = await this.send({ ...edit, ...(touched.size ? { expectedLandmarks } : {}) }); }
        catch { result = { ok: false, message: "تعذّر الاتصال. التعديلات على الشاشة لم تُحفظ بعد." }; }
        if (!result.ok) {
          this.failure = result;
          this.notify(this.pending.length, this.failure);
          return;
        }
        for (const code of edit.removeLandmarks ?? []) this.acknowledged.delete(code);
        for (const point of edit.landmarks ?? []) this.acknowledged.set(point.code, { ...point });
        this.pending.shift();
        item.resolve(result);
        this.notify(this.pending.length, null);
      }
    } finally { this.running = false; }
  }
}
