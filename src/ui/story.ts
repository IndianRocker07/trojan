/**
 * Story mode (docs/STORY.md §4.6): when a new importance-3 negotiation event arrives, pause the engine, open its replay
 * and autoplay it; resume afterwards if the engine was running. At most one auto-pause per 45 sim-minutes.
 * A toast lets the user Skip (close the replay, resume now) or Turn off story mode.
 */
import type { NegotiationEvent, NegotiationReplay, SimSnapshot } from '../core/types';
import { button, h } from './widgets';

export const STORY_THROTTLE_MIN = 45;
const FINISH_DWELL_MS = 2200;

export interface StoryDeps {
  engine: { snapshot: SimSnapshot; play(): void; pause(): void };
  host: HTMLElement; // toast container
  /** Open a replay in the stepper and autoplay it. */
  openReplay(r: NegotiationReplay): void;
  closeReplay(): void;
  isReplayOpen(): boolean;
  onToggle(on: boolean): void;
}

export class StoryMode {
  private on_ = false;
  private seen = new Set<string>();
  private lastPauseMin = -Infinity;
  private resumeOwed = false;
  private active = false; // a story replay is currently being shown
  private touched = false;
  private toast: HTMLElement;
  private toastText = h('span', 'toast-text');
  private hideTimer = 0;
  private finishTimer = 0;

  constructor(private d: StoryDeps) {
    const skip = button({ label: 'Skip', cls: 'small', onClick: () => this.skip() });
    const off = button({ label: 'Turn off story mode', cls: 'small', onClick: () => this.turnOff() });
    this.toast = h('div', { class: 'toast story-toast card', role: 'status', 'aria-live': 'polite', hidden: true }, h('span', 'toast-badge', 'Story mode'), this.toastText, h('span', 'toast-btns', skip, off));
    d.host.append(this.toast);
  }

  get on() {
    return this.on_;
  }

  setOn(v: boolean) {
    if (v === this.on_) return;
    this.on_ = v;
    if (!v) this.cancelActive(true);
    this.d.onToggle(v);
  }

  /** Mark everything currently in the snapshot as already seen (on start and after engine reset). */
  resync(s: SimSnapshot) {
    this.seen = new Set((s.negotiation?.events ?? []).map((e) => e.id));
    this.lastPauseMin = -Infinity;
    this.cancelActive(false);
  }

  /** Called on each engine tick. */
  onTick(s: SimSnapshot) {
    const events = s.negotiation?.events;
    if (!events?.length) return;
    let fresh: NegotiationEvent[] | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (this.seen.has(e.id)) break;
      (fresh ??= []).push(e);
    }
    if (!fresh) return;
    for (const e of fresh) this.seen.add(e.id);
    if (!this.on_ || this.d.isReplayOpen() || this.active) return;
    if (s.tMin - this.lastPauseMin < STORY_THROTTLE_MIN) return;
    const big = fresh.filter((e) => e.importance === 3).reverse();
    for (const e of big) {
      const r = this.findReplay(e, s);
      if (!r) continue;
      this.lastPauseMin = s.tMin;
      this.begin(e, r, s);
      break;
    }
  }

  /** Stepper reports autoplay reached the end. */
  onFinished() {
    if (!this.active) return;
    this.resume();
    this.setToast('Back to the live simulation. Open any message’s replay to watch again.', false);
    this.scheduleHide(4000);
    window.clearTimeout(this.finishTimer);
    this.finishTimer = window.setTimeout(() => {
      if (this.active && !this.touched && this.d.isReplayOpen()) this.d.closeReplay();
      this.active = false;
    }, FINISH_DWELL_MS);
  }

  /** The user did something inside the stepper: keep it open after the story finishes. */
  onInteract() {
    if (this.active) this.touched = true;
  }

  /** The stepper closed (by the user, a reset, or us). */
  onClosed() {
    if (!this.active) return;
    window.clearTimeout(this.finishTimer);
    this.active = false;
    this.resume();
    this.hideToast();
  }

  // ───────────────────────── internals ─────────────────────────

  private findReplay(e: NegotiationEvent, s: SimSnapshot): NegotiationReplay | undefined {
    const rs = s.negotiation?.replays ?? [];
    if (e.replayId) {
      const hit = rs.find((r) => r.id === e.replayId);
      if (hit) return hit;
    }
    let best: NegotiationReplay | undefined;
    for (const r of rs) if (r.islandId === e.islandId && r.tMin <= e.tMin + 1 && (!best || r.tMin > best.tMin)) best = r;
    return best;
  }

  private begin(e: NegotiationEvent, r: NegotiationReplay, s: SimSnapshot) {
    this.resumeOwed = s.running;
    this.active = true;
    this.touched = false;
    window.clearTimeout(this.finishTimer);
    if (s.running) this.d.engine.pause();
    this.d.openReplay(r);
    this.setToast(`Paused the simulation: ${e.text}`, true);
  }

  private resume() {
    if (this.resumeOwed) {
      this.resumeOwed = false;
      this.d.engine.play();
    }
  }

  private skip() {
    if (!this.active) {
      this.hideToast();
      return;
    }
    if (this.d.isReplayOpen()) this.d.closeReplay(); // onClosed resumes
    else this.onClosed();
  }

  private turnOff() {
    this.setOn(false);
  }

  private cancelActive(resume: boolean) {
    window.clearTimeout(this.finishTimer);
    if (this.active) {
      this.active = false;
      if (resume) this.resume();
      else this.resumeOwed = false;
      if (this.d.isReplayOpen()) this.d.closeReplay();
    }
    this.hideToast();
  }

  private setToast(text: string, withButtons: boolean) {
    window.clearTimeout(this.hideTimer);
    this.toastText.textContent = text;
    (this.toast.querySelector('.toast-btns') as HTMLElement).hidden = !withButtons;
    this.toast.hidden = false;
  }
  private scheduleHide(ms: number) {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hideToast(), ms);
  }
  private hideToast() {
    window.clearTimeout(this.hideTimer);
    this.toast.hidden = true;
  }
}
