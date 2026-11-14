/**
 * Browser-safe Jev perception client. Talks to the Vite middleware (server/vitePlugin.ts), which holds the
 * API key; the key never reaches the page. The only fetch in src/negotiation (docs §0).
 */
import type { Perception, PerceptionInput, PerceptionProvider } from '../core/types';

export class HttpJevProvider implements PerceptionProvider {
  readonly name = 'jev';
  private readonly url: string;

  constructor(url = '/api/jev') {
    this.url = url;
  }

  async perceive(inputs: PerceptionInput[], signal?: AbortSignal): Promise<Perception[]> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs }),
      signal,
    });
    if (res.status === 503) throw new Error('no_api_key');
    if (!res.ok) throw new Error(`jev request failed: HTTP ${res.status}`);

    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || !Array.isArray((body as { perceptions?: unknown }).perceptions)) {
      throw new Error('jev response malformed: expected { perceptions: [] }');
    }
    return (body as { perceptions: Perception[] }).perceptions;
  }
}

export interface JevHealth {
  ok: boolean;
  hasKey: boolean;
  model: string;
}

/** Reports whether the server has a TypeSafe key configured (never the key itself). */
export async function jevHealth(url = '/api/jev/health'): Promise<JevHealth> {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`jev health failed: HTTP ${res.status}`);
  return (await res.json()) as JevHealth;
}
