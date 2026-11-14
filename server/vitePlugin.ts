/**
 * Vite dev/preview middleware for Jev perception.
 *   POST /api/jev         body { inputs: PerceptionInput[] } → { perceptions } | 503 { error: 'no_api_key' }
 *   GET  /api/jev/health  → { ok, hasKey, model }
 * The TypeSafe key is read with loadEnv in configResolved and never sent to the client or logged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import type { AgentMode, NegotiatorKind, PerceptionInput } from '../src/core/types';
import { DirectJevProvider } from './jevDirect';

const MAX_INPUTS = 64;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_LOG_LINES = 50;
const DEFAULT_MODEL = 'jev-latest';
const KINDS: readonly NegotiatorKind[] = ['hospital', 'water', 'emergency', 'telecom', 'school'];
const MODES: readonly AgentMode[] = ['idle', 'active', 'cooperating'];
const BACKUP_TYPES: readonly PerceptionInput['backup']['type'][] = ['battery', 'diesel', 'none'];

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface JevState {
  provider: DirectJevProvider | null;
  model: string;
}

type Dict = Record<string, unknown>;
const isDict = (x: unknown): x is Dict => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const isOneOf = <T extends string>(x: unknown, list: readonly T[]): x is T =>
  typeof x === 'string' && (list as readonly string[]).includes(x);

/** Rebuilds a PerceptionInput from untrusted JSON, keeping only the fields Jev needs. */
function sanitizeInput(raw: unknown): PerceptionInput | null {
  if (!isDict(raw)) return null;
  const { agentId, kind, mode, backup, island } = raw;
  if (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 120) return null;
  if (!isOneOf(kind, KINDS) || !isOneOf(mode, MODES)) return null;
  if (!isDict(backup) || !isOneOf(backup.type, BACKUP_TYPES) || !isDict(island)) return null;

  const tMin = num(raw.tMin);
  const hourOfDay = num(raw.hourOfDay);
  const demandKW = num(raw.demandKW);
  const minSafeKW = num(raw.minSafeKW);
  const allocatedKW = num(raw.allocatedKW);
  const criticality = num(raw.criticality);
  const simUrgency = num(raw.simUrgency);
  const expectedDamagePerHour = num(raw.expectedDamagePerHour);
  const remainingKWh = num(backup.remainingKWh);
  const maxKW = num(backup.maxKW);
  const hoursLeft = num(backup.hoursLeft);
  const supplyKW = num(island.supplyKW);
  const totalRequestKW = num(island.totalRequestKW);
  const deficitKW = num(island.deficitKW);
  const consumers = num(island.consumers);
  if (
    tMin === undefined || hourOfDay === undefined || demandKW === undefined || minSafeKW === undefined ||
    allocatedKW === undefined || criticality === undefined || simUrgency === undefined ||
    expectedDamagePerHour === undefined || remainingKWh === undefined || maxKW === undefined ||
    hoursLeft === undefined || supplyKW === undefined || totalRequestKW === undefined ||
    deficitKW === undefined || consumers === undefined
  ) {
    return null;
  }

  const telemetry: Record<string, number> = {};
  if (isDict(raw.telemetry)) {
    for (const [k, v] of Object.entries(raw.telemetry)) {
      const n = num(v);
      if (n !== undefined && k.length <= 64) telemetry[k] = n;
    }
  }
  const incidentLog = Array.isArray(raw.incidentLog)
    ? raw.incidentLog
        .filter((l): l is string => typeof l === 'string')
        .slice(0, MAX_LOG_LINES)
        .map((l) => l.slice(0, 200))
    : [];

  return {
    agentId,
    kind,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : agentId,
    mode,
    tMin,
    hourOfDay,
    demandKW,
    minSafeKW,
    allocatedKW,
    criticality,
    simUrgency,
    expectedDamagePerHour,
    backup: { type: backup.type, remainingKWh, maxKW, hoursLeft },
    telemetry,
    incidentLog,
    island: { supplyKW, totalRequestKW, deficitKW, consumers },
  };
}

function parseInputs(body: unknown): PerceptionInput[] {
  if (!isDict(body) || !Array.isArray(body.inputs)) throw new HttpError(400, 'expected { inputs: [] }');
  if (body.inputs.length > MAX_INPUTS) throw new HttpError(400, `at most ${MAX_INPUTS} inputs per request`);
  return body.inputs.map((raw) => {
    const clean = sanitizeInput(raw);
    if (!clean) throw new HttpError(400, 'invalid perception input');
    return clean;
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function jevMiddleware(state: JevState) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/api/jev' && path !== '/api/jev/health') return next();

    try {
      if (path === '/api/jev/health') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
        send(res, 200, { ok: true, hasKey: state.provider !== null, model: state.model });
        return;
      }

      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
      const inputs = parseInputs(await readJson(req));
      if (!state.provider) {
        send(res, 503, { error: 'no_api_key' });
        return;
      }
      if (inputs.length === 0) {
        send(res, 200, { perceptions: [] });
        return;
      }
      const perceptions = await state.provider.perceive(inputs);
      send(res, 200, { perceptions });
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message });
        return;
      }
      // Do not echo provider details to the page; they may contain request data.
      send(res, 500, { error: 'jev_failed' });
    }
  };
}

export function jevPlugin(): Plugin {
  const state: JevState = { provider: null, model: DEFAULT_MODEL };
  return {
    name: 'trojan-jev',
    configResolved(config) {
      const env = loadEnv(config.mode, process.cwd(), '');
      const apiKey = env.TYPESAFE_API_KEY?.trim();
      const model = env.TYPESAFE_DEFAULT_MODEL?.trim() || undefined;
      state.model = model ?? DEFAULT_MODEL;
      state.provider = apiKey ? new DirectJevProvider({ apiKey, model }) : null;
    },
    configureServer(server) {
      server.middlewares.use(jevMiddleware(state));
    },
    configurePreviewServer(server) {
      server.middlewares.use(jevMiddleware(state));
    },
  };
}
