import {
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server as TrainframeServer } from './server.js';

/**
 * HTTP admin API. Thin operator-facing surface over the running server:
 * each endpoint maps to a scheduler entry point or a command publish.
 * See ADR-008.
 *
 * Application protocol stays on MQTT exactly as before — the visualiser,
 * simulator-ui, and any future remote UI subscribe to events and retained
 * state through the broker. HTTP is only for the operator-initiated
 * request/response actions that don't fit pub/sub.
 *
 * No auth in v0.1; intended for `127.0.0.1` and LAN. Bind to a private
 * interface for anything else.
 */
export interface AdminHttpServerOptions {
  readonly server: TrainframeServer;
  /**
   * Identity for the synthetic operator device used when the HTTP API
   * mints `tag_assignment` events. Auto-registered with `core.assigns_tags`
   * on `listen()`. Defaults to `ADMIN-API`.
   */
  readonly adminDeviceId?: string;
}

export class AdminHttpServer {
  private readonly server: TrainframeServer;
  private readonly adminDeviceId: string;
  private httpServer: HttpServer | null = null;

  constructor(options: AdminHttpServerOptions) {
    this.server = options.server;
    this.adminDeviceId = options.adminDeviceId ?? 'ADMIN-API';
  }

  /**
   * Bind the HTTP listener. Pass `0` for the port to let the OS pick one
   * (useful in tests); the chosen port is returned. Registers the synthetic
   * admin device before accepting requests so tag-assignment endpoints
   * succeed on the first call.
   */
  async listen(port: number): Promise<number> {
    if (this.httpServer) throw new Error('AdminHttpServer.listen called twice');
    this.server.injectEvent('device_registered', this.adminDeviceId, {
      capabilities: ['core.assigns_tags'],
    });
    const httpServer = createServer((req, res) => this.handle(req, res));
    this.httpServer = httpServer;
    return new Promise<number>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', () => {
        httpServer.off('error', reject);
        const addr = httpServer.address() as AddressInfo;
        resolve(addr.port);
      });
    });
  }

  async close(): Promise<void> {
    const httpServer = this.httpServer;
    if (!httpServer) return;
    this.httpServer = null;
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    addCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    try {
      const route = this.matchRoute(method, url);
      if (!route) {
        json(res, 404, { error: `No route for ${method} ${url}`, code: 'not_found' });
        return;
      }
      const body = route.needsBody ? await readJson(req) : undefined;
      route.handler(body, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      json(res, 400, { error: message, code: 'validation' });
    }
  }

  private matchRoute(
    method: string,
    url: string,
  ): { needsBody: boolean; handler: (body: unknown, res: ServerResponse) => void } | undefined {
    if (method === 'GET' && url === '/api/health') {
      return { needsBody: false, handler: (_b, res) => this.health(res) };
    }
    if (method === 'GET' && url === '/api/state') {
      return { needsBody: false, handler: (_b, res) => this.state(res) };
    }
    if (method !== 'POST') return undefined;

    const route = url.match(/^\/api\/trains\/([^/]+)\/route$/);
    if (route?.[1]) {
      const id = decodeURIComponent(route[1]);
      return { needsBody: true, handler: (body, res) => this.assignRoute(id, body, res) };
    }
    const revoke = url.match(/^\/api\/trains\/([^/]+)\/revoke_clearance$/);
    if (revoke?.[1]) {
      const id = decodeURIComponent(revoke[1]);
      return { needsBody: true, handler: (body, res) => this.revokeClearance(id, body, res) };
    }
    const hold = url.match(/^\/api\/gates\/([^/]+)\/hold$/);
    if (hold?.[1]) {
      const id = decodeURIComponent(hold[1]);
      return { needsBody: true, handler: (body, res) => this.holdGate(id, body, res) };
    }
    const release = url.match(/^\/api\/gates\/([^/]+)\/release$/);
    if (release?.[1]) {
      const id = decodeURIComponent(release[1]);
      return { needsBody: true, handler: (body, res) => this.releaseGate(id, body, res) };
    }
    if (url === '/api/tags') {
      return { needsBody: true, handler: (body, res) => this.assignTag(body, res) };
    }
    return undefined;
  }

  private health(res: ServerResponse): void {
    json(res, 200, { status: 'ok' });
  }

  private state(res: ServerResponse): void {
    const scheduler = this.server.getScheduler();
    const trains = scheduler
      .getTrainIds()
      .map((id) => scheduler.getTrainState(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);
    json(res, 200, {
      trains: trains.map((t) => ({
        train_id: t.train_id,
        last_marker_id: t.last_marker_id,
        clearance_limit_marker_id: t.clearance_limit_marker_id,
        route: t.route,
        cleared_edges: t.cleared_edges,
      })),
      tags: scheduler.getTagRegistry().entries(),
    });
  }

  private assignRoute(trainId: string, body: unknown, res: ServerResponse): void {
    const { route_id, edges } = requireFields(body, ['route_id', 'edges']);
    if (typeof route_id !== 'string') throw new Error('route_id must be a string');
    if (!Array.isArray(edges) || edges.length === 0)
      throw new Error('edges must be a non-empty array');
    for (const e of edges) {
      if (
        typeof e !== 'object' ||
        e === null ||
        typeof (e as Record<string, unknown>).from_marker_id !== 'string' ||
        typeof (e as Record<string, unknown>).to_marker_id !== 'string'
      ) {
        throw new Error('edge must have from_marker_id and to_marker_id strings');
      }
    }
    this.server.assignRoute(
      trainId,
      route_id,
      edges as Array<{ from_marker_id: string; to_marker_id: string }>,
    );
    noContent(res);
  }

  private revokeClearance(trainId: string, _body: unknown, res: ServerResponse): void {
    // Goes through the scheduler so cleared edges are released and waiting
    // peers get reconsidered. The wire-level command is one of the resulting
    // effects, not a side-channel publish, so scheduler state and the train's
    // observable behavior stay aligned.
    this.server.revokeClearance(trainId);
    noContent(res);
  }

  private holdGate(deviceId: string, body: unknown, res: ServerResponse): void {
    const { marker_id } = requireFields(body, ['marker_id']);
    if (typeof marker_id !== 'string') throw new Error('marker_id must be a string');
    const reason = (body as Record<string, unknown>).reason;
    this.server.publishCommand(deviceId, 'hold_gate', {
      marker_id,
      ...(typeof reason === 'string' ? { reason } : {}),
    });
    noContent(res);
  }

  private releaseGate(deviceId: string, body: unknown, res: ServerResponse): void {
    const { marker_id } = requireFields(body, ['marker_id']);
    if (typeof marker_id !== 'string') throw new Error('marker_id must be a string');
    this.server.publishCommand(deviceId, 'release_gate', { marker_id });
    noContent(res);
  }

  private assignTag(body: unknown, res: ServerResponse): void {
    const { tag_id, assigned_kind, target_id } = requireFields(body, [
      'tag_id',
      'assigned_kind',
      'target_id',
    ]);
    if (typeof tag_id !== 'string') throw new Error('tag_id must be a string');
    if (assigned_kind !== 'marker' && assigned_kind !== 'vehicle') {
      throw new Error("assigned_kind must be 'marker' or 'vehicle'");
    }
    if (typeof target_id !== 'string') throw new Error('target_id must be a string');
    this.server.injectEvent('tag_assignment', this.adminDeviceId, {
      tag_id,
      assigned_kind,
      target_id,
    });
    noContent(res);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function noContent(res: ServerResponse): void {
  res.writeHead(204).end();
}

function addCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Body is not valid JSON');
  }
}

function requireFields(body: unknown, fields: ReadonlyArray<string>): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Body must be a JSON object');
  }
  const obj = body as Record<string, unknown>;
  for (const f of fields) {
    if (!(f in obj)) throw new Error(`Missing required field: ${f}`);
  }
  return obj;
}
