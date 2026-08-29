"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

const API = "https://recocast-radar-api.h6fgpg2zht.workers.dev";
const PREFECTURE_GEOJSON_URL = "./data/japan-prefectures-map.geojson";

type Tile = { x: number; y: number };
type Frame = { valid_time: string; base_time: string; tile_count: number; total_bytes: number; event_id: string | null; tiles: Tile[] };
type Stats = { frame_count: number; total_bytes: number; oldest_time: string | null; latest_time: string | null; event_count: number; retentionDays: number };
type Position = [number, number];
type PrefectureGeometry = { type: "Polygon"; coordinates: Position[][] } | { type: "MultiPolygon"; coordinates: Position[][][] };
type PrefectureCollection = { features: { geometry: PrefectureGeometry }[] };

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

function tileCoordinates(x: number, y: number, zoom: number): [[number, number], [number, number], [number, number], [number, number]] {
  const scale = 2 ** zoom;
  const longitude = (tileX: number) => tileX / scale * 360 - 180;
  const latitude = (tileY: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / scale))) * 180 / Math.PI;
  const west = longitude(x), east = longitude(x + 1), north = latitude(y), south = latitude(y + 1);
  return [[west, north], [east, north], [east, south], [west, south]];
}

function JapanMap({ frame, opacity, tiles, zoom, overviewTiles, overviewZoom }: { frame?: Frame; opacity: number; tiles: Tile[]; zoom: number; overviewTiles: Tile[]; overviewZoom: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const borderCanvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [detailedRadar, setDetailedRadar] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [137.3, 36.2],
      zoom: 4.45,
      pitch: 0,
      bearing: 0,
      minZoom: 3,
      maxZoom: 9,
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          satellite: {
            type: "raster",
            tiles: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"],
            tileSize: 256,
            attribution: "地理院タイル（全国最新写真）",
          },
        },
        layers: [
          { id: "ocean", type: "background", paint: { "background-color": "#061a20" } },
          { id: "satellite", type: "raster", source: "satellite", paint: { "raster-saturation": -.3, "raster-brightness-max": .74 } },
        ],
      },
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("load", () => setMapReady(true));
    map.on("zoomend", () => setDetailedRadar(map.getZoom() >= 7));

    let cancelled = false;
    let prefectures: PrefectureCollection | null = null;
    const drawPrefectureBorders = () => {
      const canvas = borderCanvasRef.current;
      if (!canvas || !prefectures) return;
      const mapCanvas = map.getCanvas();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = mapCanvas.clientWidth;
      const height = mapCanvas.clientHeight;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.beginPath();
      const drawRing = (ring: Position[]) => {
        ring.forEach(([longitude, latitude], index) => {
          const point = map.project([longitude, latitude]);
          if (index === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        });
        context.closePath();
      };
      prefectures.features.forEach(({ geometry }) => {
        if (geometry.type === "Polygon") geometry.coordinates.forEach(drawRing);
        else geometry.coordinates.forEach((polygon) => polygon.forEach(drawRing));
      });
      const zoomScale = Math.max(0, Math.min(1, (map.getZoom() - 3) / 6));
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = "rgba(0, 0, 0, .95)";
      context.lineWidth = 4.5 + zoomScale * 2.5;
      context.stroke();
      context.strokeStyle = "#ffffff";
      context.lineWidth = 2 + zoomScale * 2;
      context.stroke();
    };
    map.on("moveend", drawPrefectureBorders);
    map.on("resize", drawPrefectureBorders);
    fetch(PREFECTURE_GEOJSON_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`Prefecture GeoJSON: ${response.status}`);
        return response.json() as Promise<PrefectureCollection>;
      })
      .then((data) => {
        if (!cancelled) {
          prefectures = data;
          drawPrefectureBorders();
        }
      })
      .catch((error) => console.error("Failed to draw prefecture borders", error));
    mapRef.current = map;
    return () => {
      cancelled = true;
      map.off("moveend", drawPrefectureBorders);
      map.off("resize", drawPrefectureBorders);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.getStyle().layers.filter(({ id }) => id.startsWith("radar-")).forEach(({ id }) => map.removeLayer(id));
    Object.keys(map.getStyle().sources).filter((id) => id.startsWith("radar-")).forEach((id) => map.removeSource(id));
    const displayTiles = detailedRadar ? tiles : overviewTiles;
    const displayZoom = detailedRadar ? zoom : overviewZoom;
    if (!frame || !displayTiles.length) return;
    displayTiles.forEach(({ x, y }) => {
      const id = `radar-${x}-${y}`;
      map.addSource(id, {
        type: "image",
        url: tileUrl(frame, x, y, displayZoom),
        coordinates: tileCoordinates(x, y, displayZoom),
      });
      map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": opacity, "raster-fade-duration": 0, "raster-resampling": "nearest" } });
    });
  }, [detailedRadar, frame, mapReady, opacity, overviewTiles, overviewZoom, tiles, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tiles.forEach(({ x, y }) => {
      const id = `radar-${x}-${y}`;
      if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", opacity);
    });
  }, [opacity, tiles]);

  return <><div ref={containerRef} className="map-canvas" aria-label="気象庁ナウキャストを重ねたMapLibre日本地図" /><canvas ref={borderCanvasRef} className="prefecture-overlay" aria-hidden="true" /></>;
}

