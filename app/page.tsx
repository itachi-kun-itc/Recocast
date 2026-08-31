"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, OverscaledTileID, RasterTileSource, StyleSpecification } from "maplibre-gl";

const API = "https://recocast-radar-api.h6fgpg2zht.workers.dev";
const RADAR_PROTOCOL = "recocast-radar";
const RADAR_TILE_SIZE = 64;
const RADAR_BOUNDS: [number, number, number, number] = [118, 20, 150, 48];
const TRANSPARENT_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XyJbWQAAAABJRU5ErkJggg==";
const TIMELINE_TICK_WIDTH = 44;
const TIMELINE_STEP_MS = 5 * 60 * 1000;
const CITY_MARKERS: { name: string; coordinates: [number, number]; primary?: boolean }[] = [
  { name: "東京", coordinates: [139.6917, 35.6895], primary: true },
  { name: "大阪", coordinates: [135.5200, 34.6863], primary: true },
  { name: "神戸", coordinates: [135.1830, 34.6913] },
  { name: "福岡", coordinates: [130.4183, 33.6064] },
  { name: "名古屋", coordinates: [136.9066, 35.1802] },
  { name: "仙台", coordinates: [140.8721, 38.2688] },
  { name: "札幌", coordinates: [141.3468, 43.0643] },
  { name: "那覇", coordinates: [127.6809, 26.2124] },
  { name: "金沢", coordinates: [136.6256, 36.5947] },
];

type Tile = { x: number; y: number };
type Frame = { valid_time: string; base_time: string; tile_count: number; total_bytes: number; event_id: string | null; tiles: Tile[] };
type Stats = { frame_count: number; total_bytes: number; oldest_time: string | null; latest_time: string | null; event_count: number; retentionDays: number };
type TimelineSlot = { validTime: string; activeIndex: number | null };
type RadarAvailability = { validTime: string; tilesByZoom: Map<number, Set<string>> };
type MapViewport = { center: [number, number]; zoom: number };

const EMPTY_TILES: Tile[] = [];

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

function radarTileTemplate(validTime: string) {
  return `${RADAR_PROTOCOL}://${validTime}/{z}/{x}/{y}.png`;
}

function radarHttpTileTemplate(validTime: string) {
  return `${API}/api/frames/${validTime}/tiles/{z}/{x}/{y}.png`;
}

function createBaseMapStyle(): StyleSpecification {
  return {
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
  };
}

function radarTileKey({ x, y }: Tile) {
  return `${x}/${y}`;
}

