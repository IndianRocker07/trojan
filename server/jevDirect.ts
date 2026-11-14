/**
 * Node-only Jev perception provider: calls the TypeSafe SDK directly, one systemOne per agent, in parallel.
 * Used by the Vite middleware (server/vitePlugin.ts) and headless scripts. Never import this from browser code.
 */
import { choice, noul, score, TypeSafeClient, type Question, type Questions } from '@typesafe-ai/sdk';
import type { Perception, PerceptionInput, PerceptionProvider } from '../src/core/types';
import {
  buildJevState,
  errorPerception,
  questionsFor,
  toPerception,
  type QuestionSpec,
} from '../src/negotiation/jevPrompts';

export interface DirectJevOptions {
  /** Falls back to TYPESAFE_API_KEY. Without a key, perceive() rejects with 'no_api_key'. */
  apiKey?: string;
  /** Falls back to TYPESAFE_DEFAULT_MODEL, then the SDK default (jev-latest). */
  model?: string;
  /** Per-attempt timeout (docs §2: 4 s). */
  timeoutMs?: number;
}

function toSdkQuestions(specs: Record<string, QuestionSpec>): Questions {
  const out: Record<string, Question> = {};
  for (const [name, spec] of Object.entries(specs)) {
    switch (spec.type) {
      case 'score':
        out[name] = score(spec.instruction, spec.levels);
        break;
      case 'noul':
        out[name] = noul(spec.instruction);
        break;
      case 'choice':
        out[name] = choice(spec.instruction, spec.options);
        break;
    }
  }
  return out;
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.slice(0, 200);
}

export class DirectJevProvider implements PerceptionProvider {
  readonly name = 'jev';
  private readonly client: TypeSafeClient | null;
  private readonly model: string | undefined;

  constructor(opts: DirectJevOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.model = opts.model;
    // The SDK throws when no key is available, so only construct it when one exists.
    this.client = apiKey
      ? new TypeSafeClient({
          apiKey,
          timeout: opts.timeoutMs ?? 4000,
          retry: { maxRetries: 1 },
        })
      : null;
  }

  get hasKey(): boolean {
    return this.client !== null;
  }

  async perceive(inputs: PerceptionInput[], signal?: AbortSignal): Promise<Perception[]> {
    const client = this.client;
    if (!client) throw new Error('no_api_key');
    return Promise.all(inputs.map((input) => this.one(client, input, signal)));
  }

  private async one(client: TypeSafeClient, input: PerceptionInput, signal?: AbortSignal): Promise<Perception> {
    const t0 = performance.now();
    try {
      const res = await client.systemOne(
        {
          state: buildJevState(input),
          questions: toSdkQuestions(questionsFor(input.mode)),
          model: this.model,
        },
        signal ? { signal } : undefined,
      );
      const latencyMs = performance.now() - t0;
      return toPerception(input, res.answers, { latencyMs, model: res.model });
    } catch (err) {
      return errorPerception(input, describeError(err));
    }
  }
}