export default function Home() {
  const [frames, setFrames] = useState<Frame[]>([]), [zoom, setZoom] = useState(5);
  const [overviewTiles, setOverviewTiles] = useState<Tile[]>([]), [overviewZoom, setOverviewZoom] = useState(6);
  const [stats, setStats] = useState<Stats | null>(null), [active, setActive] = useState(0);
  const [opacity, setOpacity] = useState(.9), [isPlaying, setIsPlaying] = useState(false), [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveTitle, setArchiveTitle] = useState("大雨の記録"), [startTime, setStartTime] = useState(""), [endTime, setEndTime] = useState("");
  const [message, setMessage] = useState(""), [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [framesResponse, statsResponse] = await Promise.all([fetch(`${API}/api/frames`), fetch(`${API}/api/stats`)]);
      const frameData = await framesResponse.json() as { frames: Frame[]; zoom: number; overviewTiles: Tile[]; overviewZoom: number };
      setFrames(frameData.frames); setZoom(frameData.zoom); setOverviewTiles(frameData.overviewTiles); setOverviewZoom(frameData.overviewZoom); setStats(await statsResponse.json() as Stats); setMessage("");
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

  useEffect(() => {
    const preventPageWheelZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    const preventPageKeyZoom = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ["+", "-", "=", "0"].includes(event.key)) event.preventDefault();
    };
    const preventGesture = (event: Event) => event.preventDefault();
    document.addEventListener("wheel", preventPageWheelZoom, { passive: false });
    document.addEventListener("keydown", preventPageKeyZoom);
    document.addEventListener("gesturestart", preventGesture, { passive: false });
    return () => {
      document.removeEventListener("wheel", preventPageWheelZoom);
      document.removeEventListener("keydown", preventPageKeyZoom);
      document.removeEventListener("gesturestart", preventGesture);
    };
  }, []);

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
    <section className="fullscreen-map"><JapanMap frame={current} opacity={opacity} tiles={current?.tiles || []} zoom={zoom} overviewTiles={overviewTiles} overviewZoom={overviewZoom} /><div className="map-vignette" /></section>
    <div className="brand-float"><span className="brand-mark">R</span><span className="brand-copy"><strong>Recocast</strong><small>RAIN ARCHIVE</small></span></div>
    <div className="action-float"><span className="live-chip"><i />実況</span><span className="archive-count">{stats ? `${stats.frame_count}時刻・${formatBytes(stats.total_bytes)}` : "接続中"}</span><button disabled={!frames.length} onClick={openArchive}>この流れを保存</button></div>
    <div className="selected-time"><span>表示時刻</span><strong>{current ? formatClock(current.valid_time) : "--:--"}</strong><small>{current ? formatDay(current.valid_time) : "雨雲データを取得中"}</small></div>
    {!current && <div className="empty-state"><span className="drop-icon">⌁</span><strong>雨雲レーダーを準備中</strong><small>自動取得したPNGを地図に重ねて表示します</small></div>}
    <div className="rain-legend" aria-label="気象庁と同じ降水強度の凡例">
      <strong>降水強度</strong><span>mm/h</span>
      <div className="legend-row"><i style={{ background: "#b40068" }} /><b>80〜</b></div>
      <div className="legend-row"><i style={{ background: "#ff2800" }} /><b>50〜80</b></div>
      <div className="legend-row"><i style={{ background: "#ff9900" }} /><b>30〜50</b></div>
      <div className="legend-row"><i style={{ background: "#faf500" }} /><b>20〜30</b></div>
      <div className="legend-row"><i style={{ background: "#0041ff" }} /><b>10〜20</b></div>
      <div className="legend-row"><i style={{ background: "#218cff" }} /><b>5〜10</b></div>
      <div className="legend-row"><i style={{ background: "#a0d2ff" }} /><b>1〜5</b></div>
      <div className="legend-row"><i style={{ background: "#f2f2ff" }} /><b>0〜1</b></div>
    </div>
    <div className="map-attribution">出典：気象庁「高解像度降水ナウキャスト」を加工して表示</div>

    <section className="time-dock" aria-label="時刻タイムライン">
      <button className="play-button" onClick={() => setIsPlaying((value) => !value)} aria-label={isPlaying ? "停止" : "再生"}>{isPlaying ? "Ⅱ" : "▶"}</button>
      <div className="dock-time"><small>表示中</small><strong>{current ? formatClock(current.valid_time) : "--:--"}</strong><span>{current ? formatDay(current.valid_time) : "待機中"}</span></div>
      <div className="slider-panel">
        <div className="slider-stage"><div className="tick-rail" /><input className="timeline-slider" type="range" min="0" max={Math.max(0, frames.length - 1)} value={Math.max(0, frames.length - 1 - active)} onChange={(event) => setActive(Math.max(0, frames.length - 1 - Number(event.target.value)))} aria-label="雨雲レーダーの時刻を移動" /></div>
        <div className="time-labels">{markerIndices.map((index, marker) => <span key={`${index}-${marker}`}><b>{formatClock(frames[index].valid_time)}</b><small>{formatDay(frames[index].valid_time)}</small></span>)}</div>
        <div className="range-caption"><span>36時間前</span><span>現在</span></div>
      </div>
      <label className="opacity-control"><span>雨雲の濃さ</span><input type="range" min="20" max="100" value={opacity * 100} onChange={(event) => setOpacity(Number(event.target.value) / 100)} /><b>{Math.round(opacity * 100)}%</b></label>
    </section>

    {message && <div className="toast" role="status">{message}</div>}
    {archiveOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setArchiveOpen(false)}><section className="archive-panel" role="dialog" aria-modal="true" aria-label="雨雲の流れを長期保存">
      <button className="close-button" onClick={() => setArchiveOpen(false)} aria-label="閉じる">×</button><p className="eyebrow">PERMANENT ARCHIVE</p><h2>この雨雲の流れを保存</h2><p className="panel-lead">指定した期間を、36時間後も消えない大雨イベントとして保管します。</p>
      <div className="field-grid"><label className="title-field"><span>記録名</span><input value={archiveTitle} onChange={(event) => setArchiveTitle(event.target.value)} /></label><label><span>開始</span><input type="datetime-local" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label><label><span>終了</span><input type="datetime-local" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></label></div>
      <button className="save-button" disabled={saving || !archiveTitle || !startTime || !endTime} onClick={saveArchive}>{saving ? "保存中…" : "長期保存する"}</button>
    </section></div>}
  </main>;
}