function transparentRadarTile() {
  const binary = atob(TRANSPARENT_PNG_BASE64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

const JapanMap = memo(function JapanMap({ frame, opacity, tiles, zoom, overviewTiles, overviewZoom, viewportRef }: { frame?: Frame; opacity: number; tiles: Tile[]; zoom: number; overviewTiles: Tile[]; overviewZoom: number; viewportRef: { current: MapViewport } }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const opacityRef = useRef(opacity);
  const radarFrameKeyRef = useRef("");
  const radarConfigKeyRef = useRef("");
  const radarAvailabilityRef = useRef<RadarAvailability>({ validTime: "", tilesByZoom: new Map() });
  const [mapReady, setMapReady] = useState(false);

  radarAvailabilityRef.current = {
    validTime: frame?.valid_time ?? "",
    tilesByZoom: new Map([
      [overviewZoom, new Set(overviewTiles.map(radarTileKey))],
      [zoom, new Set(tiles.map(radarTileKey))],
    ]),
  };

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    maplibregl.addProtocol(RADAR_PROTOCOL, async ({ url }, abortController) => {
      const match = url.match(/^recocast-radar:\/\/(\d{14})\/(\d+)\/(\d+)\/(\d+)\.png$/);
      if (!match) return { data: transparentRadarTile() };
      const [, validTime, zoomValue, x, y] = match;
      const requestedZoom = Number(zoomValue);
      const availability = radarAvailabilityRef.current;
      const availableTiles = availability.tilesByZoom.get(requestedZoom);
      if (availability.validTime !== validTime || !availableTiles?.has(`${x}/${y}`)) {
        return { data: transparentRadarTile() };
      }
      const response = await fetch(`${API}/api/frames/${validTime}/tiles/${requestedZoom}/${x}/${y}.png`, { signal: abortController.signal });
      if (!response.ok) return { data: transparentRadarTile() };
      return {
        data: await response.arrayBuffer(),
        cacheControl: response.headers.get("cache-control") ?? undefined,
        expires: response.headers.get("expires") ?? undefined,
      };
    });
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
      style: createBaseMapStyle(),
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    const mapShell = containerRef.current.closest<HTMLElement>(".map-shell");
    const beginMapMotion = () => mapShell?.classList.add("map-is-moving");
    const updateViewport = () => {
      const center = map.getCenter();
      viewportRef.current = { center: [center.lng, center.lat], zoom: map.getZoom() };
    };
    const endMapMotion = () => {
      mapShell?.classList.remove("map-is-moving");
      updateViewport();
    };
    updateViewport();
    map.on("movestart", beginMapMotion);
    map.on("moveend", endMapMotion);
    const cityMarkers = CITY_MARKERS.map(({ name, coordinates, primary = false }) => {
      const element = document.createElement("div");
      const label = document.createElement("span");
      element.className = `city-location-marker${primary ? "" : " city-location-marker-secondary"}`;
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", `${name}の都府庁所在地`);
      label.textContent = name;
      element.appendChild(label);
      return { marker: new maplibregl.Marker({ element, anchor: "center" }).setLngLat(coordinates).addTo(map), element, primary };
    });
    const updateCityMarkerVisibility = () => {
      const showSecondaryCities = map.getZoom() >= 5.5;
      cityMarkers.forEach(({ element, primary }) => element.classList.toggle("is-hidden", !primary && !showSecondaryCities));
    };
    updateCityMarkerVisibility();
    map.on("zoomend", updateCityMarkerVisibility);
    const loadMapLayers = () => setMapReady(true);
    map.on("load", loadMapLayers);
    mapRef.current = map;
    return () => {
      cityMarkers.forEach(({ marker }) => marker.remove());
      map.off("load", loadMapLayers);
      map.off("zoomend", updateCityMarkerVisibility);
      map.off("movestart", beginMapMotion);
      map.off("moveend", endMapMotion);
      mapShell?.classList.remove("map-is-moving");
      map.remove();
      maplibregl.removeProtocol(RADAR_PROTOCOL);
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const overviewId = "radar-overview";
    const detailId = "radar-detail";
    const configKey = `${overviewZoom}:${zoom}`;
    const removeRadarSources = () => {
      [overviewId, detailId].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      [overviewId, detailId].forEach((id) => {
        if (map.getSource(id)) map.removeSource(id);
      });
    };

    if (!frame) {
      [overviewId, detailId].forEach((id) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
      });
      radarFrameKeyRef.current = "";
      return;
    }

    if (radarConfigKeyRef.current !== configKey || !map.getSource(overviewId) || !map.getSource(detailId)) {
      removeRadarSources();
      const tilesUrl = radarTileTemplate(frame.valid_time);
      map.addSource(overviewId, {
        type: "raster",
        tiles: [tilesUrl],
        tileSize: RADAR_TILE_SIZE,
        minzoom: overviewZoom,
        maxzoom: overviewZoom,
        bounds: RADAR_BOUNDS,
        attribution: "気象庁",
      });
      map.addSource(detailId, {
        type: "raster",
        tiles: [tilesUrl],
        tileSize: RADAR_TILE_SIZE,
        minzoom: zoom,
        maxzoom: zoom,
        bounds: RADAR_BOUNDS,
        attribution: "気象庁",
      });
      const attachAvailabilityFilter = (sourceId: string, sourceZoom: number) => {
        const source = map.getSource(sourceId) as RasterTileSource;
        source.hasTile = (tileId: OverscaledTileID) => {
          const { z, x, y } = tileId.canonical;
          const availableTiles = radarAvailabilityRef.current.tilesByZoom.get(sourceZoom);
          return z === sourceZoom && Boolean(availableTiles?.has(`${x}/${y}`));
        };
      };
      attachAvailabilityFilter(overviewId, overviewZoom);
      attachAvailabilityFilter(detailId, zoom);
      const paint = { "raster-opacity": opacityRef.current, "raster-fade-duration": 0, "raster-resampling": "nearest" } as const;
      map.addLayer({ id: overviewId, type: "raster", source: overviewId, maxzoom: 5.25, paint });
      map.addLayer({ id: detailId, type: "raster", source: detailId, minzoom: 5.25, paint });
      radarConfigKeyRef.current = configKey;
      radarFrameKeyRef.current = frame.valid_time;
      return;
    }

    [overviewId, detailId].forEach((id) => map.setLayoutProperty(id, "visibility", "visible"));
    if (radarFrameKeyRef.current === frame.valid_time) return;
    const tilesUrl = radarTileTemplate(frame.valid_time);
    (map.getSource(overviewId) as RasterTileSource).setTiles([tilesUrl]);
    (map.getSource(detailId) as RasterTileSource).setTiles([tilesUrl]);
    radarFrameKeyRef.current = frame.valid_time;
  }, [frame, mapReady, overviewZoom, zoom]);

  useEffect(() => {
    opacityRef.current = opacity;
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (map.getStyle()?.layers ?? [])
      .filter(({ id }) => id.startsWith("radar-"))
      .forEach(({ id }) => map.setPaintProperty(id, "raster-opacity", opacity));
  }, [opacity]);

  return <div ref={containerRef} className="map-canvas" aria-label="気象庁ナウキャストを重ねたMapLibre日本地図" />;
});

