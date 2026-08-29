/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  RADAR_IMAGES: R2Bucket;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type TargetTime = { basetime: string; validtime: string; elements: string[] };

const JMA_TIMES = "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json";
const JMA_ROOT = "https://www.jma.go.jp/bosai/jmatile/data/nowc";
const ALLOWED_ORIGINS = new Set(["https://itachi-kun-itc.github.io", "http://localhost:3000"]);
const ZOOM = 8;
const DISCOVERY_ZOOM = 6;
const COLLECTION_BATCH_SIZE = 48;
const RETENTION_HOURS = 36;
const DISCOVERY_TILES = Array.from({ length: 42 }, (_, index) => ({ x: 53 + index % 7, y: 22 + Math.floor(index / 7) }));
const TILE_SETS = [
  { zoom: 5, tiles: Array.from({ length: 12 }, (_, index) => ({ x: 26 + index % 4, y: 11 + Math.floor(index / 4) })) },
  { zoom: DISCOVERY_ZOOM, tiles: DISCOVERY_TILES },
  { zoom: 7, tiles: Array.from({ length: 132 }, (_, index) => ({ x: 107 + index % 12, y: 45 + Math.floor(index / 12) })) },
];

type Tile = { x: number; y: number };

function highResolutionChildren(parent: Tile) {
  const scale = 2 ** (ZOOM - DISCOVERY_ZOOM);
  return Array.from({ length: scale * scale }, (_, index) => ({
    x: parent.x * scale + index % scale,
    y: parent.y * scale + Math.floor(index / scale),
  }));
}

