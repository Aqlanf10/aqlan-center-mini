/**
 * نظام التنبيهات الصوتية للعيادة (Web Audio API).
 *
 * يعمل مباشرة عبر توليد نغمات توافقية نقية وعالية الوضوح بدون الحاجة لملفات صوت خارجية
 * ولا يتأثر بمشاكل شبكة أو صيغ ملفات.
 */

class AudioAlertSystem {
  private ctx: AudioContext | null = null;
  private enabled: boolean = true;
  private volume: number = 0.6;

  constructor() {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("clinic_sound_alerts");
      this.enabled = stored !== null ? stored === "true" : true;
      const vol = localStorage.getItem("clinic_sound_volume");
      if (vol) this.volume = Math.max(0.1, Math.min(1, parseFloat(vol)));
    }
  }

  private getContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (typeof window !== "undefined") {
      localStorage.setItem("clinic_sound_alerts", enabled ? "true" : "false");
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0.05, Math.min(1, vol));
    if (typeof window !== "undefined") {
      localStorage.setItem("clinic_sound_volume", String(this.volume));
    }
  }

  /**
   * نغمة وصول مريض جديد — نغمة رنين ثلاثية متناغمة ومهدئة (C5 -> E5 -> G5)
   */
  public playArrival(): void {
    if (!this.enabled) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99]; // C5, E5, G5

      notes.forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, now + index * 0.12);

        gain.gain.setValueAtTime(0, now + index * 0.12);
        gain.gain.linearRampToValueAtTime(this.volume * 0.45, now + index * 0.12 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.12 + 0.45);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + index * 0.12);
        osc.stop(now + index * 0.12 + 0.5);
      });
    } catch {
      // Ignore audio failure
    }
  }

  /**
   * نغمة تغيير حالة موعد أو مناداة مريض للكرسي (A4 -> C#5)
   */
  public playStatusChange(): void {
    if (!this.enabled) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const notes = [440, 554.37]; // A4, C#5

      notes.forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, now + index * 0.1);

        gain.gain.setValueAtTime(0, now + index * 0.1);
        gain.gain.linearRampToValueAtTime(this.volume * 0.35, now + index * 0.1 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.1 + 0.35);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + index * 0.1);
        osc.stop(now + index * 0.1 + 0.4);
      });
    } catch {
      // Ignore audio failure
    }
  }

  /**
   * نغمة تنبيه الانتظار الطويل (>20 دقيقة)
   */
  public playUrgentAlert(): void {
    if (!this.enabled) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const notes = [659.25, 587.33, 659.25]; // E5, D5, E5

      notes.forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, now + index * 0.15);

        gain.gain.setValueAtTime(0, now + index * 0.15);
        gain.gain.linearRampToValueAtTime(this.volume * 0.5, now + index * 0.15 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + index * 0.15 + 0.3);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + index * 0.15);
        osc.stop(now + index * 0.15 + 0.35);
      });
    } catch {
      // Ignore audio failure
    }
  }
}

export const audioAlerts = new AudioAlertSystem();