const TokyoClock = memo(function TokyoClock() {
  const [tokyoNow, setTokyoNow] = useState<Date | null>(null);
  useEffect(() => {
    const updateClock = () => setTokyoNow(new Date());
    updateClock();
    const timer = window.setInterval(updateClock, 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="tokyo-clock"><span>{tokyoNow ? formatTokyoDate(tokyoNow) : "----/--/--"}</span><strong>{tokyoNow ? formatTokyoTime(tokyoNow) : "--:--"}</strong></div>;
});

function abortError() {
  return new DOMException("動画生成を中止しました。", "AbortError");
}

function waitForMapIdle(map: MapLibreMap, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    let timeout = 0;
    const cleanup = () => {
      map.off("idle", finish);
      signal.removeEventListener("abort", cancel);
      window.clearTimeout(timeout);
    };
    const finish = () => { cleanup(); resolve(); };
    const cancel = () => { cleanup(); reject(abortError()); };
    map.once("idle", finish);
    signal.addEventListener("abort", cancel, { once: true });
    timeout = window.setTimeout(finish, 30_000);
    map.triggerRepaint();
  });
}

function waitForMapLoad(map: MapLibreMap, signal: AbortSignal) {
  if (map.loaded()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = () => { cleanup(); resolve(); };
    const cancel = () => { cleanup(); reject(abortError()); };
    const cleanup = () => {
      map.off("load", finish);
      signal.removeEventListener("abort", cancel);
    };
    map.once("load", finish);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function waitForPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

async function createRadarVideo({ frames, fps, overviewTiles, overviewZoom, zoom, opacity, viewport, signal, onProgress }: {
  frames: Frame[];
  fps: number;
  overviewTiles: Tile[];
  overviewZoom: number;
  zoom: number;
  opacity: number;
  viewport: MapViewport;
  signal: AbortSignal;
  onProgress: (completed: number, total: number) => void;
}) {
  const width = 1280;
  const height = 720;
  const container = document.createElement("div");
  Object.assign(container.style, { position: "fixed", left: "-10000px", top: "0", width: `${width}px`, height: `${height}px`, pointerEvents: "none" });
  document.body.appendChild(container);
  let exportMap: MapLibreMap | null = null;
  let cancelOutput: (() => Promise<void>) | null = null;

  try {
    const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, canEncodeVideo } = await import("mediabunny");
    if (!await canEncodeVideo("avc", { width, height, quality: QUALITY_HIGH })) {
      throw new Error("この端末はMP4（H.264）の生成に対応していません。");
    }
    if (signal.aborted) throw abortError();

    exportMap = new maplibregl.Map({
      container,
      center: viewport.center,
      zoom: viewport.zoom,
      minZoom: 3,
      maxZoom: 8,
      pitch: 0,
      bearing: 0,
      maxPitch: 0,
      interactive: false,
      attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true },
      pixelRatio: 1,
      fadeDuration: 0,
      style: createBaseMapStyle(),
    });
    await waitForMapLoad(exportMap, signal);

    let exportFrame = frames[0];
    let detailSet = new Set(exportFrame.tiles.map(radarTileKey));
    const overviewSet = new Set(overviewTiles.map(radarTileKey));
    const firstTilesUrl = radarHttpTileTemplate(exportFrame.valid_time);
    exportMap.addSource("video-radar-overview", { type: "raster", tiles: [firstTilesUrl], tileSize: RADAR_TILE_SIZE, minzoom: overviewZoom, maxzoom: overviewZoom, bounds: RADAR_BOUNDS });
    exportMap.addSource("video-radar-detail", { type: "raster", tiles: [firstTilesUrl], tileSize: RADAR_TILE_SIZE, minzoom: zoom, maxzoom: zoom, bounds: RADAR_BOUNDS });
    const overviewSource = exportMap.getSource("video-radar-overview") as RasterTileSource;
    const detailSource = exportMap.getSource("video-radar-detail") as RasterTileSource;
    overviewSource.hasTile = (tileId: OverscaledTileID) => {
      const { z, x, y } = tileId.canonical;
      return z === overviewZoom && overviewSet.has(`${x}/${y}`);
    };
    detailSource.hasTile = (tileId: OverscaledTileID) => {
      const { z, x, y } = tileId.canonical;
      return z === zoom && detailSet.has(`${x}/${y}`);
    };
    const radarPaint = { "raster-opacity": opacity, "raster-fade-duration": 0, "raster-resampling": "nearest" } as const;
    exportMap.addLayer({ id: "video-radar-overview", type: "raster", source: "video-radar-overview", maxzoom: 5.25, paint: radarPaint });
    exportMap.addLayer({ id: "video-radar-detail", type: "raster", source: "video-radar-detail", minzoom: 5.25, paint: radarPaint });

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("動画用キャンバスを作成できませんでした。");
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
    cancelOutput = () => output.cancel();
    const videoSource = new CanvasSource(canvas, { codec: "avc", quality: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(videoSource);
    await output.start();

    for (let index = 0; index < frames.length; index += 1) {
      if (signal.aborted) throw abortError();
      exportFrame = frames[index];
      detailSet = new Set(exportFrame.tiles.map(radarTileKey));
      if (index > 0) {
        const tilesUrl = radarHttpTileTemplate(exportFrame.valid_time);
        overviewSource.setTiles([tilesUrl]);
        detailSource.setTiles([tilesUrl]);
      }
      await waitForMapIdle(exportMap, signal);
      await waitForPaint();
      context.drawImage(exportMap.getCanvas(), 0, 0, width, height);
      context.fillStyle = "rgba(5, 20, 24, .86)";
      context.fillRect(24, 24, 274, 68);
      context.fillStyle = "#ffffff";
      context.font = '500 24px Arial, "Noto Sans JP", sans-serif';
      context.fillText(`${formatTokyoDate(radarDate(exportFrame.valid_time))} ${formatTokyoTime(radarDate(exportFrame.valid_time))}`, 42, 66);
      context.fillStyle = "rgba(255, 255, 255, .72)";
      context.font = '500 13px Arial, "Noto Sans JP", sans-serif';
      context.fillText("気象庁 高解像度降水ナウキャスト", 42, 84);
      await videoSource.add(index / fps, 1 / fps, { keyFrame: index === 0 || index % Math.max(1, Math.round(fps * 2)) === 0 });
      onProgress(index + 1, frames.length);
    }

    await output.finalize();
    cancelOutput = null;
    if (!target.buffer) throw new Error("MP4データを生成できませんでした。");
    return target.buffer;
  } catch (error) {
    if (cancelOutput) await cancelOutput().catch(() => undefined);
    throw error;
  } finally {
    exportMap?.remove();
    container.remove();
  }
}

export default function Home() {
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollFrameRef = useRef<number | null>(null);
  const timelineCommitTimerRef = useRef<number | null>(null);
  const mapViewportRef = useRef<MapViewport>({ center: [137.3, 36.2], zoom: 4.45 });
  const generationAbortRef = useRef<AbortController | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]), [zoom, setZoom] = useState(5);
  const [overviewTiles, setOverviewTiles] = useState<Tile[]>([]), [overviewZoom, setOverviewZoom] = useState(6);
  const [stats, setStats] = useState<Stats | null>(null), [active, setActive] = useState(0);
  const [opacity, setOpacity] = useState(.9), [isPlaying, setIsPlaying] = useState(false), [archiveOpen, setArchiveOpen] = useState(false);
  const [startTime, setStartTime] = useState(""), [endTime, setEndTime] = useState(""), [videoFps, setVideoFps] = useState(6);
  const [message, setMessage] = useState(""), [generating, setGenerating] = useState(false), [generationProgress, setGenerationProgress] = useState(0);
  const [generatedVideo, setGeneratedVideo] = useState<File | null>(null);
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
    generationAbortRef.current?.abort();
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
  const videoFrames = useMemo(() => {
    if (!startTime || !endTime) return [];
    const start = inputToRadar(startTime);
    const end = inputToRadar(endTime);
    if (start > end) return [];
    return frames.filter((frame) => frame.valid_time >= start && frame.valid_time <= end).reverse();
  }, [endTime, frames, startTime]);

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
    setEndTime(toInputValue(frames[0].valid_time));
    setStartTime(toInputValue(frames[Math.min(frames.length - 1, 35)].valid_time));
    setVideoFps(6);
    setGeneratedVideo(null);
    setGenerationProgress(0);
    setArchiveOpen(true);
  };

  const closeVideoDialog = () => {
    generationAbortRef.current?.abort();
    setArchiveOpen(false);
    setGeneratedVideo(null);
  };

  const generateVideo = async () => {
    if (!videoFrames.length) { setMessage("開始時刻と終了時刻を確認してください。"); return; }
    const fps = Math.max(1, Math.min(30, Math.round(videoFps)));
    const controller = new AbortController();
    generationAbortRef.current = controller;
    setGenerating(true);
    setGeneratedVideo(null);
    setGenerationProgress(0);
    setIsPlaying(false);
    setMessage("");
    try {
      const buffer = await createRadarVideo({
        frames: videoFrames,
        fps,
        overviewTiles,
        overviewZoom,
        zoom,
        opacity,
        viewport: mapViewportRef.current,
        signal: controller.signal,
        onProgress: (completed, total) => setGenerationProgress(completed / total),
      });
      if (controller.signal.aborted) return;
      const fileName = `recocast_${videoFrames[0].valid_time.slice(0, 12)}_${videoFrames[videoFrames.length - 1].valid_time.slice(0, 12)}_${fps}fps.mp4`;
      setGeneratedVideo(new File([buffer], fileName, { type: "video/mp4" }));
      setMessage("MP4を生成しました。共有または端末へ保存できます。");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setMessage(error instanceof Error ? error.message : "MP4を生成できませんでした。");
      }
    } finally {
      if (generationAbortRef.current === controller) generationAbortRef.current = null;
      setGenerating(false);
    }
  };

  const downloadGeneratedVideo = () => {
    if (!generatedVideo) return;
    const url = URL.createObjectURL(generatedVideo);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = generatedVideo.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const shareGeneratedVideo = async () => {
    if (!generatedVideo) return;
    if (!navigator.canShare?.({ files: [generatedVideo] }) || !navigator.share) {
      downloadGeneratedVideo();
      setMessage("共有機能がないため、MP4を端末へ保存しました。");
      return;
    }
    try {
      await navigator.share({ files: [generatedVideo], title: "Recocast 雨雲レーダー" });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setMessage("共有メニューを開けませんでした。");
    }
  };

  return <main className="map-shell">
    <section className="fullscreen-map"><JapanMap frame={current} opacity={opacity} tiles={current?.tiles ?? EMPTY_TILES} zoom={zoom} overviewTiles={overviewTiles} overviewZoom={overviewZoom} viewportRef={mapViewportRef} /><div className="map-vignette" /></section>
    <TokyoClock />
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
      </div>
      <label className="opacity-control"><span>雨雲の濃さ</span><input type="range" min="20" max="100" value={opacity * 100} onChange={(event) => setOpacity(Number(event.target.value) / 100)} /><b>{Math.round(opacity * 100)}%</b></label>
    </section>

    {message && <div className="toast" role="status">{message}</div>}
    {archiveOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeVideoDialog()}><section className="archive-panel" role="dialog" aria-modal="true" aria-label="雨雲の流れをMP4にする">
      <button className="close-button" onClick={closeVideoDialog} aria-label="閉じる">×</button><p className="eyebrow">MP4 EXPORT</p><h2>この雨雲の流れを保存</h2><p className="panel-lead">現在の地図範囲を端末内でMP4にします。動画や設定はアプリ内に保存されません。</p>
      <div className="field-grid"><label><span>開始時刻</span><input type="datetime-local" value={startTime} disabled={generating} onChange={(event) => { setStartTime(event.target.value); setGeneratedVideo(null); }} /></label><label><span>終了時刻</span><input type="datetime-local" value={endTime} disabled={generating} onChange={(event) => { setEndTime(event.target.value); setGeneratedVideo(null); }} /></label><label className="speed-field"><span>速さ（枚/秒）</span><input type="number" min="1" max="30" step="1" value={videoFps} disabled={generating} onChange={(event) => { setVideoFps(Number(event.target.value)); setGeneratedVideo(null); }} /><small>6枚/秒なら、30分の雨雲を1秒で再生</small></label></div>
      <div className="video-summary"><span>{videoFrames.length}枚</span><span>動画：約{videoFrames.length ? (videoFrames.length / Math.max(1, videoFps)).toFixed(1) : "0.0"}秒</span><span>1280×720</span></div>
      {generating && <div className="generation-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(generationProgress * 100)}><i style={{ width: `${generationProgress * 100}%` }} /><span>MP4生成中 {Math.round(generationProgress * 100)}%</span></div>}
      {!generatedVideo ? <button className="save-button" disabled={generating || !videoFrames.length || videoFps < 1 || videoFps > 30} onClick={generateVideo}>{generating ? "生成中…" : "MP4を生成"}</button> : <div className="export-actions"><button className="share-button" onClick={shareGeneratedVideo}>共有メニューを開く</button><button className="download-button" onClick={downloadGeneratedVideo}>端末に保存</button><small>{generatedVideo.name}・{formatBytes(generatedVideo.size)}</small></div>}
    </section></div>}
  </main>;
}

