/** Round kind avatars (flat glyph + fill) for the chat feed and the replay table. Name is always shown next to them. */
import type { ConsumerKind } from '../core/types';

export type AvatarKind = ConsumerKind | 'clearing' | 'safety';

const S = 'stroke="#121310" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
const GLYPH: Record<AvatarKind, string> = {
  hospital: `<path d="M9 4h6v5h5v6h-5v5H9v-5H4V9h5z" fill="#fff" ${S}/>`,
  emergency: `<path d="M6 19v-6a6 6 0 0 1 12 0v6z" fill="#fff" ${S}/><path d="M4 19h16M12 3v2.5" fill="none" ${S}/>`,
  water: `<path d="M12 3C15 7.5 18.5 10.5 18.5 14.5a6.5 6.5 0 0 1-13 0C5.5 10.5 9 7.5 12 3z" fill="#fff" ${S}/>`,
  telecom: `<path d="M12 11v10M8 21h8" fill="none" ${S}/><circle cx="12" cy="8.5" r="2" fill="#fff" ${S}/><path d="M7.5 4.5a6 6 0 0 0 0 8M16.5 4.5a6 6 0 0 1 0 8" fill="none" ${S}/>`,
  school: `<path d="M4 20V10l8-6 8 6v10z" fill="#fff" ${S}/><path d="M10 20v-5h4v5" fill="none" ${S}/>`,
  house: `<path d="M3.5 11.5 12 4l8.5 7.5" fill="none" ${S}/><path d="M6 10v10h12V10" fill="#fff" ${S}/>`,
  clearing: `<circle cx="12" cy="12" r="3.2" fill="#fff" ${S}/><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" fill="none" ${S}/>`,
  safety: `<path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z" fill="#fff" ${S}/><polyline points="8.5,12 11,14.5 15.5,9.5" fill="none" ${S}/>`,
};

export function kindAvatar(kind: string, size = 32): HTMLElement {
  const k = (kind in GLYPH ? kind : 'house') as AvatarKind;
  const el = document.createElement('span');
  el.className = 'av';
  el.dataset.kind = k;
  el.style.width = el.style.height = `${size}px`;
  el.innerHTML = `<svg viewBox="0 0 24 24" width="${Math.round(size * 0.66)}" height="${Math.round(size * 0.66)}" aria-hidden="true" focusable="false">${GLYPH[k]}</svg>`;
  return el;
}
