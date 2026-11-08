import { sameCephCalibrationState, type CephCalibrationState } from "./ceph-completion-snapshot";
import type { LandmarkCode, Pt } from "./ceph";

export type SavedCephLandmark = Pt & { code: LandmarkCode; source: "manual" | "suggested" };
export interface CephDraftEdit {
  landmarks?: SavedCephLandmark[];
  removeLandmarks?: LandmarkCode[];
  calibration?: { x1: number; y1: number; x2: number; y2: number; mm: number };
}
export type CephEditResult = { ok: true; mmPerPixel?: number | null; calibration?: CephCalibrationState["calibration"] } | { ok: false; message: string; conflict?: boolean };

/** Serializes optimistic drawing edits. Preconditions are built at send time from
 * acknowledged state, never from a later optimistic cursor or an earlier timer.
 * Failed writes and everything after them stay pending until an explicit retry. */
export class CephEditQueue {
  private acknowledged = new Map<LandmarkCode, SavedCephLandmark>();
  private acknowledgedCalibration: CephCalibrationState;
  private pending: { edit: CephDraftEdit; resolve: (result: CephEditResult) => void }[] = [];
  private running = false;
  private retired = false;
  static readonly retiredResult = { ok: false as const, message: "انتهت جلسة الرسم. قد يكون الطلب الجاري حُفظ؛ أعد فتح الدراسة للتحقق قبل أي تعديل." };

  retire() {
    if (this.retired) return;
    this.retired = true;
    const pending = this.pending.splice(0);
    for (const item of pending) item.resolve(CephEditQueue.retiredResult);
  }
  private failure: Exclude<CephEditResult, { ok: true }> | null = null;

  constructor(initial: SavedCephLandmark[], private send: (edit: CephDraftEdit & { expectedLandmarks?: SavedCephLandmark[]; expectedCalibration?: CephCalibrationState }) => Promise<CephEditResult>,
    private notify: (pending: number, error: Exclude<CephEditResult, { ok: true }> | null) => void,
    initialCalibration: CephCalibrationState = { calibration: null, mmPerPixel: null }) {
    this.acknowledgedCalibration = { calibration: initialCalibration.calibration ? { ...initialCalibration.calibration } : null,
      mmPerPixel: initialCalibration.mmPerPixel };
    for (const point of initial) this.acknowledged.set(point.code, { ...point });
  }

  enqueue(edit: CephDraftEdit): Promise<CephEditResult> {
    if (this.retired) return Promise.resolve(CephEditQueue.retiredResult);
    const promise = new Promise<CephEditResult>((resolve) => this.pending.push({ edit, resolve }));
    this.notify(this.pending.length, this.failure);
    void this.drain();
    return promise;
  }

  /** Adopt a separately acknowledged legacy suggestion operation only while idle. */
  adoptAcknowledged(landmarks: SavedCephLandmark[]): boolean {
    if (this.retired || this.pending.length || this.failure) return false;
    this.acknowledged = new Map(landmarks.map((point) => [point.code, { ...point }]));
    return true;
  }

  retry() {
    // A 409 means another editor changed the study. Never blindly overwrite it.
    if (this.retired || this.failure?.conflict) return;
    this.failure = null;
    void this.drain();
  }

  private async drain() {
    if (this.retired || this.running || this.failure) return;
    this.running = true;
    try {
      while (!this.retired && this.pending.length) {
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
        try { result = await this.send({ ...edit, ...(touched.size ? { expectedLandmarks } : {}),
          ...(edit.calibration ? { expectedCalibration: { calibration: this.acknowledgedCalibration.calibration ? { ...this.acknowledgedCalibration.calibration } : null,
            mmPerPixel: this.acknowledgedCalibration.mmPerPixel } } : {}),
        }); }
        catch { result = { ok: false, message: "تعذّر تأكيد الحفظ بسبب انقطاع الاتصال. قد يكون الطلب الجاري حُفظ؛ بقيت التعديلات معلّقة للتحقق عند إعادة المحاولة." }; }
        if (this.retired) return;
        if (result.ok && edit.calibration) {
          const desired = edit.calibration;
          const expectedScale = desired.mm / Math.hypot(desired.x2 - desired.x1, desired.y2 - desired.y1);
          const actualScale = result.mmPerPixel;
          // The server value stays authoritative. Allow only machine-arithmetic
          // rounding between JS runtimes (1e-12 relative), not a changed ruler or
          // materially different scale; CAS state comparisons remain exact.
          if (!Number.isFinite(expectedScale) || expectedScale <= 0
            || typeof actualScale !== "number" || !Number.isFinite(actualScale) || actualScale <= 0
            || Math.abs(actualScale - expectedScale) > 1e-12 * Math.max(actualScale, expectedScale)
            || !sameCephCalibrationState({ calibration: result.calibration, mmPerPixel: actualScale },
              { calibration: desired, mmPerPixel: actualScale })) {
            result = { ok: false, message: "لم تُؤكَّد المعايرة المحفوظة. بقي التعديل معلّقًا؛ أعد المحاولة للتحقق." };
          }
        }
        if (!result.ok) {
          this.failure = result;
          this.notify(this.pending.length, this.failure);
          return;
        }
        for (const code of edit.removeLandmarks ?? []) this.acknowledged.delete(code);
        for (const point of edit.landmarks ?? []) this.acknowledged.set(point.code, { ...point });
        if (edit.calibration) this.acknowledgedCalibration = {
          calibration: { ...result.calibration! }, mmPerPixel: result.mmPerPixel!,
        };
        this.pending.shift();
        item.resolve(result);
        this.notify(this.pending.length, null);
      }
    } finally { this.running = false; }
  }
}
