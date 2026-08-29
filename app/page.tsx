"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const API = "https://recocast-radar-api.h6fgpg2zht.workers.dev";
type Frame = { valid_time: string; base_time: string; tile_count: number; total_bytes: number; event_id: string | null };
type Tile = { x: number; y: number };
type RadarEvent = { id: string; title: string; start_time: string; end_time: string; created_at: string };
type Stats = { frame_count: number; total_bytes: number; oldest_time: string | null; latest_time: string | null; event_count: number; retentionDays: number };
type GeoGeometry = { type: "Polygon" | "MultiPolygon"; coordinates: number[][][][] | number[][][] };
type GeoCollection = { features: Array<{ geometry: GeoGeometry }> };

function radarDate(value: string) {
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)), Number(value.slice(8, 10)), Number(value.slice(10, 12))));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }).format(radarDate(value));
}

function toInputValue(value: string) {
  const date = radarDate(value);
  return new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }).format(date).replace(" ", "T");
}

function inputToRadar(value: string) {
  const date = new Date(`${value}:00+09:00`);
  return date.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function tileUrl(frame: Frame, x: number, y: number, zoom: number) {
  return `${API}/api/frames/${frame.valid_time}/tiles/${zoom}/${x}/${y}.png`;
}

function JapanMap({ frame, opacity, tiles, zoom }: { frame?: Frame; opacity: number; tiles: Tile[]; zoom: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [geo, setGeo] = useState<GeoCollection | null>(null);
  useEffect(() => { fetch("https://raw.githubusercontent.com/geolonia/prefecture-tiles/master/prefectures.geojson").then(async (response) => await response.json() as GeoCollection).then(setGeo).catch(() => setGeo(null)); }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !geo) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height;
    const minLon = 122.4, maxLon = 153.9, minLat = 23, maxLat = 46.1;
    const mercatorY = (lat: number) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2;
    const minX = (minLon + 180) / 360, maxX = (maxLon + 180) / 360, minY = mercatorY(maxLat), maxY = mercatorY(minLat);
    const worldToCanvas = (x: number, y: number) => [((x - minX) / (maxX - minX)) * w, ((y - minY) / (maxY - minY)) * h] as const;
    const project = ([lon, lat]: number[]) => worldToCanvas((lon + 180) / 360, mercatorY(lat));

    const drawBase = () => {
      const ocean = ctx.createRadialGradient(w * .58, h * .42, 20, w * .55, h * .45, w * .82);
      ocean.addColorStop(0, "#173b43"); ocean.addColorStop(.48, "#0b2730"); ocean.addColorStop(1, "#06191f");
      ctx.fillStyle = ocean; ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = .24; ctx.strokeStyle = "#4d8790"; ctx.lineWidth = .45;
      for (let x = -h; x < w + h; x += 42) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + h, h); ctx.stroke(); }
      ctx.globalAlpha = 1;
      const land = new Path2D();
      geo.features.forEach(({ geometry }) => {
        const polys = geometry.type === "Polygon" ? [geometry.coordinates as number[][][]] : geometry.coordinates as number[][][][];
        polys.forEach((poly) => poly.forEach((ring) => { ring.forEach((point, index) => { const [x, y] = project(point); if (index === 0) land.moveTo(x, y); else land.lineTo(x, y); }); land.closePath(); }));
      });
      const terrain = ctx.createLinearGradient(w * .2, 0, w * .8, h);
      terrain.addColorStop(0, "#304b3e"); terrain.addColorStop(.45, "#69745a"); terrain.addColorStop(1, "#294438");
      ctx.fillStyle = terrain; ctx.fill(land, "evenodd");
      ctx.save(); ctx.clip(land, "evenodd");
      for (let i = 0; i < 120; i++) { const x = ((i * 83) % 1000) / 1000 * w, y = ((i * 137) % 997) / 997 * h; ctx.fillStyle = i % 3 ? "rgba(220,210,160,.055)" : "rgba(5,28,24,.13)"; ctx.beginPath(); ctx.ellipse(x, y, 18 + (i % 7) * 9, 4 + (i % 5) * 4, -.6, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = .72;
      geo.features.forEach(({ geometry }) => {
        const polys = geometry.type === "Polygon" ? [geometry.coordinates as number[][][]] : geometry.coordinates as number[][][][];
        polys.forEach((poly) => poly.forEach((ring) => { ctx.beginPath(); ring.forEach((point, index) => { const [x, y] = project(point); if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.closePath(); ctx.stroke(); }));
      });
    };

    drawBase();
    if (!frame) return;
    const scale = 2 ** zoom;
    Promise.all(tiles.map(({ x, y }) => new Promise<{ image: HTMLImageElement; x: number; y: number } | null>((resolve) => {
      const image = new Image(); image.crossOrigin = "anonymous"; image.onload = () => resolve({ image, x, y }); image.onerror = () => resolve(null); image.src = tileUrl(frame, x, y, zoom);
    }))).then((loaded) => {
      ctx.save(); ctx.globalAlpha = opacity;
      loaded.forEach((tile) => { if (!tile) return; const [left, top] = worldToCanvas(tile.x / scale, tile.y / scale); const [right, bottom] = worldToCanvas((tile.x + 1) / scale, (tile.y + 1) / scale); ctx.drawImage(tile.image, left, top, right - left, bottom - top); });
      ctx.restore();
    });
  }, [geo, frame, opacity, tiles, zoom]);

  return <canvas ref={canvasRef} className="map-canvas" aria-label="気象庁ナウキャストを重ねた日本地図" />;
}

export default function Home() {
  const [frames, setFrames] = useState<Frame[]>([]), [tiles, setTiles] = useState<Tile[]>([]), [zoom, setZoom] = useState(5);
  const [events, setEvents] = useState<RadarEvent[]>([]), [stats, setStats] = useState<Stats | null>(null), [active, setActive] = useState(0);
  const [opacity, setOpacity] = useState(.78), [isPlaying, setIsPlaying] = useState(false), [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveTitle, setArchiveTitle] = useState("大雨の記録"), [startTime, setStartTime] = useState(""), [endTime, setEndTime] = useState(""), [message, setMessage] = useState(""), [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [framesResponse, eventsResponse, statsResponse] = await Promise.all([fetch(`${API}/api/frames`), fetch(`${API}/api/events`), fetch(`${API}/api/stats`)]);
      const frameData = await framesResponse.json() as { frames: Frame[]; tiles: Tile[]; zoom: number };
      const eventData = await eventsResponse.json() as { events: RadarEvent[] };
      setFrames(frameData.frames); setTiles(frameData.tiles); setZoom(frameData.zoom); setEvents(eventData.events); setStats(await statsResponse.json() as Stats); setMessage("");
    } catch { setMessage("雨雲データへ接続できません。しばらくしてから再読み込みしてください。"); }
  }, []);

  useEffect(() => { loadData(); const timer = window.setInterval(loadData, 60_000); return () => window.clearInterval(timer); }, [loadData]);
  useEffect(() => { if (!isPlaying || frames.length < 2) return; const timer = window.setInterval(() => setActive((index) => (index <= 0 ? frames.length - 1 : index - 1)), 700); return () => window.clearInterval(timer); }, [isPlaying, frames.length]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "ArrowLeft") setActive((i) => Math.min(frames.length - 1, i + 1)); if (event.key === "ArrowRight") setActive((i) => Math.max(0, i - 1)); if (event.key === " ") { event.preventDefault(); setIsPlaying((value) => !value); } }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [frames.length]);

  const openArchive = () => {
    if (!frames.length) return;
    setEndTime(toInputValue(frames[0].valid_time)); setStartTime(toInputValue(frames[Math.min(frames.length - 1, 35)].valid_time)); setArchiveOpen(true);
  };

  const saveArchive = async () => {
    setSaving(true); setMessage("");
    try {
      const response = await fetch(`${API}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: archiveTitle, startTime: inputToRadar(startTime), endTime: inputToRadar(endTime) }) });
      if (!response.ok) throw new Error();
      await loadData(); setArchiveOpen(false); setMessage("豪雨イベントとして長期保存しました。");
    } catch { setMessage("イベントを保存できませんでした。"); }
    finally { setSaving(false); }
  };

  const current = frames[active];
  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">R</span><span>Recocast</span></div><div className="header-date">高解像度降水ナウキャスト <span>／ 5分更新</span></div><button className="add-button" disabled={!frames.length} onClick={openArchive}>＋ この流れを保存</button></header>
    <section className="workspace"><div className="map-area"><JapanMap frame={current} opacity={opacity} tiles={tiles} zoom={zoom} /><div className="map-head"><div><p className="eyebrow">JMA NOWCAST · LIVE ARCHIVE</p><h1>{current ? formatDate(current.valid_time) : "雨雲レーダーを準備中"}</h1></div><div className="live-chip"><i /> {current ? "実況データ" : "初回収集中"}</div></div>
      {!current && <div className="empty-state"><span className="drop-icon">↻</span><strong>最初の雨雲データを収集中</strong><small>5分以内に自動で表示されます</small></div>}
      <div className="map-legend"><span>雨量</span><i className="rain-scale" /><span>弱</span><span>強</span></div><div className="map-attribution">出典：気象庁「高解像度降水ナウキャスト」を加工して表示</div><div className="map-scale">100 km</div></div>
      <aside className="sidebar"><div className="sidebar-title"><div><p className="eyebrow dark">72 HOURS</p><h2>雨雲履歴</h2></div><span>{frames.length}</span></div><div className="history-list">{frames.length === 0 ? <div className="history-empty"><span>収集中です</span><small>新しい実況を5分ごとに保存します。</small></div> : frames.map((frame, index) => <button key={frame.valid_time} className={`history-card ${active === index ? "active" : ""}`} onClick={() => setActive(index)}><img src={tileUrl(frame, 28, 12, zoom)} alt="" /><span><strong>{formatDate(frame.valid_time)}</strong><small>{frame.event_id ? "長期保存済み" : `${formatBytes(frame.total_bytes)} · あと3日保存`}</small></span><i /></button>)}</div><div className="storage-note"><span>✓</span><div><strong>直近3日を自動保存</strong><small>{stats ? `${formatBytes(stats.total_bytes)} / ${stats.frame_count}時点 · 長期保存${events.length}件` : "容量を計測中"}</small></div></div></aside></section>
    <footer className="timeline-bar"><button className="play-button" onClick={() => setIsPlaying((value) => !value)} aria-label={isPlaying ? "停止" : "再生"}>{isPlaying ? "Ⅱ" : "▶"}</button><div className="timeline-track"><div className="timeline-dates"><span>{frames.at(-1) ? formatDate(frames.at(-1)!.valid_time) : "72時間前"}</span><strong>{current ? formatDate(current.valid_time) : "データ待機中"}</strong><span>{frames[0] ? formatDate(frames[0].valid_time) : "現在"}</span></div><input type="range" min="0" max={Math.max(0, frames.length - 1)} value={Math.max(0, frames.length - 1 - active)} onChange={(event) => setActive(Math.max(0, frames.length - 1 - Number(event.target.value)))} aria-label="雨雲履歴を移動" /><div className="tick-row"><span>72h</span><span>48h</span><span>24h</span><span>12h</span><span>6h</span><span>Now</span></div></div><label className="opacity-control"><span>雨雲</span><input type="range" min="20" max="100" value={opacity * 100} onChange={(event) => setOpacity(Number(event.target.value) / 100)} /><b>{Math.round(opacity * 100)}%</b></label></footer>
    {message && <div className="toast" role="status">{message}</div>}
    {archiveOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setArchiveOpen(false); }}><section className="upload-panel" role="dialog" aria-modal="true" aria-label="雨雲の流れを長期保存"><button className="close-button" onClick={() => setArchiveOpen(false)}>×</button><p className="eyebrow dark">PERMANENT ARCHIVE</p><h2>この雨雲の流れを保存</h2><p className="panel-lead">指定した区間は3日後も削除せず、豪雨イベントとして保管します。</p><div className="field-grid event-fields"><label><span>記録名</span><input value={archiveTitle} onChange={(event) => setArchiveTitle(event.target.value)} /></label><span /><label><span>開始</span><input type="datetime-local" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label><label><span>終了</span><input type="datetime-local" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></label></div><button className="save-button" disabled={saving || !archiveTitle || !startTime || !endTime} onClick={saveArchive}>{saving ? "保存中…" : "長期保存する"}</button></section></div>}
  </main>;
}

