/** Tiny typed event emitter. */
export class Emitter<E extends object> {
  private map = new Map<keyof E, Set<(p: any) => void>>();
  on<K extends keyof E>(k: K, fn: (p: E[K]) => void): () => void {
    if (!this.map.has(k)) this.map.set(k, new Set());
    this.map.get(k)!.add(fn);
    return () => this.map.get(k)!.delete(fn);
  }
  emit<K extends keyof E>(k: K, p: E[K]): void {
    this.map.get(k)?.forEach((fn) => fn(p));
  }
}
