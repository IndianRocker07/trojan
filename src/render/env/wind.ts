import * as THREE from 'three';

/**
 * One shared wind for the whole landscape: grass, trees, flowers and the terrain's
 * "wind sheen" all read the same uniforms, so gusts visibly travel across the meadow,
 * then through the trees, as one coherent wave.
 *
 * API (stable — other env modules depend on it):
 *   WIND                    the shared uniform objects (time advanced by updateWind)
 *   updateWind(t)           call once per frame (env/index.ts does this)
 *   applyWind(mat, opts)    bend vertices of a (possibly instanced) mesh with the wind
 *   applyWindSheen(mat)     brighten/shift a ground material where gusts pass
 *   windGustAt(x, z, t)     CPU mirror of the GLSL gust (for particles, birds, leaves)
 * The grass agent may tune the GLSL/CPU gust *constants* below; keep both versions in sync.
 */
export const WIND = {
  uWindTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.82, 0.57).normalize() },
  uWindStrength: { value: 1 },
};

export function updateWind(t: number): void {
  WIND.uWindTime.value = t;
}

export const WIND_GLSL = /* glsl */ `
uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;

float windHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float windNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(windHash(i), windHash(i + vec2(1.0, 0.0)), f.x),
             mix(windHash(i + vec2(0.0, 1.0)), windHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// 0..1 gust strength travelling along uWindDir: broad rolling waves broken up by noise.
float windGust(vec2 p) {
  float t = uWindTime;
  float along = dot(p, uWindDir);
  float across = dot(p, vec2(-uWindDir.y, uWindDir.x));
  float w1 = sin(along * 0.030 - t * 1.35 + sin(across * 0.011) * 2.2);
  float w2 = sin(along * 0.071 - t * 2.40 + across * 0.019);
  float patchy = windNoise((p - uWindDir * t * 14.0) * 0.012);
  float g = 0.5 + 0.5 * (w1 * 0.62 + w2 * 0.38);
  return clamp(g * g * (0.45 + patchy * 0.9), 0.0, 1.0) * uWindStrength;
}
`;

const fract = (x: number) => x - Math.floor(x);
const h2 = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
function noise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = h2(ix, iy) + (h2(ix + 1, iy) - h2(ix, iy)) * fx;
  const b = h2(ix, iy + 1) + (h2(ix + 1, iy + 1) - h2(ix, iy + 1)) * fx;
  return a + (b - a) * fy;
}

/** CPU mirror of windGust() (keep in sync with WIND_GLSL). */
export function windGustAt(x: number, z: number, t = WIND.uWindTime.value): number {
  const d = WIND.uWindDir.value;
  const along = x * d.x + z * d.y;
  const across = -x * d.y + z * d.x;
  const w1 = Math.sin(along * 0.03 - t * 1.35 + Math.sin(across * 0.011) * 2.2);
  const w2 = Math.sin(along * 0.071 - t * 2.4 + across * 0.019);
  const patchy = noise2((x - d.x * t * 14) * 0.012, (z - d.y * t * 14) * 0.012);
  const g = 0.5 + 0.5 * (w1 * 0.62 + w2 * 0.38);
  return Math.min(1, Math.max(0, g * g * (0.45 + patchy * 0.9))) * WIND.uWindStrength.value;
}

export interface WindOptions {
  /** Local-space height (model units, before instance scale) at which the bend reaches full amount. */
  height: number;
  /** Max horizontal sway (m) at full height under a full gust. */
  amplitude: number;
  /** Bend curve exponent: 1 = linear (stiff trunk), 2 = whippy grass. Default 1.8. */
  curve?: number;
  /** Fast per-instance flutter on top of the gust, as a fraction of amplitude. Default 0.25. */
  flutter?: number;
  /** Flutter frequency (rad/s). Default 3.2. */
  flutterSpeed?: number;
}

/**
 * Bend the vertices of `material` with the wind (in world space, after the instance and model
 * transforms, so instance rotations do not matter). Vertices at local y ≤ 0 stay planted.
 * Works with MeshToonMaterial / MeshStandardMaterial / MeshBasicMaterial, instanced or not.
 * Keeps fog, lighting and vertex colours. Do not share the material with non-wind meshes.
 */
export function applyWind(material: THREE.Material, opts: WindOptions): void {
  const curve = opts.curve ?? 1.8;
  const flutter = opts.flutter ?? 0.25;
  const flutterSpeed = opts.flutterSpeed ?? 3.2;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uWindTime = WIND.uWindTime;
    shader.uniforms.uWindDir = WIND.uWindDir;
    shader.uniforms.uWindStrength = WIND.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_GLSL}`)
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          vec4 windRoot = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        #else
          vec4 windRoot = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        #endif
        vec4 windWorld = modelMatrix * mvPosition;
        float windH = pow(clamp(transformed.y / ${opts.height.toFixed(4)}, 0.0, 1.0), ${curve.toFixed(3)});
        float windPhase = windHash(floor(windRoot.xz * 0.5)) * 6.2831;
        float windG = windGust(windRoot.xz);
        float windF = sin(uWindTime * ${flutterSpeed.toFixed(3)} + windPhase + windRoot.x * 0.21) * ${flutter.toFixed(3)};
        vec2 windSide = vec2(-uWindDir.y, uWindDir.x) * sin(uWindTime * ${(flutterSpeed * 0.63).toFixed(3)} + windPhase * 1.7) * ${(flutter * 0.6).toFixed(3)};
        vec2 windOff = (uWindDir * (windG * 0.85 + 0.15 + windF) + windSide) * windH * ${opts.amplitude.toFixed(4)};
        windWorld.xz += windOff;
        windWorld.y -= dot(windOff, windOff) * 0.5 / max(0.001, ${opts.height.toFixed(4)});
        mvPosition = viewMatrix * windWorld;
        gl_Position = projectionMatrix * mvPosition;
        `,
      );
  };
  material.customProgramCacheKey = () => `wind-${opts.height}-${opts.amplitude}-${curve}-${flutter}-${flutterSpeed}`;
  material.needsUpdate = true;
}

/**
 * Ground "wind sheen": as a gust passes, the grass lies over and shows its lighter side, so
 * bright bands sweep across the meadow. Strength is multiplied by a per-vertex float attribute
 * `sheen` (0..1) when the geometry has one (define USE_SHEEN_ATTR via opts.attribute = true).
 */
export function applyWindSheen(material: THREE.Material, opts: { strength?: number; attribute?: boolean } = {}): void {
  const strength = opts.strength ?? 0.22;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uWindTime = WIND.uWindTime;
    shader.uniforms.uWindDir = WIND.uWindDir;
    shader.uniforms.uWindStrength = WIND.uWindStrength;
    const attr = opts.attribute ? 'attribute float sheen;\n' : '';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${attr}varying vec3 vSheenWorld;\nvarying float vSheenAmt;`)
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\nvSheenWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSheenAmt = ${opts.attribute ? 'sheen' : '1.0'};`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WIND_GLSL}\nvarying vec3 vSheenWorld;\nvarying float vSheenAmt;`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        float sheenG = windGust(vSheenWorld.xz);
        sheenG = smoothstep(0.35, 0.95, sheenG) * vSheenAmt;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 1.16, 0.92) + vec3(0.035, 0.04, 0.0), sheenG * ${(strength / 0.22).toFixed(3)});`,
      );
  };
  material.customProgramCacheKey = () => `sheen-${strength}-${opts.attribute ? 1 : 0}`;
  material.needsUpdate = true;
}
