/**
 * One shared tooltip for every `[data-tip]` element: shows on hover and keyboard focus, hides on Esc / leave / blur.
 * Native `title` is not used because it never appears on focus or touch.
 */
import { h } from './widgets';

export function installTips(root: HTMLElement): void {
  const el = h('div', { class: 'tip', role: 'tooltip', id: 'ux-tip', hidden: true });
  root.append(el);
  let cur: HTMLElement | null = null;

  const hide = () => {
    if (!cur) return;
    cur.removeAttribute('aria-describedby');
    cur = null;
    el.hidden = true;
  };
  const show = (t: HTMLElement) => {
    cur = t;
    el.textContent = t.dataset.tip ?? '';
    el.hidden = false;
    t.setAttribute('aria-describedby', 'ux-tip');
    const r = t.getBoundingClientRect();
    const w = el.offsetWidth;
    const hh = el.offsetHeight;
    let x = r.left + r.width / 2 - w / 2;
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    let y = r.top - hh - 10;
    if (y < 8) y = Math.min(window.innerHeight - hh - 8, r.bottom + 10);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  };
  const target = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tip]') : null);

  root.addEventListener('mouseover', (e) => {
    const t = target(e);
    if (t) {
      if (t !== cur) show(t);
    } else hide();
  });
  root.addEventListener('mouseleave', hide);
  root.addEventListener('focusin', (e) => {
    const t = target(e);
    if (t) show(t);
    else hide();
  });
  root.addEventListener('focusout', hide);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  window.addEventListener('scroll', hide, true);
}

/** Props that make an element show a plain-words tooltip. */
export const tipProps = (text: string) => ({ 'data-tip': text });
