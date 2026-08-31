"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

const API = "https://recocast-radar-api.h6fgpg2zht.workers.dev";
const TIMELINE_TICK_WIDTH = 44;
const TIMELINE_STEP_MS = 5 * 60 * 1000;
const CITY_MARKERS: { name: string; coordinates: [number, number] }[] = [
  { name: "東京", coordinates: [139.6917, 35.6895] },
  { name: "大阪", coordinates: [135.5200, 34.6863] },
];

type Tile = { x: number; y: number };
type Frame = { valid_time: string; base_time: string; tile_count: number; total_bytes: number; event_id: string | null; tiles: Tile[] };
type Stats = { frame_count: number; total_bytes: number; oldest_time: string | null; latest_time: string | null; event_count: number; retentionDays: number };
type TimelineSlot = { validTime: string; activeIndex: number | null };

function radarDate(value: string) {
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)), Number(value.slice(8, 10)), Number(value.slice(10, 12))));
}

function toRadarTime(value: Date) {
  return value.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function nearestAvailableSlot(slots: TimelineSlot[], centerIndex: number) {
  if (!slots.length) return -1;
  const clampedIndex = Math.max(0, Math.min(slots.length - 1, centerIndex));
  for (let offset = 0; offset < slots.length; offset += 1) {
    const newerIndex = clampedIndex + offset;
    if (newerIndex < slots.length && slots[newerIndex].activeIndex !== null) return newerIndex;
    const olderIndex = clampedIndex - offset;
    if (olderIndex >= 0 && slots[olderIndex].activeIndex !== null) return olderIndex;
  }
  return -1;
}

function formatClock(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" }).format(radarDate(value));
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" }).format(radarDate(value));
}

function formatTokyoDate(value: Date) {
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Tokyo" }).format(value);
}

function formatTokyoTime(value: Date) {
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Tokyo" }).format(value);
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

function visibleRadarTiles(map: MapLibreMap, tiles: Tile[], zoom: number) {
  const bounds = map.getBounds();
  const scale = 2 ** zoom;
  const tileX = (longitude: number) => Math.floor((longitude + 180) / 360 * scale);
  const tileY = (latitude: number) => {
    const radians = latitude * Math.PI / 180;
    return Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * scale);
  };
  const minX = tileX(bounds.getWest()) - 1;
  const maxX = tileX(bounds.getEast()) + 1;
  const minY = tileY(bounds.getNorth()) - 1;
  const maxY = tileY(bounds.getSouth()) + 1;
  return tiles.filter(({ x, y }) => x >= minX && x <= maxX && y >= minY && y <= maxY);
}

function JapanMap({ frame, opacity, tiles, zoom, overviewTiles, overviewZoom }: { frame?: Frame; opacity: number; tiles: Tile[]; zoom: number; overviewTiles: Tile[]; overviewZoom: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const opacityRef = useRef(opacity);
  const radarFrameKeyRef = useRef("");
  const [mapReady, setMapReady] = useState(false);
  const [detailedRadar, setDetailedRadar] = useState(false);
  const [viewportVersion, setViewportVersion] = useState(0);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [137.3, 36.2],
      zoom: 4.45,
      pitch: 0,
      bearing: 0,
      minZoom: 3,
      maxZoom: 8,
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          aerial: {
            type: "raster",
            tiles: ["https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"],
            tileSize: 256,
            attribution: "地理院タイル（全国最新写真）",
          },
        },
        layers: [
          { id: "ocean", type: "background", paint: { "background-color": "#061a20" } },
          { id: "aerial", type: "raster", source: "aerial", paint: { "raster-saturation": -.3, "raster-brightness-max": .74, "raster-fade-duration": 0 } },
        ],
      },
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    const cityMarkers = CITY_MARKERS.map(({ name, coordinates }) => {
      const element = document.createElement("div");
      const label = document.createElement("span");
      element.className = "city-location-marker";
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", `${name}の都府庁所在地`);
      label.textContent = name;
      element.appendChild(label);
      return new maplibregl.Marker({ element, anchor: "center" }).setLngLat(coordinates).addTo(map);
    });
    const loadMapLayers = () => {
      setMapReady(true);
    };
    map.on("load", loadMapLayers);
    const updateRadarDetail = () => setDetailedRadar(map.getZoom() >= 5.25);
    const updateRadarViewport = () => setViewportVersion((version) => version + 1);
    map.on("zoomend", updateRadarDetail);
    map.on("moveend", updateRadarViewport);
    mapRef.current = map;
    return () => {
      cityMarkers.forEach((marker) => marker.remove());
      map.off("load", loadMapLayers);
      map.off("zoomend", updateRadarDetail);
      map.off("moveend", updateRadarViewport);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const allDisplayTiles = detailedRadar ? tiles : overviewTiles;
    const displayZoom = detailedRadar ? zoom : overviewZoom;
    const displayTiles = frame ? visibleRadarTiles(map, allDisplayTiles, displayZoom) : [];
    const frameKey = frame ? `${frame.valid_time}:${displayZoom}` : "";
    const desiredIds = new Set(displayTiles.map(({ x, y }) => `radar-${displayZoom}-${x}-${y}`));
    const style = map.getStyle();
    const radarLayerIds = (style?.layers ?? []).map(({ id }) => id).filter((id) => id.startsWith("radar-"));
    const radarSourceIds = Object.keys(style?.sources ?? {}).filter((id) => id.startsWith("radar-"));
    const replaceFrame = radarFrameKeyRef.current !== frameKey;

    radarLayerIds
      .filter((id) => replaceFrame || !desiredIds.has(id))
      .forEach((id) => map.removeLayer(id));
    radarSourceIds
      .filter((id) => replaceFrame || !desiredIds.has(id))
      .forEach((id) => map.removeSource(id));
    radarFrameKeyRef.current = frameKey;
    if (!frame) return;

    displayTiles.forEach(({ x, y }) => {
      const id = `radar-${displayZoom}-${x}-${y}`;
      if (!map.getSource(id)) {
        map.addSource(id, {
          type: "image",
          url: tileUrl(frame, x, y, displayZoom),
          coordinates: tileCoordinates(x, y, displayZoom),
        });
      }
      if (!map.getLayer(id)) {
        map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": opacityRef.current, "raster-fade-duration": 0, "raster-resampling": "nearest" } });
      }
    });
  }, [detailedRadar, frame, mapReady, overviewTiles, overviewZoom, tiles, viewportVersion, zoom]);

  useEffect(() => {
    opacityRef.current = opacity;
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (map.getStyle()?.layers ?? [])
      .filter(({ id }) => id.startsWith("radar-"))
      .forEach(({ id }) => map.setPaintProperty(id, "raster-opacity", opacity));
  }, [opacity]);

  return <div ref={containerRef} className="map-canvas" aria-label="気象庁ナウキャストを重ねたMapLibre日本地図" />;
}

