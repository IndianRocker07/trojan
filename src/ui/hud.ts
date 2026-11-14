import './styles.css';
import './ux.css';
import './collapse.css';
import type { NegotiationReplay, ReplayRenderer, SimSnapshot } from '../core/types';
import { BottomStrip } from './bottomStrip';
import { ChatFeed } from './chatFeed';
import { DEFAULT_LAYERS, SPEEDS, type EngineLike, type LayerName, type WorldLike } from './contracts';
import { DisasterRail } from './disasterRail';
import { KIND_LABEL, STATUS_LABEL } from './format';
import { CoachMarks, Welcome, type CoachStep } from './guide';
import { AgentHistory } from './history';
import { Inspector } from './inspector';
import { PREF, panelExpanded, prefs, rememberPanel } from './prefs';
import { ReplayStepper, type OpenOptions } from './stepper';
import { StoryMode } from './story';
import { installTips } from './tip';
import { Topbar, helpCard, type ModeOptions } from './topbar';
import { button, h, icon, isMobile, keyChip, segmented, setText, type IconName } from './widgets';

export interface HudOptions {
  modes?: ModeOptions;
  /**
   * Views that can draw a replay (theater view, city overlay). The replay stepper is the master clock and calls
   * `showReplay(replay, stageIndex, progress)` on each one every animation frame while a replay is open, and
   * `showReplay(null, 0, 0)` when it closes. The array is read live, so renderers may be pushed later.
   */
  replayRenderers?: ReplayRenderer[];
  /** Negotiation Theater view. When omitted the Theater button and the T key are hidden / inert. */
  theater?: { setVisible(on: boolean): void; isVisible(): boolean };
  /** Welcome guide: 'auto' = first visit only (remembered in localStorage), 'always' = force, 'never' = off. Default 'auto'. */
  welcome?: 'auto' | 'always' | 'never';
  /** Scenario the guided demo loads. Default 'compound'. */
  guidedScenario?: string;
}

export type Sheet = 'disasters' | 'inspect' | 'stats' | 'feed' | '';
type RailTab = 'disasters' | 'feed';
const UI_HZ = 10;
const NARROW = '(max-width: 959px)';

