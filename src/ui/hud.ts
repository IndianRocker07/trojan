import './styles.css';
import type { SimSnapshot } from '../core/types';
import { BottomStrip } from './bottomStrip';
import { DEFAULT_LAYERS, SPEEDS, type EngineLike, type LayerName, type WorldLike } from './contracts';
import { DisasterRail } from './disasterRail';
import { KIND_LABEL, STATUS_LABEL } from './format';
import { AgentHistory } from './history';
import { Inspector } from './inspector';
import { Topbar, helpCard } from './topbar';
import { button, h, icon, isMobile, keyChip, setText, type IconName } from './widgets';

export type Sheet = 'disasters' | 'inspect' | 'stats' | '';
const UI_HZ = 10;

/**
 * Builds the whole DOM UI over the 3D canvas and wires it to the engine and world view.
 *   new Hud(document.getElementById('ui')!, engine, world)
 * Public: select(id), openSheet(name), destroy().
 */
export class Hud {
  private hud: HTMLElement;
  private topbar: Topbar;
  private rail: DisasterRail;
  private inspector: Inspector;
  private strip: BottomStrip;
  private history = new AgentHistory();
  private selected: string | null = null;
  private hovered: string | null = null;
  private dirty = true;
  private timer = 0;
  private unsubs: (() => void)[] = [];
  private hoverPill: HTMLElement;
  private hoverText: HTMLElement;
  private pickToast: HTMLElement;
  private help: HTMLElement;
  private dockBtns = new Map<string, HTMLButtonElement>();

  constructor(
    private root: HTMLElement,
    private engine: EngineLike,
    private world: WorldLike,
  ) {
    this.hud = h('div', { class: 'hud', 'data-sheet': '', 'data-strip': 'open' });

    this.topbar = new Topbar({
      onPlayPause: () => {
        if (this.engine.snapshot.running) this.engine.pause();
        else this.engine.play();
        this.topbar.setRunning(this.engine.snapshot.running);
        this.dirty = true;
      },
      onStep: () => {
        this.engine.pause();
        this.engine.step();
        this.dirty = true;
      },
      onSpeed: (v) => {
        this.engine.setSpeed(v);
        this.dirty = true;
      },
      onReset: () => this.engine.reset(),
      onScenario: (id) => {
        this.engine.loadScenario(id);
      },
      onHelp: () => this.toggleHelp(),
    });

    this.rail = new DisasterRail({
      onTrigger: (k, p) => {
        this.engine.trigger(k, p);
        this.dirty = true;
      },
      onPickMode: (m) => this.world.setPickMode(m),
      onPickChange: (k) => this.onPickChange(k),
      onLayer: (n, on) => this.world.setLayer(n, on),
    });

    this.inspector = new Inspector(
      {
        onClose: () => this.select(null),
        onFocus: (id) => this.world.focus(id),
        onSelect: (id) => {
          this.select(id);
          this.world.focus(id);
        },
      },
      this.history,
    );

    this.strip = new BottomStrip({
      onSelect: (id) => {
        this.select(id);
        this.world.focus(id);
      },
    });

    // strip collapse tab (desktop)
    const stripTab = button({ icon: 'chevron', label: 'Stats', cls: 'small strip-tab', aria: 'Hide statistics' });
    stripTab.setAttribute('aria-expanded', 'true');
    stripTab.addEventListener('click', () => {
      const open = this.hud.dataset.strip === 'open';
      this.hud.dataset.strip = open ? 'closed' : 'open';
      stripTab.setAttribute('aria-expanded', String(!open));
      stripTab.setAttribute('aria-label', open ? 'Show statistics' : 'Hide statistics');
    });

    this.hoverText = h('span', 'hover-text');
    this.hoverPill = h('div', { class: 'hover-pill', hidden: true, 'aria-hidden': 'true' }, h('span', 'dot'), this.hoverText);
    this.pickToast = h('div', { class: 'pick-toast', hidden: true, role: 'status' });
    this.help = helpCard();

    // mobile dock
    const dock = h('nav', { class: 'dock', 'aria-label': 'Panels' });
    const dockItems: { sheet: Exclude<Sheet, ''>; label: string; ic: IconName }[] = [
      { sheet: 'disasters', label: 'Disasters', ic: 'dockDisasters' },
      { sheet: 'inspect', label: 'Inspect', ic: 'dockInspect' },
      { sheet: 'stats', label: 'Stats', ic: 'dockStats' },
    ];
    for (const d of dockItems) {
      const b = h('button', { class: 'btn dock-btn', type: 'button', 'aria-pressed': 'false' }, icon(d.ic, 20), h('span', { text: d.label }));
      b.addEventListener('click', () => this.openSheet(this.hud.dataset.sheet === d.sheet ? '' : d.sheet));
      this.dockBtns.set(d.sheet, b);
      dock.append(b);
    }

    this.hud.append(
      this.topbar.el,
      this.help,
      this.rail.el,
      this.inspector.el,
      this.rail.pill,
      stripTab,
      this.strip.el,
      this.hoverPill,
      this.pickToast,
      dock,
    );
    this.hud.addEventListener('hud-close-sheet', () => this.openSheet(''));
    this.root.append(this.hud);

    // engine
    this.unsubs.push(
      engine.on('tick', (s) => {
        this.history.sample(s, this.selected);
        this.dirty = true;
      }),
      engine.on('log', (e) => this.strip.pushLog(e)),
      engine.on('disaster', () => (this.dirty = true)),
      engine.on('reset', (s) => this.onReset(s)),
    );
    // world
    this.unsubs.push(
      world.on('select', (id) => this.select(id, true)),
      world.on('hover', (id) => {
        this.hovered = id;
        this.dirty = true;
      }),
      world.on('cellPick', (c) => this.rail.onCellPick(c.col, c.row)),
    );

    window.addEventListener('keydown', this.onKey);
    document.addEventListener('pointerdown', this.onDocPointer);

    for (const n of Object.keys(DEFAULT_LAYERS) as LayerName[]) this.rail.setLayer(n, DEFAULT_LAYERS[n], true);
    this.rail.syncLayers();

    const s0 = engine.snapshot;
    this.history.sample(s0, null);
    this.strip.reset(s0);
    this.rail.refreshTargets(s0);
    this.refresh();
    this.timer = window.setInterval(() => {
      if (this.dirty) this.refresh();
    }, 1000 / UI_HZ);
  }

