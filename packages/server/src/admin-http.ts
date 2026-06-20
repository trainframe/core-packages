import {
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TrainState } from '@trainframe/core';
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
    const rawUrl = req.url ?? '/';
    const method = req.method ?? 'GET';
    /*
     * Split the path from the query string before matching. Routes match on the
     * pathname only; query parameters (e.g. `?train_id=` on traversal-times)
     * are parsed separately by the handler that wants them. `WHATWG URL`
     * tolerates a dummy origin since we only consume `pathname`/`searchParams`.
     */
    const parsed = new URL(rawUrl, 'http://localhost');
    const pathname = parsed.pathname;
    const query = parsed.searchParams;

    try {
      const route = this.matchRoute(method, pathname, query);
      if (!route) {
        json(res, 404, { error: `No route for ${method} ${pathname}`, code: 'not_found' });
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
    query: URLSearchParams,
  ): { needsBody: boolean; handler: (body: unknown, res: ServerResponse) => void } | undefined {
    if (method === 'GET' && url === '/api/health') {
      return { needsBody: false, handler: (_b, res) => this.health(res) };
    }
    /*
     * Deprecated omnibus read endpoint (ADR-008). Retained as a convenience
     * alias while callers migrate to the granular `GET /api/query/*` family
     * (ADR-020); slated for removal once the visualiser/sim-ui first paint move
     * over.
     */
    if (method === 'GET' && url === '/api/state') {
      return { needsBody: false, handler: (_b, res) => this.state(res) };
    }
    if (method === 'GET') return this.matchQueryRoute(url, query);
    if (method === 'DELETE') {
      const del = url.match(/^\/api\/trains\/([^/]+)$/);
      if (del?.[1]) {
        const id = decodeURIComponent(del[1]);
        return { needsBody: false, handler: (_b, res) => this.deleteTrain(id, res) };
      }
      return undefined;
    }
    if (method === 'POST') return this.matchPostRoute(url);
    return undefined;
  }

  /* POST-only routes extracted to keep matchRoute under the complexity limit. */
  private matchPostRoute(
    url: string,
  ): { needsBody: boolean; handler: (body: unknown, res: ServerResponse) => void } | undefined {
    const route = url.match(/^\/api\/trains\/([^/]+)\/route$/);
    if (route?.[1]) {
      const id = decodeURIComponent(route[1]);
      return { needsBody: true, handler: (body, res) => this.assignSchedule(id, body, res) };
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
    if (url === '/api/maintenance/prune-markers') {
      return { needsBody: false, handler: (_b, res) => this.pruneMarkers(res) };
    }
    if (url === '/api/maintenance/reset') {
      return { needsBody: false, handler: (_b, res) => this.resetState(res) };
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
        schedule: t.schedule,
        transit: t.transit,
        cleared_edges: t.cleared_edges,
      })),
      tags: scheduler.getTagRegistry().entries(),
    });
  }

  /*
   * Read-only query API (ADR-020). Resource-oriented projections of
   * scheduler/layout state under `GET /api/query/*`. No side effects, no device
   * impersonation — every handler is a thin projection of facts the existing
   * public accessors on `Scheduler`/`LayoutState` already expose. No new logic
   * and no new state live here; query *shaping* is composition/IO and belongs
   * in the server, never in core or protocol.
   */
  private matchQueryRoute(
    url: string,
    query: URLSearchParams,
  ): { needsBody: boolean; handler: (body: unknown, res: ServerResponse) => void } | undefined {
    if (url === '/api/query/layout') {
      return { needsBody: false, handler: (_b, res) => this.queryLayout(res) };
    }
    if (url === '/api/query/traversal-times') {
      return { needsBody: false, handler: (_b, res) => this.queryTraversalTimes(query, res) };
    }
    if (url === '/api/query/trains') {
      return { needsBody: false, handler: (_b, res) => this.queryTrains(res) };
    }
    const train = url.match(/^\/api\/query\/trains\/([^/]+)$/);
    if (train?.[1]) {
      const id = decodeURIComponent(train[1]);
      return { needsBody: false, handler: (_b, res) => this.queryTrain(id, res) };
    }
    if (url === '/api/query/clearances') {
      return { needsBody: false, handler: (_b, res) => this.queryClearances(res) };
    }
    if (url === '/api/query/tags') {
      return { needsBody: false, handler: (_b, res) => this.queryTags(res) };
    }
    return undefined;
  }

  /**
   * The logical layout graph: markers (id, kind, and live switch position for
   * junctions) and edges (with the declared-vs-learned `inferred` flag). The
   * scheduler's view, not the spatial layout (ADR-013 coordinates are excluded
   * per the spatial/logical separation commitment).
   */
  private queryLayout(res: ServerResponse): void {
    const layout = this.server.getScheduler().getLayout();
    const graph = layout.toLayout();
    const markers = graph.markers.map((m) => {
      const switchPosition = m.kind === 'junction' ? layout.getSwitchPosition(m.id) : undefined;
      return {
        id: m.id,
        kind: m.kind,
        ...(switchPosition !== undefined ? { switch_position: switchPosition } : {}),
      };
    });
    const edges = graph.edges.map((e) => ({
      from_marker_id: e.from_marker_id,
      to_marker_id: e.to_marker_id,
      ...(e.requires_switch_state !== undefined
        ? { requires_switch_state: e.requires_switch_state }
        : {}),
      inferred: e.inferred === true,
    }));
    json(res, 200, { name: graph.name, markers, edges });
  }

  /**
   * Learned per-edge traversal estimates and sample counts. `learned_ms` is
   * present only once the edge has enough samples for an estimate; `samples`
   * (the traversal count) is always present so freshly-seen edges still appear.
   * `?train_id=` selects the per-train estimate (ADR-010), falling back to the
   * global one.
   */
  private queryTraversalTimes(query: URLSearchParams, res: ServerResponse): void {
    const layout = this.server.getScheduler().getLayout();
    const trainId = query.get('train_id') ?? undefined;
    const edges = layout.toLayout().edges.map((e) => {
      const learnedMs =
        trainId !== undefined
          ? layout.getLearnedTraversalMs(e.from_marker_id, e.to_marker_id, trainId)
          : layout.getLearnedTraversalMs(e.from_marker_id, e.to_marker_id);
      return {
        from_marker_id: e.from_marker_id,
        to_marker_id: e.to_marker_id,
        samples: layout.traversalCount(e.from_marker_id, e.to_marker_id),
        ...(learnedMs !== undefined ? { learned_ms: learnedMs } : {}),
      };
    });
    json(res, 200, { ...(trainId !== undefined ? { train_id: trainId } : {}), edges });
  }

  /** All train states. */
  private queryTrains(res: ServerResponse): void {
    const scheduler = this.server.getScheduler();
    const trains = scheduler
      .getTrainIds()
      .map((id) => scheduler.getTrainState(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
      .map(projectTrainState);
    json(res, 200, { trains });
  }

  /** One train's state, 404 if unknown. */
  private queryTrain(trainId: string, res: ServerResponse): void {
    const state = this.server.getScheduler().getTrainState(trainId);
    if (!state) {
      json(res, 404, { error: `Unknown train: ${trainId}`, code: 'not_found' });
      return;
    }
    json(res, 200, projectTrainState(state));
  }

  /**
   * The current clearance picture derived from train states: which edges each
   * train holds and each train's clearance limit. The read counterpart to the
   * grant/revoke commands.
   */
  private queryClearances(res: ServerResponse): void {
    const scheduler = this.server.getScheduler();
    const clearances = scheduler
      .getTrainIds()
      .map((id) => scheduler.getTrainState(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
      .map((t) => ({
        train_id: t.train_id,
        cleared_edges: t.cleared_edges,
        ...(t.clearance_limit_marker_id !== undefined
          ? { clearance_limit_marker_id: t.clearance_limit_marker_id }
          : {}),
      }));
    json(res, 200, { clearances });
  }

  /** Current tag bindings. */
  private queryTags(res: ServerResponse): void {
    const entries = this.server.getScheduler().getTagRegistry().entries();
    json(res, 200, {
      tags: entries.map(([tag_id, binding]) => ({
        tag_id,
        kind: binding.kind,
        target_id: binding.target_id,
      })),
    });
  }

  private deleteTrain(trainId: string, res: ServerResponse): void {
    if (!this.server.deleteTrain(trainId)) {
      json(res, 404, { error: `Unknown train: ${trainId}`, code: 'not_found' });
      return;
    }
    json(res, 200, { deleted: trainId });
  }

  private pruneMarkers(res: ServerResponse): void {
    json(res, 200, { pruned: this.server.pruneOrphanMarkers() });
  }

  private resetState(res: ServerResponse): void {
    json(res, 200, this.server.reset());
  }

  private assignSchedule(trainId: string, body: unknown, res: ServerResponse): void {
    const { route_id, stops } = requireFields(body, ['route_id', 'stops']);
    if (typeof route_id !== 'string') throw new Error('route_id must be a string');
    if (!Array.isArray(stops) || stops.length === 0)
      throw new Error('stops must be a non-empty array');
    for (const s of stops) {
      if (typeof s !== 'string') throw new Error('each stop must be a marker_id string');
    }
    this.server.assignSchedule(trainId, route_id, stops as ReadonlyArray<string>);
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

/**
 * Project a scheduler `TrainState` to the JSON shape the query API serves.
 * Optional fields are omitted (not emitted as `null`) when absent — the shape
 * mirrors the deprecated `/api/state` train projection plus `last_marker_id`.
 */
function projectTrainState(t: TrainState): Record<string, unknown> {
  return {
    train_id: t.train_id,
    ...(t.last_marker_id !== undefined ? { last_marker_id: t.last_marker_id } : {}),
    ...(t.clearance_limit_marker_id !== undefined
      ? { clearance_limit_marker_id: t.clearance_limit_marker_id }
      : {}),
    cleared_edges: t.cleared_edges,
    ...(t.transit !== undefined ? { transit: t.transit } : {}),
    ...(t.schedule !== undefined ? { schedule: t.schedule } : {}),
  };
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