function cors(request: Request) {
  const origin = request.headers.get("origin") || "";
  return {
    "access-control-allow-origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://itachi-kun-itc.github.io",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(request: Request, body: unknown, init: ResponseInit = {}) {
  return Response.json(body, { ...init, headers: { ...cors(request), ...(init.headers || {}) } });
}

function jmaTileUrl(baseTime: string, validTime: string, z: number, x: number, y: number) {
  return `${JMA_ROOT}/${baseTime}/none/${validTime}/surf/hrpns/${z}/${x}/${y}.png`;
}

async function ensureSchema(env: Env) {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS radar_frames (valid_time TEXT PRIMARY KEY, base_time TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'collecting', tile_count INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0, event_id TEXT, created_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS radar_frames_valid_time_idx ON radar_frames(valid_time DESC)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS radar_frames_event_id_idx ON radar_frames(event_id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS radar_events (id TEXT PRIMARY KEY, title TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, created_at TEXT NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS radar_events_created_at_idx ON radar_events(created_at DESC)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS radar_collection_progress (valid_time TEXT PRIMARY KEY, next_tile INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0, locked_at TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS radar_frame_manifests (valid_time TEXT PRIMARY KEY, zoom INTEGER NOT NULL, tiles_json TEXT NOT NULL)"),
  ]);
}

async function cleanup(env: Env) {
  const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const expired = await env.DB.prepare("SELECT valid_time FROM radar_frames WHERE valid_time < ? AND event_id IS NULL LIMIT 10").bind(cutoff).all<{ valid_time: string }>();
  if (!expired.results.length) return;
  const keys: string[] = [];
  for (const { valid_time } of expired.results) {
    keys.push(...TILE_SETS.flatMap(({ zoom, tiles }) => tiles.map(({ x, y }) => `frames/${valid_time}/${zoom}/${x}/${y}.png`)));
    const manifest = await env.DB.prepare("SELECT zoom, tiles_json FROM radar_frame_manifests WHERE valid_time = ?").bind(valid_time).first<{ zoom: number; tiles_json: string }>();
    if (manifest) keys.push(...(JSON.parse(manifest.tiles_json) as Tile[]).map(({ x, y }) => `frames/${valid_time}/${manifest.zoom}/${x}/${y}.png`));
  }
  for (let i = 0; i < keys.length; i += 1000) await env.RADAR_IMAGES.delete(keys.slice(i, i + 1000));
  await env.DB.batch(expired.results.flatMap(({ valid_time }) => [
    env.DB.prepare("DELETE FROM radar_collection_progress WHERE valid_time = ?").bind(valid_time),
    env.DB.prepare("DELETE FROM radar_frame_manifests WHERE valid_time = ?").bind(valid_time),
    env.DB.prepare("DELETE FROM radar_frames WHERE valid_time = ? AND event_id IS NULL").bind(valid_time),
  ]));
}

async function collectLatest(env: Env) {
  await ensureSchema(env);
  type Progress = { valid_time: string; base_time: string; next_tile: number; total_bytes: number; locked_at: string | null };
  let progress = await env.DB.prepare("SELECT p.valid_time, f.base_time, p.next_tile, p.total_bytes, p.locked_at FROM radar_collection_progress p JOIN radar_frames f ON f.valid_time = p.valid_time ORDER BY p.valid_time LIMIT 1").first<Progress>();

  if (!progress) {
    const targetsResponse = await fetch(JMA_TIMES, { headers: { "user-agent": "Recocast/1.0 (+https://itachi-kun-itc.github.io/Recocast/)" } });
    if (!targetsResponse.ok) throw new Error(`JMA target times: ${targetsResponse.status}`);
    const targets = await targetsResponse.json() as TargetTime[];
    const target = targets.find((item) => item.elements.includes("hrpns") && item.basetime === item.validtime);
    if (!target) throw new Error("No observed radar frame available");
    const exists = await env.DB.prepare("SELECT f.valid_time FROM radar_frames f JOIN radar_frame_manifests m ON m.valid_time = f.valid_time WHERE f.valid_time = ? AND f.status = 'ready' AND m.zoom = ?").bind(target.validtime, ZOOM).first();
    const overviewExists = exists && await env.RADAR_IMAGES.head(`frames/${target.validtime}/${DISCOVERY_ZOOM}/${DISCOVERY_TILES[0].x}/${DISCOVERY_TILES[0].y}.png`);
    if (overviewExists) {
      await cleanup(env);
      return;
    }
    const createdAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO radar_frames (valid_time, base_time, status, tile_count, total_bytes, created_at) VALUES (?, ?, 'collecting', 0, 0, ?) ON CONFLICT(valid_time) DO UPDATE SET base_time = excluded.base_time, status = 'collecting', tile_count = 0, total_bytes = 0, created_at = excluded.created_at")
        .bind(target.validtime, target.basetime, createdAt),
      env.DB.prepare("INSERT OR IGNORE INTO radar_collection_progress (valid_time, next_tile, total_bytes, locked_at) VALUES (?, -1, 0, NULL)").bind(target.validtime),
    ]);
    progress = { valid_time: target.validtime, base_time: target.basetime, next_tile: -1, total_bytes: 0, locked_at: null };
  }

  const lockId = new Date().toISOString();
  const staleLock = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const lock = await env.DB.prepare("UPDATE radar_collection_progress SET locked_at = ? WHERE valid_time = ? AND (locked_at IS NULL OR locked_at < ?)")
    .bind(lockId, progress.valid_time, staleLock).run();
  if (!lock.meta.changes) return;

  if (progress.next_tile < 0) {
    const discovery = await Promise.all(DISCOVERY_TILES.map(async ({ x, y }) => {
      const response = await fetch(jmaTileUrl(progress.base_time, progress.valid_time, DISCOVERY_ZOOM, x, y), { headers: { "user-agent": "Recocast/1.0 (+https://itachi-kun-itc.github.io/Recocast/)" } });
      if (!response.ok) throw new Error(`JMA discovery tile: ${response.status}`);
      const bytes = await response.arrayBuffer();
      await env.RADAR_IMAGES.put(`frames/${progress.valid_time}/${DISCOVERY_ZOOM}/${x}/${y}.png`, bytes, {
        httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { source: "Japan Meteorological Agency", baseTime: progress.base_time, validTime: progress.valid_time },
      });
      return { tile: { x, y }, bytes: bytes.byteLength };
    }));
    const discoveryBytes = discovery.reduce((sum, item) => sum + item.bytes, 0);
    const rainyParents = discovery.filter((item) => item.bytes > 400).map((item) => item.tile);
    const tiles = rainyParents.flatMap(highResolutionChildren);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO radar_frame_manifests (valid_time, zoom, tiles_json) VALUES (?, ?, ?) ON CONFLICT(valid_time) DO UPDATE SET zoom = excluded.zoom, tiles_json = excluded.tiles_json").bind(progress.valid_time, ZOOM, JSON.stringify(tiles)),
      ...(tiles.length
        ? [env.DB.prepare("UPDATE radar_collection_progress SET next_tile = 0, total_bytes = ?, locked_at = NULL WHERE valid_time = ? AND locked_at = ?").bind(discoveryBytes, progress.valid_time, lockId)]
        : [
            env.DB.prepare("UPDATE radar_frames SET status = 'ready', tile_count = ?, total_bytes = ? WHERE valid_time = ?").bind(DISCOVERY_TILES.length, discoveryBytes, progress.valid_time),
            env.DB.prepare("DELETE FROM radar_collection_progress WHERE valid_time = ? AND locked_at = ?").bind(progress.valid_time, lockId),
          ]),
    ]);
    if (!tiles.length) await cleanup(env);
    return;
  }

  const manifest = await env.DB.prepare("SELECT tiles_json FROM radar_frame_manifests WHERE valid_time = ? AND zoom = ?").bind(progress.valid_time, ZOOM).first<{ tiles_json: string }>();
  if (!manifest) throw new Error("Radar tile manifest is missing");
  const tiles = JSON.parse(manifest.tiles_json) as Tile[];
  const batch = tiles.slice(progress.next_tile, progress.next_tile + COLLECTION_BATCH_SIZE);
  let batchBytes = 0;
  const results = await Promise.all(batch.map(async ({ x, y }) => {
    const response = await fetch(jmaTileUrl(progress.base_time, progress.valid_time, ZOOM, x, y), { headers: { "user-agent": "Recocast/1.0 (+https://itachi-kun-itc.github.io/Recocast/)" } });
    if (!response.ok) return false;
    const bytes = await response.arrayBuffer();
    batchBytes += bytes.byteLength;
    await env.RADAR_IMAGES.put(`frames/${progress.valid_time}/${ZOOM}/${x}/${y}.png`, bytes, {
      httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { source: "Japan Meteorological Agency", baseTime: progress.base_time, validTime: progress.valid_time },
    });
    return true;
  }));

  if (results.some((result) => !result)) {
    await env.DB.prepare("UPDATE radar_collection_progress SET locked_at = NULL WHERE valid_time = ? AND locked_at = ?").bind(progress.valid_time, lockId).run();
    throw new Error("One or more JMA tiles failed");
  }

  const nextTile = progress.next_tile + batch.length;
  const totalBytes = progress.total_bytes + batchBytes;
  if (nextTile >= tiles.length) {
    await env.DB.batch([
      env.DB.prepare("UPDATE radar_frames SET status = 'ready', tile_count = ?, total_bytes = ? WHERE valid_time = ?").bind(DISCOVERY_TILES.length + tiles.length, totalBytes, progress.valid_time),
      env.DB.prepare("DELETE FROM radar_collection_progress WHERE valid_time = ? AND locked_at = ?").bind(progress.valid_time, lockId),
    ]);
    await cleanup(env);
  } else {
    await env.DB.prepare("UPDATE radar_collection_progress SET next_tile = ?, total_bytes = ?, locked_at = NULL WHERE valid_time = ? AND locked_at = ?")
      .bind(nextTile, totalBytes, progress.valid_time, lockId).run();
  }
}

