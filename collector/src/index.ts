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
const ZOOM = 5;
const TILES = Array.from({ length: 4 * 3 }, (_, index) => ({ x: 26 + (index % 4), y: 11 + Math.floor(index / 4) }));

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
  ]);
}

async function cleanup(env: Env) {
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const expired = await env.DB.prepare("SELECT valid_time FROM radar_frames WHERE valid_time < ? AND event_id IS NULL LIMIT 120").bind(cutoff).all<{ valid_time: string }>();
  if (!expired.results.length) return;
  const keys = expired.results.flatMap(({ valid_time }) => TILES.map(({ x, y }) => `frames/${valid_time}/${ZOOM}/${x}/${y}.png`));
  for (let i = 0; i < keys.length; i += 1000) await env.RADAR_IMAGES.delete(keys.slice(i, i + 1000));
  await env.DB.batch(expired.results.map(({ valid_time }) => env.DB.prepare("DELETE FROM radar_frames WHERE valid_time = ? AND event_id IS NULL").bind(valid_time)));
}

async function collectLatest(env: Env) {
  await ensureSchema(env);
  const targetsResponse = await fetch(JMA_TIMES, { headers: { "user-agent": "Recocast/1.0 (+https://itachi-kun-itc.github.io/Recocast/)" } });
  if (!targetsResponse.ok) throw new Error(`JMA target times: ${targetsResponse.status}`);
  const targets = await targetsResponse.json() as TargetTime[];
  const target = targets.find((item) => item.elements.includes("hrpns") && item.basetime === item.validtime);
  if (!target) throw new Error("No observed radar frame available");
  const exists = await env.DB.prepare("SELECT valid_time FROM radar_frames WHERE valid_time = ? AND status = 'ready'").bind(target.validtime).first();
  if (exists) { await cleanup(env); return; }

  await env.DB.prepare("INSERT OR REPLACE INTO radar_frames (valid_time, base_time, status, tile_count, total_bytes, created_at) VALUES (?, ?, 'collecting', 0, 0, ?)")
    .bind(target.validtime, target.basetime, new Date().toISOString()).run();

  let totalBytes = 0;
  const results = await Promise.all(TILES.map(async ({ x, y }) => {
    const response = await fetch(jmaTileUrl(target.basetime, target.validtime, ZOOM, x, y), { headers: { "user-agent": "Recocast/1.0 (+https://itachi-kun-itc.github.io/Recocast/)" } });
    if (!response.ok) return false;
    const bytes = await response.arrayBuffer();
    totalBytes += bytes.byteLength;
    await env.RADAR_IMAGES.put(`frames/${target.validtime}/${ZOOM}/${x}/${y}.png`, bytes, {
      httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { source: "Japan Meteorological Agency", baseTime: target.basetime, validTime: target.validtime },
    });
    return true;
  }));
  const tileCount = results.filter(Boolean).length;
  await env.DB.prepare("UPDATE radar_frames SET status = 'ready', tile_count = ?, total_bytes = ? WHERE valid_time = ?")
    .bind(tileCount, totalBytes, target.validtime).run();
  await cleanup(env);
}

async function route(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  await ensureSchema(env);

  if (url.pathname === "/api/frames" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT valid_time, base_time, tile_count, total_bytes, event_id FROM radar_frames WHERE status = 'ready' ORDER BY valid_time DESC LIMIT 900").all();
    if (!rows.results.length) ctx.waitUntil(collectLatest(env));
    return json(request, { frames: rows.results, zoom: ZOOM, tiles: TILES, retentionDays: 3 });
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
    const stats = await env.DB.prepare("SELECT COUNT(*) AS frame_count, COALESCE(SUM(total_bytes), 0) AS total_bytes, MIN(valid_time) AS oldest_time, MAX(valid_time) AS latest_time FROM radar_frames WHERE status = 'ready'").first();
    const events = await env.DB.prepare("SELECT COUNT(*) AS event_count FROM radar_events").first();
    return json(request, { ...stats, ...events, retentionDays: 3 });
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

  if (url.pathname === "/health") return json(request, { ok: true, source: "気象庁 高解像度降水ナウキャスト", retentionDays: 3 });
  return json(request, { error: "Not found" }, { status: 404 });
}

export default {
  fetch: route,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(collectLatest(env));
  },
};

