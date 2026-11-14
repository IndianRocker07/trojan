/** The one cartoon character: a flat utility worker with a hard hat and noodle arms. DESIGN.md §4. */
export function createWorker(): SVGElement {
  const w = document.createElement('span');
  w.innerHTML = `
<svg viewBox="0 0 120 132" width="112" height="124" role="img" aria-label="Friendly utility worker waving" class="worker">
  <ellipse cx="60" cy="124" rx="34" ry="6" fill="#f3ead0" stroke="#121310" stroke-width="3"/>
  <g stroke="#121310" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">
    <rect x="44" y="84" width="13" height="32" rx="3" fill="#0a7cff"/>
    <rect x="63" y="84" width="13" height="32" rx="3" fill="#0a7cff"/>
    <path d="M40 120h19v-6H44z" fill="#121310"/>
    <path d="M61 120h19l-3-6H61z" fill="#121310"/>
    <path d="M37 52h46l4 38H33z" fill="#ff8a00"/>
    <path d="M36 70h48l.8 8H35.2z" fill="#ffd60a"/>
    <path d="M52 52l8 12 8-12" fill="#fff"/>
    <path d="M38 58C24 62 20 76 26 88" fill="none" stroke-width="6"/>
    <path d="M38 58C24 62 20 76 26 88" fill="none" stroke="#ff8a00" stroke-width="2.4"/>
    <circle cx="27" cy="91" r="5.5" fill="#ffcf9f"/>
    <g class="wave">
      <path d="M82 56C98 52 104 40 100 28" fill="none" stroke-width="6"/>
      <path d="M82 56C98 52 104 40 100 28" fill="none" stroke="#ff8a00" stroke-width="2.4"/>
      <circle cx="100" cy="24" r="5.5" fill="#ffcf9f"/>
    </g>
    <circle cx="60" cy="38" r="17" fill="#ffcf9f"/>
    <circle cx="54" cy="38" r="2" fill="#121310" stroke="none"/>
    <circle cx="67" cy="38" r="2" fill="#121310" stroke="none"/>
    <path d="M53 45q7 6 14 0" fill="none"/>
    <path d="M41 32a19 17 0 0 1 38 0z" fill="#ffd60a"/>
    <rect x="37" y="30" width="46" height="6" rx="3" fill="#ffd60a"/>
    <path d="M60 15v15" fill="none"/>
  </g>
</svg>`;
  return w.firstElementChild as SVGElement;
}
