import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Building, BuildingKind } from '../core/types';
import type { BuildingInfo } from './batch';

const FALLBACK_CSS = `
:where(.map-label){background:#fff;border:2px solid #121310;border-radius:999px;padding:1px 9px 1px 6px;font:600 12px Inter,system-ui,sans-serif;color:#121310;white-space:nowrap;display:flex;align-items:center;gap:6px;pointer-events:none;box-shadow:0 2px 0 0 #121310}
:where(.map-label .dot){width:9px;height:9px;border-radius:50%;border:2px solid #121310;background:#5fc52e;flex:none}
:where(.map-label[data-status="brownout"] .dot){background:#ff8a00}
:where(.map-label[data-status="backup"] .dot){background:#ffd60a}
:where(.map-label[data-status="offline"] .dot){background:#ff4a2e}
:where(.map-label[data-status="destroyed"] .dot){background:#121310}
`;

const LABELLED = new Set<BuildingKind>(['hospital', 'emergency', 'water', 'school', 'substation', 'generator']);

/** CSS2D map labels (pills) for key buildings + a transient hover label for the rest. */
export class Labels {
  readonly renderer = new CSS2DRenderer();
  readonly group = new THREE.Group();
  private items = new Map<string, { obj: CSS2DObject; el: HTMLDivElement; status: string; minor: boolean }>();
  private hoverObj: CSS2DObject;
  private hoverEl: HTMLDivElement;
  private hoverId: string | null = null;
  private infos = new Map<string, BuildingInfo>();
  private names = new Map<string, string>();
  private on = true;
  private style: HTMLStyleElement | null = null;

  constructor(container: HTMLElement) {
    const el = this.renderer.domElement;
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.pointerEvents = 'none';
    el.style.overflow = 'hidden';
    container.appendChild(el);
    if (!document.getElementById('trojan-map-label-fallback')) {
      this.style = document.createElement('style');
      this.style.id = 'trojan-map-label-fallback';
      this.style.textContent = FALLBACK_CSS;
      document.head.appendChild(this.style);
    }
    this.hoverEl = this.makeEl('', 'online');
    this.hoverEl.classList.add('is-hover');
    this.hoverObj = new CSS2DObject(this.hoverEl);
    this.hoverObj.center.set(0.5, 1);
    this.hoverObj.visible = false;
    this.group.add(this.hoverObj);
  }

  private makeEl(name: string, status: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = 'map-label';
    d.dataset.status = status;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    d.append(dot, n);
    return d;
  }

  build(buildings: Record<string, Building>, infos: Map<string, BuildingInfo>): void {
    for (const it of this.items.values()) it.obj.removeFromParent();
    this.items.clear();
    this.infos = infos;
    this.names.clear();
    for (const b of Object.values(buildings)) {
      this.names.set(b.id, b.name);
      const info = infos.get(b.id);
      if (!info || !LABELLED.has(b.kind)) continue;
      const el = this.makeEl(b.name, b.status);
      const obj = new CSS2DObject(el);
      obj.center.set(0.5, 1);
      obj.position.set(info.cx, info.height + 2.5, info.cz);
      this.group.add(obj);
      this.items.set(b.id, { obj, el, status: b.status, minor: b.kind === 'school' || b.kind === 'emergency' || b.kind === 'substation' });
    }
    for (const it of this.items.values()) it.obj.visible = this.on && !(this.far && it.minor);
  }

  sync(buildings: Record<string, Building>): void {
    for (const [id, it] of this.items) {
      const st = buildings[id]?.status;
      if (st && st !== it.status) {
        it.status = st;
        it.el.dataset.status = st;
      }
    }
    if (this.hoverId) {
      const st = buildings[this.hoverId]?.status;
      if (st) this.hoverEl.dataset.status = st;
    }
  }

  setHover(id: string | null, buildings: Record<string, Building>): void {
    this.hoverId = id;
    const info = id ? this.infos.get(id) : undefined;
    if (!id || !info || this.items.has(id)) {
      this.hoverObj.visible = false;
      return;
    }
    (this.hoverEl.querySelector('.name') as HTMLElement).textContent = this.names.get(id) ?? id;
    this.hoverEl.dataset.status = buildings[id]?.status ?? 'online';
    this.hoverObj.position.set(info.cx, info.height + 2.5, info.cz);
    this.hoverObj.visible = true;
  }

  private far = false;
  /** Hide minor labels when zoomed far out. */
  setDistance(d: number): void {
    const far = d > 640;
    if (far === this.far) return;
    this.far = far;
    this.setVisible(this.on);
  }

  setVisible(on: boolean): void {
    this.on = on;
    for (const it of this.items.values()) it.obj.visible = on && !(this.far && it.minor);
  }

  setSize(w: number, h: number): void {
    this.renderer.setSize(w, h);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
  }

  dispose(): void {
    this.renderer.domElement.remove();
    this.style?.remove();
    this.group.removeFromParent();
  }
}
