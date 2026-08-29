"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API = "https://recocast-radar-api.h6fgpg2zht.workers.dev";

type Frame = { valid_time: string; base_time: string; tile_count: number; total_bytes: number; event_id: string | null };
type Tile = { x: number; y: number };
type Stats = { frame_count: number; total_bytes: number; oldest_time: string | null; latest_time: string | null; event_count: number; retentionDays: number };
type GeoGeometry = { type: "Polygon" | "MultiPolygon"; coordinates: number[][][][] | number[][][] };
type GeoCollection = { features: Array<{ geometry: GeoGeometry }> };

function radarDate(value: string) {
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)), Number(value.slice(8, 10)), Number(value.slice(10, 12))));
}

function formatClock(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" }).format(radarDate(value));
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" }).format(radarDate(value));
}

function toInputValue(value: string) {
  return new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }).format(radarDate(value)).replace(" ", "T");
}

function inputToRadar(value: string) {
  return new Date(`${value}:00+09:00`).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
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
  const [resizeVersion, setResizeVersion] = useState(0);

  useEffect(() => {
    fetch("https://raw.githubusercontent.com/geolonia/prefecture-tiles/master/prefectures.geojson")
      .then(async (response) => (await response.json()) as GeoCollection)
      .then(setGeo)
      .catch(() => setGeo(null));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setResizeVersion((version) => version + 1));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !geo) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let cancelled = false;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = rect.width, height = rect.height;
    const minLon = 122.4, maxLon = 153.9, minLat = 23, maxLat = 46.1;
    const mercatorY = (lat: number) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2;
    const minX = (minLon + 180) / 360, maxX = (maxLon + 180) / 360, minY = mercatorY(maxLat), maxY = mercatorY(minLat);
    const worldToCanvas = (x: number, y: number) => [((x - minX) / (maxX - minX)) * width, ((y - minY) / (maxY - minY)) * height] as const;
    const project = ([lon, lat]: number[]) => worldToCanvas((lon + 180) / 360, mercatorY(lat));
    const forEachRing = (draw: (ring: number[][]) => void) => {
      geo.features.forEach(({ geometry }) => {
        const polygons = geometry.type === "Polygon" ? [geometry.coordinates as number[][][]] : geometry.coordinates as number[][][][];
        polygons.forEach((polygon) => polygon.forEach(draw));
      });
    };

    const land = new Path2D();
    forEachRing((ring) => {
      ring.forEach((point, index) => { const [x, y] = project(point); if (index === 0) land.moveTo(x, y); else land.lineTo(x, y); });
      land.closePath();
    });

    const drawTerrain = () => {
      const ocean = ctx.createRadialGradient(width * .58, height * .42, 20, width * .55, height * .45, width * .82);
      ocean.addColorStop(0, "#173c45"); ocean.addColorStop(.48, "#0a2932"); ocean.addColorStop(1, "#04171d");
      ctx.fillStyle = ocean; ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = .18; ctx.strokeStyle = "#5f98a0"; ctx.lineWidth = .45;
      for (let x = -height; x < width + height; x += 46) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + height, height); ctx.stroke(); }
      ctx.globalAlpha = 1;
      const terrain = ctx.createLinearGradient(width * .2, 0, width * .8, height);
      terrain.addColorStop(0, "#26483d"); terrain.addColorStop(.48, "#69735a"); terrain.addColorStop(1, "#25443a");
      ctx.fillStyle = terrain; ctx.fill(land, "evenodd");
      ctx.save(); ctx.clip(land, "evenodd");
      for (let index = 0; index < 140; index += 1) {
        const x = (((index * 83) % 1000) / 1000) * width, y = (((index * 137) % 997) / 997) * height;
        ctx.fillStyle = index % 3 ? "rgba(235,221,170,.05)" : "rgba(2,25,21,.14)";
        ctx.beginPath(); ctx.ellipse(x, y, 18 + (index % 7) * 9, 4 + (index % 5) * 4, -.6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    };

    const drawBorders = () => {
      ctx.save(); ctx.strokeStyle = "rgba(255,255,255,.95)"; ctx.lineWidth = .8; ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 2;
      forEachRing((ring) => {
        ctx.beginPath();
        ring.forEach((point, index) => { const [x, y] = project(point); if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        ctx.closePath(); ctx.stroke();
      });
      ctx.restore();
    };

    drawTerrain();
    if (!frame) { drawBorders(); return; }
    const scale = 2 ** zoom;
    Promise.all(tiles.map(({ x, y }) => new Promise<{ image: HTMLImageElement; x: number; y: number } | null>((resolve) => {
      const image = new Image(); image.crossOrigin = "anonymous"; image.onload = () => resolve({ image, x, y }); image.onerror = () => resolve(null); image.src = tileUrl(frame, x, y, zoom);
    }))).then((loaded) => {
      if (cancelled) return;
      ctx.save(); ctx.globalAlpha = opacity;
      loaded.forEach((tile) => { if (!tile) return; const [left, top] = worldToCanvas(tile.x / scale, tile.y / scale); const [right, bottom] = worldToCanvas((tile.x + 1) / scale, (tile.y + 1) / scale); ctx.drawImage(tile.image, left, top, right - left, bottom - top); });
      ctx.restore(); drawBorders();
    });
    return () => { cancelled = true; };
  }, [geo, frame, opacity, resizeVersion, tiles, zoom]);

  return <canvas ref={canvasRef} className="map-canvas" aria-label="気象庁ナウキャストを重ねた日本地図" />;
}

