/** Tiny localStorage wrapper. Every access is guarded: private windows / blocked storage must never break the UI. */
const PREFIX = 'trojan.';

export const prefs = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(PREFIX + key, value);
    } catch {
      /* storage unavailable: the choice just is not remembered */
    }
  },
};

export const PREF = { welcomed: 'welcomed', story: 'story', coached: 'coached' } as const;

/** Collapsible controls. Each remembers the user's last expanded (1) / collapsed (0) choice. */
export const PANEL = {
  dock: 'panel.dock',
  layers: 'panel.layers',
  disasters: 'panel.disasters',
  inspector: 'panel.inspector',
  stats: 'panel.stats',
} as const;
export type PanelKey = keyof typeof PANEL;

/** `?panels=open` forces every collapsible control expanded, `?panels=closed` collapsed (testing, screenshots). null = no override. */
export function panelsOverride(): boolean | null {
  try {
    const v = new URLSearchParams(window.location.search).get('panels');
    if (v === 'open') return true;
    if (v === 'closed') return false;
  } catch {
    /* no location: no override */
  }
  return null;
}

/** Remembered state of one control. Nothing stored, or storage blocked, means collapsed. */
export function panelExpanded(key: PanelKey): boolean {
  const forced = panelsOverride();
  if (forced !== null) return forced;
  return prefs.get(PANEL[key]) === '1';
}

/** Remember a user choice. Forced (`?panels=`) sessions do not overwrite the saved choice. */
export function rememberPanel(key: PanelKey, expanded: boolean): void {
  if (panelsOverride() === null) prefs.set(PANEL[key], expanded ? '1' : '0');
}
