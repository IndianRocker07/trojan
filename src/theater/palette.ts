/** Theater palette (docs/STORY.md §1). THREE.Color converts sRGB hex → linear working space. */
import * as THREE from 'three';

const c = (hex: number) => new THREE.Color(hex);

export const PAL = {
  bgCenter: c(0x0b1440),
  bgEdge: c(0x040918),
  sphereDay: c(0x0c1748),
  sphereNight: c(0x02050f),
  rim: c(0x3d7bff),
  dotA: c(0x7c83ff),
  dotB: c(0xb9a6ff),
  dotBuilt: c(0xd9d0ff),
  park: c(0x86b4ff),
  river: c(0x2b3a8c),
  destroyed: c(0xff6b5e).multiplyScalar(0.55),
  flooded: c(0x5fd3ff).multiplyScalar(0.5),
  burning: c(0xff9a3c).multiplyScalar(0.7),
  // arcs
  bid: c(0xff6ad5),
  notice: c(0xff9be6),
  concede: c(0xa98bff),
  contract: c(0xffc65a),
  grant: c(0xff4fcb),
  beam: c(0xff6ad5),
  // spikes / nodes
  spike: c(0x3aa0ff),
  node: c(0xffe6fa),
  nodePink: c(0xff6ad5),
  nodeDim: c(0x9aa4ff),
  house: c(0x9aa4ff),
  hub: c(0xff8fe0),
  shield: c(0x6ff3ff),
  red: c(0xff3b4e),
};

export const CSS = {
  ink: '#050b1f',
  panel: 'rgba(9, 15, 48, 0.92)',
  border: '#b9a6ff',
  pink: '#ff6ad5',
  text: '#f3f1ff',
  dim: '#a9a8d8',
  cyan: '#6ff3ff',
  gold: '#ffc65a',
};