  /** Toggle a map layer from code; keeps the layer buttons/pill in sync with the world. */
  setLayer(name: LayerName, on: boolean) {
    this.rail.setLayer(name, on);
  }

  /** Select a building from code (also moves the 3D selection). */
  select(id: string | null, fromWorld = false) {
    if (id === this.selected && (id === null || this.inspector.selectedId === id)) return;
    this.selected = id;
    if (!fromWorld) this.world.select(id);
    this.inspector.setSelected(id, this.engine.snapshot);
    this.selected = this.inspector.selectedId;
    if (isMobile()) this.openSheet(this.selected ? 'inspect' : '');
    this.dirty = true;
  }

  openSheet(name: Sheet) {
    this.hud.dataset.sheet = name;
    for (const [k, b] of this.dockBtns) b.setAttribute('aria-pressed', String(k === name));
  }

  destroy() {
    window.clearInterval(this.timer);
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('pointerdown', this.onDocPointer);
    this.unsubs.forEach((u) => u());
    this.hud.remove();
  }

  // ───────────────────────── internals ─────────────────────────

  private onReset(s: SimSnapshot) {
    const sid = (this.engine as { scenarioId?: string | null }).scenarioId;
    if (sid) this.topbar.setScenario(sid);
    this.history.clear();
    this.history.sample(s, null);
    this.inspector.reset();
    this.strip.reset(s);
    this.rail.cancel();
    this.rail.refreshTargets(s);
    if (this.selected && !s.buildings[this.selected]) this.select(null);
    else if (this.selected) {
      const id = this.selected;
      this.inspector.setSelected(null, s);
      this.inspector.setSelected(id, s);
    }
    this.dirty = true;
  }

  private onPickChange(kind: string | null) {
    if (kind) {
      this.pickToast.replaceChildren(
        h('span', { text: `Click the map to place the ${kind.replace('_', ' ')}` }),
        keyChip('Esc'),
      );
      this.pickToast.hidden = false;
      if (isMobile()) this.openSheet('');
    } else {
      this.pickToast.hidden = true;
    }
  }

  private toggleHelp() {
    this.help.hidden = !this.help.hidden;
  }

  private refresh() {
    this.dirty = false;
    const s = this.engine.snapshot;
    this.topbar.update(s, this.engine.timeOfDay());
    this.rail.update(s);
    this.inspector.update(s);
    this.strip.update(s);
    // hover pill
    const hb = this.hovered ? s.buildings[this.hovered] : undefined;
    if (hb && hb.id !== this.selected) {
      this.hoverPill.hidden = false;
      const dot = this.hoverPill.firstElementChild as HTMLElement;
      dot.dataset.status = hb.status;
      setText(this.hoverText, `${hb.name} · ${KIND_LABEL[hb.kind]} · ${STATUS_LABEL[hb.status] ?? hb.status}`);
    } else this.hoverPill.hidden = true;
  }

  private onDocPointer = (e: PointerEvent) => {
    if (!this.help.hidden && !this.help.contains(e.target as Node) && !(e.target as HTMLElement).closest('.topbar')) this.help.hidden = true;
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (e.key !== 'Escape') return;
    }
    const k = e.key;
    if (k === ' ') {
      if (tag === 'BUTTON') return; // let a focused button activate natively
      e.preventDefault();
      if (this.engine.snapshot.running) this.engine.pause();
      else this.engine.play();
      this.topbar.setRunning(this.engine.snapshot.running);
      this.dirty = true;
    } else if (k === '.') {
      this.engine.pause();
      this.engine.step();
      this.dirty = true;
    } else if (k >= '1' && k <= '5') {
      const sp = SPEEDS[+k - 1];
      this.engine.setSpeed(sp);
      this.topbar.setSpeed(sp);
      this.dirty = true;
    } else if (k === 'g' || k === 'G') this.rail.toggleLayer('grid');
    else if (k === 'f' || k === 'F') this.rail.toggleLayer('flow');
    else if (k === 'l' || k === 'L') this.rail.toggleLayer('labels');
    else if (k === 'p' || k === 'P') this.rail.toggleLayer('power');
    else if (k === 'w' || k === 'W') this.rail.toggleLayer('water');
    else if (k === 's' || k === 'S') this.rail.toggleLayer('status');
    else if (k === '?') this.toggleHelp();
    else if (k === 'Escape') {
      if (this.rail.isPicking) this.rail.cancel();
      else if (!this.help.hidden) this.help.hidden = true;
      else if (this.selected) this.select(null);
      else if (this.hud.dataset.sheet) this.openSheet('');
    }
  };
}