export default function Home() {
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollFrameRef = useRef<number | null>(null);
  const timelineCommitTimerRef = useRef<number | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]), [zoom, setZoom] = useState(5);
  const [overviewTiles, setOverviewTiles] = useState<Tile[]>([]), [overviewZoom, setOverviewZoom] = useState(6);
  const [stats, setStats] = useState<Stats | null>(null), [active, setActive] = useState(0);
  const [tokyoNow, setTokyoNow] = useState<Date | null>(null);
  const [opacity, setOpacity] = useState(.9), [isPlaying, setIsPlaying] = useState(false), [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveTitle, setArchiveTitle] = useState("大雨の記録"), [startTime, setStartTime] = useState(""), [endTime, setEndTime] = useState("");
  const [message, setMessage] = useState(""), [saving, setSaving] = useState(false);
  const [focusedTimelineIndex, setFocusedTimelineIndex] = useState(-1);

  const timelineSlots = useMemo<TimelineSlot[]>(() => {
    if (!frames.length) return [];
    const frameIndexByTime = new Map(frames.map((frame, activeIndex) => [frame.valid_time, activeIndex]));
    const oldestTime = radarDate(frames[frames.length - 1].valid_time).getTime();
    const latestTime = radarDate(frames[0].valid_time).getTime();
    const firstTick = Math.ceil(oldestTime / TIMELINE_STEP_MS) * TIMELINE_STEP_MS;
    const lastTick = Math.floor(latestTime / TIMELINE_STEP_MS) * TIMELINE_STEP_MS;
    const slots: TimelineSlot[] = [];
    for (let timestamp = firstTick; timestamp <= lastTick; timestamp += TIMELINE_STEP_MS) {
      const validTime = toRadarTime(new Date(timestamp));
      slots.push({ validTime, activeIndex: frameIndexByTime.get(validTime) ?? null });
    }
    return slots;
  }, [frames]);

  const loadData = useCallback(async () => {
    try {
      const [framesResponse, statsResponse] = await Promise.all([fetch(`${API}/api/frames`), fetch(`${API}/api/stats`)]);
      const frameData = await framesResponse.json() as { frames: Frame[]; zoom: number; overviewTiles: Tile[]; overviewZoom: number };
      setFrames(frameData.frames); setZoom(frameData.zoom); setOverviewTiles(frameData.overviewTiles); setOverviewZoom(frameData.overviewZoom); setStats(await statsResponse.json() as Stats); setMessage("");
    } catch { setMessage("雨雲データへ接続できません。しばらくしてから再読み込みしてください。"); }
  }, []);

  useEffect(() => { loadData(); const timer = window.setInterval(loadData, 60_000); return () => window.clearInterval(timer); }, [loadData]);
  useEffect(() => {
    const updateClock = () => setTokyoNow(new Date());
    updateClock();
    const timer = window.setInterval(updateClock, 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { if (!isPlaying || frames.length < 2) return; const timer = window.setInterval(() => setActive((index) => index <= 0 ? frames.length - 1 : index - 1), 700); return () => window.clearInterval(timer); }, [isPlaying, frames.length]);
  useEffect(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller) return;
    const updateSideSpace = () => {
      const sideSpace = Math.max(0, (scroller.clientWidth - TIMELINE_TICK_WIDTH) / 2);
      scroller.style.setProperty("--timeline-side-space", `${sideSpace}px`);
    };
    updateSideSpace();
    const observer = new ResizeObserver(updateSideSpace);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!timelineSlots.length) return;
    const slotIndex = timelineSlots.findIndex((slot) => slot.activeIndex === active);
    if (slotIndex < 0) return;
    setFocusedTimelineIndex(slotIndex);
    const animationFrame = window.requestAnimationFrame(() => {
      const scroller = timelineScrollRef.current;
      if (!scroller) return;
      const targetLeft = slotIndex * TIMELINE_TICK_WIDTH;
      if (Math.abs(scroller.scrollLeft - targetLeft) > 1) scroller.scrollTo({ left: targetLeft, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [active, timelineSlots]);
  useEffect(() => () => {
    if (timelineScrollFrameRef.current !== null) window.cancelAnimationFrame(timelineScrollFrameRef.current);
    if (timelineCommitTimerRef.current !== null) window.clearTimeout(timelineCommitTimerRef.current);
  }, []);
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

  const handleTimelineScroll = () => {
    if (timelineScrollFrameRef.current !== null) window.cancelAnimationFrame(timelineScrollFrameRef.current);
    timelineScrollFrameRef.current = window.requestAnimationFrame(() => {
      timelineScrollFrameRef.current = null;
      const scroller = timelineScrollRef.current;
      if (!scroller || !timelineSlots.length) return;
      const centerIndex = Math.round(scroller.scrollLeft / TIMELINE_TICK_WIDTH);
      const nearestIndex = nearestAvailableSlot(timelineSlots, centerIndex);
      if (nearestIndex < 0) return;
      setFocusedTimelineIndex(nearestIndex);
      if (timelineCommitTimerRef.current !== null) window.clearTimeout(timelineCommitTimerRef.current);
      timelineCommitTimerRef.current = window.setTimeout(() => {
        const activeIndex = timelineSlots[nearestIndex].activeIndex;
        if (activeIndex !== null) setActive(activeIndex);
      }, 120);
    });
  };

  const selectTimelineSlot = (slotIndex: number) => {
    const nearestIndex = nearestAvailableSlot(timelineSlots, slotIndex);
    if (nearestIndex < 0) return;
    setFocusedTimelineIndex(nearestIndex);
    timelineScrollRef.current?.scrollTo({ left: nearestIndex * TIMELINE_TICK_WIDTH, behavior: "auto" });
    const activeIndex = timelineSlots[nearestIndex].activeIndex;
    if (activeIndex !== null) setActive(activeIndex);
  };

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
    <div className="tokyo-clock"><span>{tokyoNow ? formatTokyoDate(tokyoNow) : "----/--/--"}</span><strong>{tokyoNow ? formatTokyoTime(tokyoNow) : "--:--"}</strong></div>
    <div className="action-float"><span className="live-chip"><i />実況</span><span className="archive-count">{stats ? `${stats.frame_count}時刻・${formatBytes(stats.total_bytes)}` : "接続中"}</span><button disabled={!frames.length} onClick={openArchive}>この流れを保存</button></div>
    {!current && <div className="empty-state"><span className="drop-icon">⌁</span><strong>雨雲レーダーを準備中</strong><small>自動取得したPNGを地図に重ねて表示します</small></div>}
    <div className="map-info-stack">
      <div className="source-disclosure">
        <button type="button" aria-label="出典を表示" aria-describedby="source-tooltip">i</button>
        <div className="source-tooltip" id="source-tooltip" role="tooltip">出典：気象庁「高解像度降水ナウキャスト」を加工して表示</div>
      </div>
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
    </div>

    <section className="time-dock" aria-label="時刻タイムライン">
      <button className="play-button" onClick={() => setIsPlaying((value) => !value)} aria-label={isPlaying ? "停止" : "再生"}>{isPlaying ? "Ⅱ" : "▶"}</button>
      <div className="dock-time"><small>表示中</small><strong>{current ? formatClock(current.valid_time) : "--:--"}</strong><span>{current ? formatDay(current.valid_time) : "待機中"}</span></div>
      <div className="slider-panel">
        <div className="timeline-scroll-shell">
          <div className="timeline-center-marker" aria-hidden="true" />
          <div className="timeline-scroll" ref={timelineScrollRef} onScroll={handleTimelineScroll} aria-label="5分刻みの雨雲レーダー時刻を横スクロール。中央の時刻を表示します">
            <div className="timeline-track">
              <span className="timeline-spacer" aria-hidden="true" />
              {timelineSlots.map((slot, chronologicalIndex) => {
                const selected = chronologicalIndex === focusedTimelineIndex;
                const missing = slot.activeIndex === null;
                return <button className={`timeline-tick${selected ? " is-active" : ""}${missing ? " is-missing" : ""}`} key={slot.validTime} onClick={() => selectTimelineSlot(chronologicalIndex)} aria-label={`${formatDay(slot.validTime)} ${formatClock(slot.validTime)}${missing ? "（最寄りの取得時刻を表示）" : "を表示"}`} aria-current={selected ? "true" : undefined}>
                  <i /><b>{formatClock(slot.validTime)}</b>{selected && <small>{formatDay(slot.validTime)}</small>}
                </button>;
              })}
              <span className="timeline-spacer" aria-hidden="true" />
            </div>
          </div>
        </div>
        <div className="range-caption"><span>5分刻み・横スクロール</span><span>中央の時刻を表示</span></div>
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