/** Hamburger glyph in the same 2.5 px ink stroke as the widgets.ts icons. */
function menuIcon(size = 20): SVGElement {
  const w = document.createElement('span');
  w.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path d="M4 6.5h16M4 12h16M4 17.5h16" fill="none" stroke="#121310" stroke-width="2.5" stroke-linecap="round"/></svg>`;
  return w.firstElementChild as SVGElement;
}

/**
 * Builds the whole DOM UI over the 3D canvas and wires it to the engine and world view.
 *   new Hud(document.getElementById('ui')!, engine, world, { replayRenderers: [theater, world], theater })
 * Public: select(id), openSheet(name), openReplay(id), closeReplay(), openFeed(), setStoryMode(on), toggleTheater(),
 * showWelcome(), startGuidedDemo(), destroy().
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
  private feed: ChatFeed;
  private stepper: ReplayStepper;
  private story: StoryMode;
  private welcome: Welcome;
  private coach = new CoachMarks();
  private railTab: RailTab = 'disasters';
  private railSeg;
  private railBadge: HTMLElement;
  private disastersPanel: HTMLElement;
  private layersPanel: HTMLElement;
  private feedShown = false;
  private renderers: ReplayRenderer[];
  private theater?: HudOptions['theater'];
  private guidedScenario: string;
  private ro?: ResizeObserver;
  private stripTab!: HTMLButtonElement;
  private cinema = false;
  private savedStrip = 'open';
  private panelsBtn!: HTMLButtonElement;
  private liveBtn!: HTMLButtonElement;
  private dock!: HTMLElement;
  private dockToggle!: HTMLButtonElement;
  private dockItems!: HTMLElement;
  private dockOpen = false;
  private layersToggle!: HTMLButtonElement;
  private layerGlyph!: HTMLElement;
  private layerObserver?: MutationObserver;
  private layersOpen = false;
  private inspectorPanel!: HTMLElement;
  /** Desktop expanded state of the Disasters panel and the Inspector (phones show them as sheets). */
  private panelOpen = { disasters: panelExpanded('disasters'), inspector: panelExpanded('inspector') };
  private narrow = window.matchMedia(NARROW);

  constructor(
    private root: HTMLElement,
    private engine: EngineLike,
    private world: WorldLike,
    opts: HudOptions = {},
  ) {
    this.renderers = opts.replayRenderers ?? [];
    this.theater = opts.theater;
    this.guidedScenario = opts.guidedScenario ?? 'compound';
    this.hud = h('div', { class: 'hud', 'data-sheet': '', 'data-strip': panelExpanded('stats') ? 'open' : 'closed', 'data-stepper': '' });

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
      onHelp: () => this.showWelcome(),
      onStory: (on) => this.setStoryMode(on),
      onTheater: () => this.toggleTheater(),
      theaterAvailable: !!opts.theater,
      modes: opts.modes,
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

    this.feed = new ChatFeed({
      onSelect: (id) => {
        this.select(id);
        this.world.focus(id);
      },
      onReplay: (rid, opener) => this.openReplay(rid, { opener, focus: true }),
      onUnread: (n) => {
        this.railBadge.textContent = n > 99 ? '99+' : String(n);
        this.railBadge.hidden = n === 0;
      },
    });
    this.stepper = new ReplayStepper({
      renderers: this.renderers,
      onSelect: (id) => {
        this.select(id);
        this.world.focus(id);
      },
      onClosed: () => {
        this.hud.dataset.stepper = '';
        this.story.onClosed();
      },
      onFinished: () => this.story.onFinished(),
      onInteract: () => this.story.onInteract(),
    });
    this.story = new StoryMode({
      engine,
      host: this.hud,
      openReplay: (r) => this.openReplayObj(r, { autoplay: true }),
      closeReplay: () => this.stepper.close(false),
      isReplayOpen: () => this.stepper.isOpen,
      onToggle: (on) => {
        this.topbar.setStory(on);
        prefs.set(PREF.story, on ? '1' : '0');
      },
    });
    this.welcome = new Welcome({
      onGuided: () => {
        prefs.set(PREF.welcomed, '1');
        this.startGuidedDemo();
      },
      onExplore: () => prefs.set(PREF.welcomed, '1'),
      onShortcuts: () => {
        prefs.set(PREF.welcomed, '1');
        this.help.hidden = false;
      },
    });
    this.coach.onEnd = () => prefs.set(PREF.coached, '1');

    // left rail tabs: Disasters | Live negotiation
    this.railBadge = h('span', { class: 'tab-badge', hidden: true });
    this.railSeg = segmented<RailTab>({
      label: 'Left panel view',
      options: [
        { value: 'disasters', label: 'Disasters' },
        { value: 'feed', label: 'Live negotiation' },
      ],
      value: 'disasters',
      cls: 'rail-tabs',
      onChange: (t) => {
        this.openSheet(t);
        if (t === 'disasters') this.showDisastersPanel();
      },
    });
    this.railSeg.el.querySelectorAll('button')[1].append(this.railBadge);
    this.disastersPanel = this.rail.el.querySelector<HTMLElement>('.disasters')!;
    this.layersPanel = this.rail.el.querySelector<HTMLElement>('.layers-panel')!;
    this.inspectorPanel = this.inspector.el.querySelector<HTMLElement>('.panel')!;
    this.rail.el.prepend(this.railSeg.el);
    this.rail.el.insertBefore(this.feed.el, this.layersPanel);
    this.feed.el.hidden = true;

    // remember the user's choice for the two desktop panels (their chevrons do the collapsing)
    const chev = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.panel-head .chev');
    chev(this.disastersPanel)?.addEventListener('click', () => this.userPanel('disasters', this.disastersPanel));
    chev(this.inspectorPanel)?.addEventListener('click', () => this.userPanel('inspector', this.inspectorPanel));

    // strip collapse tab (desktop)
    const stripTab = button({ icon: 'chevron', label: 'Stats', cls: 'small strip-tab', aria: 'Hide statistics' });
    this.stripTab = stripTab;
    stripTab.setAttribute('aria-expanded', 'true');
    stripTab.addEventListener('click', () => {
      const open = this.hud.dataset.strip !== 'open';
      this.setStrip(open);
      rememberPanel('stats', open);
    });

    // cinematic-mode controls (only visible while the Theater is open)
    this.panelsBtn = button({ label: 'Panels', cls: 'small', aria: 'Show or hide the side panels', onClick: () => this.cinemaPanels(this.hud.dataset.pl !== '1' && this.hud.dataset.pr !== '1' ? 'both' : 'none') });
    this.panelsBtn.setAttribute('aria-pressed', 'false');
    this.liveBtn = button({ icon: 'dockLive', label: 'Live negotiation', cls: 'small', aria: 'Show or hide the live negotiation feed', onClick: () => this.cinemaPanels(this.hud.dataset.pl === '1' && this.railTab === 'feed' ? 'none-left' : 'feed') });
    this.liveBtn.setAttribute('aria-pressed', 'false');
    const cinemaBar = h('div', { class: 'cinema-bar', role: 'group', 'aria-label': 'Theater panels' }, this.panelsBtn, this.liveBtn);

    this.hoverText = h('span', 'hover-text');
    this.hoverPill = h('div', { class: 'hover-pill', hidden: true, 'aria-hidden': 'true' }, h('span', 'dot'), this.hoverText);
    this.pickToast = h('div', { class: 'pick-toast', hidden: true, role: 'status' });
    this.help = helpCard();

    // mobile dock: one "Panels" button that opens the four panel buttons (collapsed by default)
    const dockItems: { sheet: Exclude<Sheet, ''>; label: string; ic: IconName }[] = [
      { sheet: 'disasters', label: 'Disasters', ic: 'dockDisasters' },
      { sheet: 'feed', label: 'Live', ic: 'dockLive' },
      { sheet: 'inspect', label: 'Inspect', ic: 'dockInspect' },
      { sheet: 'stats', label: 'Stats', ic: 'dockStats' },
    ];
    this.dockItems = h('div', { class: 'dock-items', id: 'dock-items', hidden: true });
    for (const d of dockItems) {
      const b = h('button', { class: 'btn dock-btn', type: 'button', 'aria-pressed': 'false' }, icon(d.ic, 20), h('span', { text: d.label }));
      b.addEventListener('click', () => {
        const hadFocus = this.dockItems.contains(document.activeElement);
        this.openSheet(this.hud.dataset.sheet === d.sheet ? '' : d.sheet);
        this.setDock(false);
        if (hadFocus) this.dockToggle.focus();
      });
      this.dockBtns.set(d.sheet, b);
      this.dockItems.append(b);
    }
    this.dockToggle = h(
      'button',
      { class: 'btn dock-toggle', type: 'button', 'aria-label': 'Panels', 'aria-controls': 'dock-items', 'aria-expanded': 'false' },
      h('span', 'dock-ic menu-ic', menuIcon(20)),
      h('span', 'dock-ic close-ic', icon('close', 18)),
      h('span', 'dock-toggle-text', 'Panels'),
    );
    this.dockToggle.addEventListener('click', () => this.setDock(!this.dockOpen));
    this.dock = h('nav', { class: 'dock', 'aria-label': 'Panel buttons', 'data-open': 'false' }, this.dockToggle, this.dockItems);

    // layer pill: one "Layers" button shows the active layer icon; the P / W toggles open from it
    this.rail.pill.id = 'layer-pill';
    this.layerGlyph = h('span', 'layers-glyph');
    this.layersToggle = h(
      'button',
      {
        class: 'pill-toggle layers-toggle',
        type: 'button',
        'aria-controls': 'layer-pill',
        'aria-expanded': 'false',
        'aria-label': 'Map layers',
        title: 'Map layers (P power, W water)',
      },
      this.layerGlyph,
      h('span', 'chev-ic', icon('chevron', 16)),
    );
    this.layersToggle.addEventListener('click', () => this.setLayers(!this.layersOpen));
    this.rail.pill.prepend(this.layersToggle);
    this.layersOpen = panelExpanded('layers');
    this.rail.pill.dataset.open = String(this.layersOpen);
    this.layersToggle.setAttribute('aria-expanded', String(this.layersOpen));
    if (typeof MutationObserver !== 'undefined') {
      this.layerObserver = new MutationObserver(() => this.syncLayerGlyph());
      this.layerObserver.observe(this.rail.pill, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
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
      this.stepper.el,
      cinemaBar,
      this.dock,
      this.welcome.el,
      this.coach.el,
    );
    this.setDock(panelExpanded('dock'), false);
    installTips(this.hud);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.hud.style.setProperty('--stepper-h', `${this.stepper.el.hidden ? 0 : Math.round(this.stepper.el.offsetHeight)}px`));
      this.ro.observe(this.stepper.el);
    }
    this.hud.addEventListener('hud-close-sheet', () => this.openSheet(''));
    this.root.append(this.hud);

    // engine
    this.unsubs.push(
      engine.on('tick', (s) => {
        this.history.sample(s, this.selected);
        this.story.onTick(s);
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
    this.syncLayerGlyph();

    const s0 = engine.snapshot;
    this.history.sample(s0, null);
    this.strip.reset(s0);
    this.rail.refreshTargets(s0);
    this.story.resync(s0);
    this.topbar.setStory(false);
    if (prefs.get(PREF.story) === '1') this.story.setOn(true);
    this.setStrip(this.hud.dataset.strip === 'open');
    this.savedStrip = this.hud.dataset.strip ?? 'closed';
    this.applyPanels();
    this.narrow.addEventListener('change', this.onNarrow);
    this.syncRailTab();
    this.refresh();
    this.timer = window.setInterval(() => {
      if (this.dirty) this.refresh();
      this.syncTheater();
      this.syncFeedVisible();
    }, 1000 / UI_HZ);

    const w = opts.welcome ?? 'auto';
    if (w === 'always' || (w === 'auto' && !prefs.get(PREF.welcomed))) this.welcome.open();
  }

  // ───────────────────────── story / replay / guide API ─────────────────────────

  /** Turn story mode on or off (remembered in localStorage). */
  setStoryMode(on: boolean) {
    this.story.setOn(on);
    this.topbar.setStory(this.story.on);
  }

  /** Open the replay with this id (from snapshot.negotiation.replays). Returns false if it is no longer stored. */
  openReplay(id: string, o: OpenOptions = {}): boolean {
    const r = this.engine.snapshot.negotiation?.replays?.find((x) => x.id === id);
    if (!r) return false;
    this.openReplayObj(r, o);
    return true;
  }

  closeReplay() {
    this.stepper.close(true);
  }

  /** Show or hide the Negotiation Theater (no-op when no theater was supplied). */
  toggleTheater() {
    const t = this.theater;
    if (!t) return;
    t.setVisible(!t.isVisible());
    this.syncTheater();
  }

  /** Switch the left rail to the live chat feed (and open it as a sheet on phones). */
  openFeed() {
    if (isMobile()) this.openSheet('feed');
    else this.setRailTab('feed');
  }

  showWelcome() {
    this.help.hidden = true;
    this.welcome.open();
  }

  /** Loads the guided scenario at 5x with story mode on, opens the feed and starts the coach marks. */
  startGuidedDemo() {
    this.setStoryMode(true);
    this.engine.loadScenario(this.guidedScenario);
    this.topbar.setScenario(this.guidedScenario);
    this.engine.setSpeed(5);
    this.topbar.setSpeed(5);
    this.engine.play();
    this.topbar.setRunning(true);
    this.openFeed();
    this.startCoach();
  }

  startCoach() {
    const steps: CoachStep[] = [
      {
        title: 'The live conversation',
        text: 'Each utility agent says what it needs and why, in its own words. The dashed box under a message shows the raw scores the AI model gave it.',
        anchor: () => this.feed.el,
        before: () => this.openFeed(),
        prefer: ['right'],
      },
      {
        title: 'Replay any negotiation',
        text: 'Every message has a Watch replay button. It steps through one negotiation: who asked for what, who gave way, and what the safety layer changed.',
        anchor: () => {
          const all = this.feed.el.querySelectorAll<HTMLElement>('.fd-replay:not(:disabled)');
          return all.length ? all[all.length - 1] : this.feed.el;
        },
        before: () => this.openFeed(),
        prefer: ['right'],
      },
    ];
    if (this.theater) {
      steps.push({
        title: 'Negotiation Theater',
        text: 'Open the Theater (or press T) for a full-screen view where every bid flies across the city as a glowing arc.',
        anchor: () => this.topbar.theaterButton,
        prefer: ['below'],
      });
    }
    steps.push(
      {
        title: 'Story mode',
        text: 'With story mode on, the simulation pauses at the big moments and walks you through the negotiation, then carries on by itself.',
        anchor: () => this.topbar.storySwitch,
        prefer: ['below'],
      },
      {
        title: 'Look inside any building',
        text: 'Click a building on the map, or a name in the feed, to see its agent: what it asked for, why, and what it finally got.',
        anchor: () => (isMobile() ? (this.dockBtns.get('inspect') ?? null) : this.inspector.el),
        before: () => {
          if (isMobile()) {
            this.openSheet('');
            this.setDock(true, false); // the Inspect button lives in the dock, so open it
          } else this.expandInspector();
        },
        prefer: isMobile() ? ['above'] : ['left'],
      },
    );
    this.coach.start(steps);
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
    this.feed.setSelected(this.selected);
    if (this.cinema && this.selected) this.hud.dataset.pr = '1'; // show the inspector for the picked agent
    if (this.selected && !isMobile()) this.expandInspector();
    if (isMobile()) this.openSheet(this.selected ? 'inspect' : '');
    this.dirty = true;
  }

  openSheet(name: Sheet) {
    this.hud.dataset.sheet = name;
    for (const [k, b] of this.dockBtns) b.setAttribute('aria-pressed', String(k === name));
    if (name === 'feed') this.setRailTab('feed');
    else if (name === 'disasters') this.setRailTab('disasters');
  }

  destroy() {
    window.clearInterval(this.timer);
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('pointerdown', this.onDocPointer);
    this.narrow.removeEventListener('change', this.onNarrow);
    this.layerObserver?.disconnect();
    this.ro?.disconnect();
    this.coach.end(false);
    this.stepper.close(false);
    this.unsubs.forEach((u) => u());
    this.hud.remove();
  }

  // ───────────────────────── internals ─────────────────────────

  private openReplayObj(r: NegotiationReplay, o: OpenOptions = {}) {
    if (isMobile() && this.hud.dataset.sheet) this.openSheet('');
    this.hud.dataset.stepper = 'open';
    this.stepper.open(r, o);
  }

  private setRailTab(t: RailTab) {
    this.railTab = t;
    this.syncRailTab();
  }

  private syncRailTab() {
    const t = this.railTab;
    this.railSeg.set(t);
    this.rail.el.dataset.tab = t;
    this.disastersPanel.hidden = t !== 'disasters';
    this.layersPanel.hidden = t !== 'disasters';
    this.feed.el.hidden = t !== 'feed';
    this.syncFeedVisible();
  }

  private syncFeedVisible() {
    const vis = this.railTab === 'feed' && (!isMobile() || this.hud.dataset.sheet === 'feed');
    if (vis !== this.feedShown) {
      this.feedShown = vis;
      this.feed.setVisible(vis);
    }
  }

  private syncTheater() {
    if (!this.theater) return;
    const on = this.theater.isVisible();
    this.topbar.setTheater(on);
    if (on !== this.cinema) this.setCinema(on);
  }

  private setStrip(open: boolean) {
    this.hud.dataset.strip = open ? 'open' : 'closed';
    this.stripTab.setAttribute('aria-expanded', String(open));
    this.stripTab.setAttribute('aria-label', open ? 'Hide statistics' : 'Show statistics');
  }

  /** Mobile dock: the "Panels" button shows or hides the four panel buttons. */
  private setDock(open: boolean, persist = true) {
    this.dockOpen = open;
    this.dock.dataset.open = String(open);
    this.dockItems.hidden = !open;
    this.dockToggle.setAttribute('aria-expanded', String(open));
    if (persist) rememberPanel('dock', open);
  }

  /** Layer pill: the "Layers" button shows or hides the Power lines / Water network toggles. */
  private setLayers(open: boolean, persist = true) {
    this.layersOpen = open;
    this.rail.pill.dataset.open = String(open);
    this.layersToggle.setAttribute('aria-expanded', String(open));
    if (persist) rememberPanel('layers', open);
  }

  /** Collapsed button shows the active layer icon(s); the globe when none is on. */
  private syncLayerGlyph() {
    const icons: IconName[] = [];
    for (const b of this.rail.pill.querySelectorAll<HTMLElement>('.pill-toggle[aria-pressed="true"]')) {
      icons.push(b.classList.contains('power') ? 'power' : 'water');
    }
    this.layerGlyph.replaceChildren(...(icons.length ? icons : (['globe'] as IconName[])).map((n) => icon(n, 20)));
  }

  /** Desktop panels: the Disasters panel and the Inspector start collapsed; phones show them as sheets (always open). */
  private applyPanels() {
    const desk = !isMobile();
    this.setPanelCollapsed(this.disastersPanel, desk && !this.panelOpen.disasters);
    this.setPanelCollapsed(this.inspectorPanel, desk && !this.panelOpen.inspector);
  }

  private setPanelCollapsed(el: HTMLElement, collapsed: boolean) {
    el.dataset.collapsed = String(collapsed);
    const c = el.querySelector<HTMLButtonElement>('.panel-head .chev');
    const title = el.querySelector('.panel-title')?.textContent ?? '';
    c?.setAttribute('aria-expanded', String(!collapsed));
    c?.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${title}`);
  }

  /** The user clicked a desktop panel's chevron: remember the new state. */
  private userPanel(key: 'disasters' | 'inspector', el: HTMLElement) {
    if (isMobile()) return; // on phones the chevron closes the sheet instead
    this.panelOpen[key] = el.dataset.collapsed !== 'true';
    rememberPanel(key, this.panelOpen[key]);
  }

  /** Opens the Inspector on desktop (a building was picked, or the guided tour points at it). Not remembered. */
  private expandInspector() {
    if (isMobile()) return;
    this.panelOpen.inspector = true;
    this.applyPanels();
  }

  /** Picking the Disasters tab on desktop also opens its panel. */
  private showDisastersPanel() {
    if (isMobile()) return;
    this.panelOpen.disasters = true;
    this.applyPanels();
  }

  private onNarrow = () => this.applyPanels();

  /** Theater open: slide the side panels out, collapse the KPI strip; restore on close. */
  private setCinema(on: boolean) {
    if (isMobile()) return;
    this.cinema = on;
    if (on) {
      this.savedStrip = this.hud.dataset.strip ?? 'open';
      this.setStrip(false);
      this.hud.dataset.cinema = 'on';
      this.cinemaPanels('none');
    } else {
      delete this.hud.dataset.cinema;
      delete this.hud.dataset.pl;
      delete this.hud.dataset.pr;
      this.setStrip(this.savedStrip === 'open');
    }
  }

  private cinemaPanels(mode: 'both' | 'none' | 'feed' | 'none-left') {
    const d = this.hud.dataset;
    if (mode === 'both') {
      d.pl = '1';
      d.pr = '1';
    } else if (mode === 'none') {
      d.pl = '0';
      d.pr = '0';
    } else if (mode === 'feed') {
      d.pl = '1';
      this.setRailTab('feed');
    } else d.pl = '0';
    this.panelsBtn.setAttribute('aria-pressed', String(d.pl === '1' && d.pr === '1'));
    this.liveBtn.setAttribute('aria-pressed', String(d.pl === '1' && this.railTab === 'feed'));
  }

  private onReset(s: SimSnapshot) {
    const sid = (this.engine as { scenarioId?: string | null }).scenarioId;
    if (sid) this.topbar.setScenario(sid);
    this.story.resync(s);
    if (this.stepper.isOpen) this.stepper.close(false);
    this.feed.reset();
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
    this.feed.update(s);
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
    if (this.layersOpen && !this.rail.pill.contains(e.target as Node)) this.setLayers(false);
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (t?.closest('.welcome, .coach')) return; // their own handlers own the keyboard
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
    else if (k === 't' || k === 'T') this.toggleTheater();
    else if (k === '?') this.toggleHelp();
    else if (k === 'Escape') {
      if (this.rail.isPicking) this.rail.cancel();
      else if (!this.help.hidden) this.help.hidden = true;
      else if (this.layersOpen) {
        const had = this.rail.pill.contains(document.activeElement);
        this.setLayers(false);
        if (had) this.layersToggle.focus();
      } else if (this.dockOpen) {
        const had = this.dockItems.contains(document.activeElement);
        this.setDock(false);
        if (had) this.dockToggle.focus();
      } else if (this.stepper.isOpen) this.stepper.close(true);
      else if (this.selected) this.select(null);
      else if (this.hud.dataset.sheet) this.openSheet('');
    }
  };
}