export default function Home() {
  const [frames, setFrames] = useState<Frame[]>([]), [tiles, setTiles] = useState<Tile[]>([]), [zoom, setZoom] = useState(5);
  const [stats, setStats] = useState<Stats | null>(null), [active, setActive] = useState(0);
  const [opacity, setOpacity] = useState(.78), [isPlaying, setIsPlaying] = useState(false), [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveTitle, setArchiveTitle] = useState("大雨の記録"), [startTime, setStartTime] = useState(""), [endTime, setEndTime] = useState("");
  const [message, setMessage] = useState(""), [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [framesResponse, statsResponse] = await Promise.all([fetch(`${API}/api/frames`), fetch(`${API}/api/stats`)]);
      const frameData = await framesResponse.json() as { frames: Frame[]; tiles: Tile[]; zoom: number };
      setFrames(frameData.frames); setTiles(frameData.tiles); setZoom(frameData.zoom); setStats(await statsResponse.json() as Stats); setMessage("");
    } catch { setMessage("雨雲データへ接続できません。しばらくしてから再読み込みしてください。"); }
  }, []);

  useEffect(() => { loadData(); const timer = window.setInterval(loadData, 60_000); return () => window.clearInterval(timer); }, [loadData]);
  useEffect(() => { if (!isPlaying || frames.length < 2) return; const timer = window.setInterval(() => setActive((index) => index <= 0 ? frames.length - 1 : index - 1), 700); return () => window.clearInterval(timer); }, [isPlaying, frames.length]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") setActive((index) => Math.min(frames.length - 1, index + 1));
      if (event.key === "ArrowRight") setActive((index) => Math.max(0, index - 1));
      if (event.key === " ") { event.preventDefault(); setIsPlaying((value) => !value); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [frames.length]);

  const current = frames[active];
  const markerIndices = useMemo(() => {
    if (!frames.length) return [];
    const last = frames.length - 1;
    return [last, Math.round(last * .75), Math.round(last * .5), Math.round(last * .25), 0];
  }, [frames.length]);

  const openArchive = () => {
    if (!frames.length) return;
    setEndTime(toInputValue(frames[0].valid_time)); setStartTime(toInputValue(frames[Math.min(frames.length - 1, 35)].valid_time)); setArchiveOpen(true);
  };

  const saveArchive = async () => {
    setSaving(true); setMessage("");
    try {
      const response = await fetch(`${API}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: archiveTitle, startTime: inputToRadar(startTime), endTime: inputToRadar(endTime) }) });
      if (!response.ok) throw new Error();
      await loadData(); setArchiveOpen(false); setMessage("大雨イベントとして長期保存しました。");
    } catch { setMessage("イベントを保存できませんでした。"); }
    finally { setSaving(false); }
  };

  return <main className="map-shell">
    <section className="fullscreen-map"><JapanMap frame={current} opacity={opacity} tiles={tiles} zoom={zoom} /><div className="map-vignette" /></section>
    <div className="brand-float"><span className="brand-mark">R</span><span className="brand-copy"><strong>Recocast</strong><small>RAIN ARCHIVE</small></span></div>
    <div className="action-float"><span className="live-chip"><i />実況</span><span className="archive-count">{stats ? `${stats.frame_count}時刻・${formatBytes(stats.total_bytes)}` : "接続中"}</span><button disabled={!frames.length} onClick={openArchive}>この流れを保存</button></div>
    <div className="selected-time"><span>表示時刻</span><strong>{current ? formatClock(current.valid_time) : "--:--"}</strong><small>{current ? formatDay(current.valid_time) : "雨雲データを取得中"}</small></div>
    {!current && <div className="empty-state"><span className="drop-icon">⌁</span><strong>雨雲レーダーを準備中</strong><small>自動取得したPNGを地図に重ねて表示します</small></div>}
    <div className="rain-legend"><span>雨量</span><i /><small>弱</small><small>強</small></div>
    <div className="map-attribution">出典：気象庁「高解像度降水ナウキャスト」を加工して表示</div>

    <section className="time-dock" aria-label="時刻タイムライン">
      <button className="play-button" onClick={() => setIsPlaying((value) => !value)} aria-label={isPlaying ? "停止" : "再生"}>{isPlaying ? "Ⅱ" : "▶"}</button>
      <div className="dock-time"><small>表示中</small><strong>{current ? formatClock(current.valid_time) : "--:--"}</strong><span>{current ? formatDay(current.valid_time) : "待機中"}</span></div>
      <div className="slider-panel">
        <div className="slider-stage"><div className="tick-rail" /><input className="timeline-slider" type="range" min="0" max={Math.max(0, frames.length - 1)} value={Math.max(0, frames.length - 1 - active)} onChange={(event) => setActive(Math.max(0, frames.length - 1 - Number(event.target.value)))} aria-label="雨雲レーダーの時刻を移動" /></div>
        <div className="time-labels">{markerIndices.map((index, marker) => <span key={`${index}-${marker}`}><b>{formatClock(frames[index].valid_time)}</b><small>{formatDay(frames[index].valid_time)}</small></span>)}</div>
        <div className="range-caption"><span>3日前</span><span>現在</span></div>
      </div>
      <label className="opacity-control"><span>雨雲の濃さ</span><input type="range" min="20" max="100" value={opacity * 100} onChange={(event) => setOpacity(Number(event.target.value) / 100)} /><b>{Math.round(opacity * 100)}%</b></label>
    </section>

    {message && <div className="toast" role="status">{message}</div>}
    {archiveOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setArchiveOpen(false)}><section className="archive-panel" role="dialog" aria-modal="true" aria-label="雨雲の流れを長期保存">
      <button className="close-button" onClick={() => setArchiveOpen(false)} aria-label="閉じる">×</button><p className="eyebrow">PERMANENT ARCHIVE</p><h2>この雨雲の流れを保存</h2><p className="panel-lead">指定した期間を、3日後も消えない大雨イベントとして保管します。</p>
      <div className="field-grid"><label className="title-field"><span>記録名</span><input value={archiveTitle} onChange={(event) => setArchiveTitle(event.target.value)} /></label><label><span>開始</span><input type="datetime-local" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label><label><span>終了</span><input type="datetime-local" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></label></div>
      <button className="save-button" disabled={saving || !archiveTitle || !startTime || !endTime} onClick={saveArchive}>{saving ? "保存中…" : "長期保存する"}</button>
    </section></div>}
  </main>;
}
