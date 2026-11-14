import * as THREE from 'three';

/**
 * High-contrast "Friendly Illustrated" palette for the 3D city (see DESIGN.md).
 * Every model MUST take materials from MAT so the renderer can merge geometry
 * by material. Never create ad-hoc materials inside a model builder.
 */
export const COLORS = {
  ink: 0x121310,
  cream: 0xfbf6e6,
  paper: 0xffffff,
  sand: 0xe6dcc0,
  green: 0x5fc52e,
  greenDeep: 0x2f8f1c,
  blue: 0x0a7cff,
  blueDeep: 0x0b4fb3,
  yellow: 0xffd60a,
  coral: 0xff4a2e,
  red: 0xe5141f,
  lilac: 0xa77bff,
  pink: 0xff7aa8,
  orange: 0xff8a00,
  teal: 0x00b3a4,
  asphalt: 0x2b2d2a,
  concrete: 0xcfc8b4,
  siding: 0xd9d1c1,
  roofShingle: 0x4b525b,
  brick: 0x99634e,
  wallSage: 0x91a18a,
  wallBlueGray: 0x9aabb4,
  steel: 0x8e98a4,
  steelDark: 0x4a525c,
  wood: 0xb9783f,
  glassOff: 0x1d2a3a,
  glowOn: 0xffe24a,
  water: 0x1e8cff,
} as const;

/** 3-step toon ramp: crisp light/mid/shadow bands, no gradients. */
function toonRamp(): THREE.DataTexture {
  const data = new Uint8Array([90, 90, 90, 255, 185, 185, 185, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
const RAMP = toonRamp();

const toon = (color: number) => new THREE.MeshToonMaterial({ color, gradientMap: RAMP });

export const MAT = {
  // structure
  wallWhite: toon(COLORS.paper),
  wallCream: toon(COLORS.cream),
  wallSand: toon(COLORS.sand),
  wallBlue: toon(COLORS.blue),
  wallCoral: toon(COLORS.coral),
  wallLilac: toon(COLORS.lilac),
  wallPink: toon(COLORS.pink),
  wallYellow: toon(COLORS.yellow),
  wallGreen: toon(COLORS.green),
  wallTeal: toon(COLORS.teal),
  wallSage: toon(COLORS.wallSage),
  wallBlueGray: toon(COLORS.wallBlueGray),
  siding: toon(COLORS.siding),
  brick: toon(COLORS.brick),
  concrete: toon(COLORS.concrete),
  // roofs
  roofCoral: toon(COLORS.coral),
  roofBlue: toon(COLORS.blueDeep),
  roofInk: toon(COLORS.asphalt),
  roofGreen: toon(COLORS.greenDeep),
  roofShingle: toon(COLORS.roofShingle),
  roofSand: toon(COLORS.sand),
  // details
  ink: toon(COLORS.ink),
  steel: toon(COLORS.steel),
  steelDark: toon(COLORS.steelDark),
  wood: toon(COLORS.wood),
  red: toon(COLORS.red),
  orange: toon(COLORS.orange),
  yellow: toon(COLORS.yellow),
  green: toon(COLORS.green),
  blue: toon(COLORS.blue),
  water: toon(COLORS.water),
  glass: toon(COLORS.glassOff),
  // ground
  grass: toon(COLORS.green),
  asphalt: toon(COLORS.asphalt),
  paving: toon(COLORS.sand),

  /**
   * role:'glow' — windows, lamps, signs that light up when the building is powered.
   * Unlit MeshBasic so it reads as emitted light; the renderer swaps its colour per building.
   */
  glow: new THREE.MeshBasicMaterial({ color: COLORS.glowOn }),
  /** role:'beacon' — red aviation/warning light that blinks. */
  beacon: new THREE.MeshBasicMaterial({ color: COLORS.red }),
} as const;

export type MatName = keyof typeof MAT;

/** Colour of glow meshes when a building is unpowered. */
export const GLOW_OFF = new THREE.Color(COLORS.glassOff);
export const GLOW_ON = new THREE.Color(COLORS.glowOn);
export const GLOW_BACKUP = new THREE.Color(COLORS.orange);
