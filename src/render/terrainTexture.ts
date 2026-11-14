import * as THREE from 'three';

const fract = (x: number) => x - Math.floor(x);
const lattice = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
const fade = (x: number) => x * x * (3 - 2 * x);

function periodicNoise(u: number, v: number, cells: number): number {
  const x = u * cells;
  const y = v * cells;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const at = (ix: number, iy: number) => lattice((ix % cells + cells) % cells, (iy % cells + cells) % cells);
  const a = THREE.MathUtils.lerp(at(x0, y0), at(x0 + 1, y0), tx);
  const b = THREE.MathUtils.lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx);
  return THREE.MathUtils.lerp(a, b, ty);
}

/** Seamless grayscale microtexture: grass blades and ground grain tinted by the terrain material. */
export function makeGrassDetailTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas 2D is unavailable for terrain texturing');

  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const broad = periodicNoise(u, v, 7) - 0.5;
      const medium = periodicNoise(u, v, 19) - 0.5;
      const fine = periodicNoise(u, v, 47) - 0.5;
      const value = Math.round(224 + broad * 25 + medium * 30 + fine * 24);
      const i = (y * size + x) * 4;
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // Short, varied blades provide directional texture without a repeating photo-like pattern.
  let seed = 7741;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 24000; i++) {
    const x = random() * size;
    const y = random() * size;
    const len = 2 + random() * 6;
    const angle = (random() - 0.5) * 1.8 - Math.PI / 2;
    const light = random() > 0.55;
    ctx.strokeStyle = light ? 'rgba(255,255,255,0.22)' : 'rgba(48,48,48,0.20)';
    ctx.lineWidth = 0.55 + random() * 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(angle) * len * 0.55 + 1, y + Math.sin(angle) * len * 0.55, x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
    const copiesX = x < 8 ? [size] : x > size - 8 ? [-size] : [0];
    const copiesY = y < 8 ? [size] : y > size - 8 ? [-size] : [0];
    if (copiesX[0] !== 0 || copiesY[0] !== 0) {
      for (const dx of copiesX) for (const dy of copiesY) {
        ctx.beginPath();
        ctx.moveTo(x + dx, y + dy);
        ctx.quadraticCurveTo(x + dx + Math.cos(angle) * len * 0.55 + 1, y + dy + Math.sin(angle) * len * 0.55, x + dx + Math.cos(angle) * len, y + dy + Math.sin(angle) * len);
        ctx.stroke();
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