async function route(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  await ensureSchema(env);

  if (url.pathname === "/api/frames" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT f.valid_time, f.base_time, f.tile_count, f.total_bytes, f.event_id, m.tiles_json FROM radar_frames f JOIN radar_frame_manifests m ON m.valid_time = f.valid_time WHERE f.status = 'ready' AND m.zoom = ? ORDER BY f.valid_time DESC LIMIT 900").bind(ZOOM).all<{ valid_time: string; base_time: string; tile_count: number; total_bytes: number; event_id: string | null; tiles_json: string }>();
    ctx.waitUntil(collectLatest(env));
    return json(request, { frames: rows.results.map(({ tiles_json, ...frame }) => ({ ...frame, tiles: JSON.parse(tiles_json) })), zoom: ZOOM, overviewZoom: DISCOVERY_ZOOM, overviewTiles: DISCOVERY_TILES, retentionDays: 1.5 });
  }

  if (url.pathname === "/api/events" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id, title, start_time, end_time, created_at FROM radar_events ORDER BY created_at DESC").all();
    return json(request, { events: rows.results });
  }

  if (url.pathname === "/api/events" && request.method === "POST") {
    const origin = request.headers.get("origin") || "";
    if (!ALLOWED_ORIGINS.has(origin)) return json(request, { error: "Origin not allowed" }, { status: 403 });
    const body = await request.json() as { title?: string; startTime?: string; endTime?: string };
    if (!body.title || !body.startTime || !body.endTime || body.startTime > body.endTime) return json(request, { error: "Invalid event" }, { status: 400 });
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM radar_events").first<{ count: number }>();
    if ((count?.count || 0) >= 100) return json(request, { error: "Archive limit reached" }, { status: 409 });
    const projected = await env.DB.prepare("SELECT COALESCE(SUM(total_bytes), 0) AS bytes FROM radar_frames WHERE event_id IS NOT NULL OR valid_time BETWEEN ? AND ?")
      .bind(body.startTime, body.endTime).first<{ bytes: number }>();
    if ((projected?.bytes || 0) > 7 * 1024 * 1024 * 1024) return json(request, { error: "Long-term archive storage guard reached" }, { status: 413 });
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO radar_events (id, title, start_time, end_time, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, body.title.slice(0, 80), body.startTime, body.endTime, createdAt),
      env.DB.prepare("UPDATE radar_frames SET event_id = ? WHERE valid_time BETWEEN ? AND ?").bind(id, body.startTime, body.endTime),
    ]);
    return json(request, { id, title: body.title, startTime: body.startTime, endTime: body.endTime, createdAt }, { status: 201 });
  }

  if (url.pathname === "/api/stats" && request.method === "GET") {
    const stats = await env.DB.prepare("SELECT COUNT(*) AS frame_count, COALESCE(SUM(f.total_bytes), 0) AS total_bytes, MIN(f.valid_time) AS oldest_time, MAX(f.valid_time) AS latest_time FROM radar_frames f JOIN radar_frame_manifests m ON m.valid_time = f.valid_time WHERE f.status = 'ready' AND m.zoom = ?").bind(ZOOM).first();
    const events = await env.DB.prepare("SELECT COUNT(*) AS event_count FROM radar_events").first();
    return json(request, { ...stats, ...events, retentionDays: 1.5 });
  }

  const tileMatch = url.pathname.match(/^\/api\/frames\/(\d{14})\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (tileMatch && request.method === "GET") {
    const [, validTime, z, x, y] = tileMatch;
    const object = await env.RADAR_IMAGES.get(`frames/${validTime}/${z}/${x}/${y}.png`);
    if (!object) return new Response("Not found", { status: 404, headers: cors(request) });
    const headers = new Headers(cors(request));
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    return new Response(object.body, { headers });
  }

  if (url.pathname === "/health") return json(request, { ok: true, source: "気象庁・高解像度降水ナウキャスト", retentionDays: 1.5, zoom: ZOOM });
  return json(request, { error: "Not found" }, { status: 404 });
}

export default {
  fetch: route,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(collectLatest(env));
  },
};

