"use client";

import { ChangeEvent, ClipboardEvent, DragEvent, useCallback, useEffect, useRef, useState } from "react";

type Frame = { id: string; observedAt: string; note: string; imageUrl: string; createdAt: string };
type StoredFrame = { id: string; observedAt: string; note: string; image: Blob; createdAt: string };
type GeoGeometry = { type: "Polygon" | "MultiPolygon"; coordinates: number[][][][] | number[][][] };
type GeoFeature = { geometry: GeoGeometry };
type GeoCollection = { features: GeoFeature[] };
const sampleDates = ["10:00", "10:15", "10:30", "10:45", "11:00", "11:15"];

function openArchive() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("recocast-archive", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("frames", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readArchive() {
  const db = await openArchive();
  return new Promise<StoredFrame[]>((resolve, reject) => {
    const request = db.transaction("frames", "readonly").objectStore("frames").getAll();
    request.onsuccess = () => resolve(request.result as StoredFrame[]);
    request.onerror = () => reject(request.error);
  });
}

async function writeArchive(frame: StoredFrame) {
  const db = await openArchive();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("frames", "readwrite");
    transaction.objectStore("frames").put(frame);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function JapanMap({ frame, opacity }: { frame?: Frame; opacity: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [geo, setGeo] = useState<GeoCollection | null>(null);
  useEffect(() => { fetch("https://raw.githubusercontent.com/geolonia/prefecture-tiles/master/prefectures.geojson").then((r) => r.json()).then(setGeo).catch(() => setGeo(null)); }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !geo) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height;
    const ocean = ctx.createRadialGradient(w * .58, h * .42, 20, w * .55, h * .45, w * .82);
    ocean.addColorStop(0, "#173b43"); ocean.addColorStop(.48, "#0b2730"); ocean.addColorStop(1, "#06191f");
    ctx.fillStyle = ocean; ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = .28; ctx.strokeStyle = "#4d8790"; ctx.lineWidth = .45;
    for (let x = -h; x < w + h; x += 42) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + h, h); ctx.stroke(); }
    ctx.globalAlpha = 1;
    const bounds = { minLon: 122.4, maxLon: 153.9, minLat: 23.0, maxLat: 46.1 };
    const project = ([lon, lat]: number[]) => [((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * w, ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * h] as const;
    const traceRing = (ring: number[][]) => { ring.forEach((point, i) => { const [x, y] = project(point); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.closePath(); };
    const land = new Path2D();
    geo.features.forEach(({ geometry }) => {
      const polys = geometry.type === "Polygon" ? [geometry.coordinates as number[][][]] : geometry.coordinates as number[][][][];
      polys.forEach((poly) => poly.forEach((ring) => { ring.forEach((point, i) => { const [x, y] = project(point); if (i === 0) land.moveTo(x, y); else land.lineTo(x, y); }); land.closePath(); }));
    });
    const landGradient = ctx.createLinearGradient(w * .18, 0, w * .85, h);
    landGradient.addColorStop(0, "#375345"); landGradient.addColorStop(.4, "#64715a"); landGradient.addColorStop(.72, "#304c3d"); landGradient.addColorStop(1, "#263f35");
    ctx.fillStyle = landGradient; ctx.fill(land, "evenodd"); ctx.save(); ctx.clip(land, "evenodd");
    for (let i = 0; i < 120; i++) { const x = ((i * 83) % 1000) / 1000 * w, y = ((i * 137) % 997) / 997 * h; ctx.fillStyle = i % 3 ? "rgba(210,205,155,.055)" : "rgba(8,33,27,.12)"; ctx.beginPath(); ctx.ellipse(x, y, 20 + (i % 7) * 9, 5 + (i % 5) * 4, -.6, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore(); ctx.strokeStyle = "rgba(255,255,255,.88)"; ctx.lineWidth = .72;
    geo.features.forEach(({ geometry }) => { const polys = geometry.type === "Polygon" ? [geometry.coordinates as number[][][]] : geometry.coordinates as number[][][][]; polys.forEach((poly) => poly.forEach((ring) => { ctx.beginPath(); traceRing(ring); ctx.stroke(); })); });
    ctx.strokeStyle = "rgba(255,255,255,.26)"; ctx.lineWidth = 5; ctx.stroke(land);
    if (frame) { const img = new Image(); img.onload = () => { ctx.save(); ctx.globalAlpha = opacity; ctx.globalCompositeOperation = "screen"; ctx.drawImage(img, 0, 0, w, h); ctx.restore(); }; img.src = frame.imageUrl; }
  }, [geo, frame, opacity]);
  return <canvas ref={canvasRef} className="map-canvas" aria-label="日本の都道府県境界付き地図" />;
}

export default function Home() {
  const [frames, setFrames] = useState<Frame[]>([]), [active, setActive] = useState(0);
  const [opacity, setOpacity] = useState(.72), [isPlaying, setIsPlaying] = useState(false), [isPanelOpen, setIsPanelOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null), [observedAt, setObservedAt] = useState(new Date().toISOString().slice(0, 16)), [note, setNote] = useState("");
  const [saving, setSaving] = useState(false), [message, setMessage] = useState("");
  const loadFrames = useCallback(async () => { try { const records = await readArchive(); records.sort((a, b) => b.observedAt.localeCompare(a.observedAt)); setFrames((previous) => { previous.forEach((item) => URL.revokeObjectURL(item.imageUrl)); return records.map((item) => ({ id: item.id, observedAt: item.observedAt, note: item.note, createdAt: item.createdAt, imageUrl: URL.createObjectURL(item.image) })); }); } catch { setMessage("このブラウザでは保存機能を利用できません。"); } }, []);
  useEffect(() => { loadFrames(); }, [loadFrames]);
  useEffect(() => { if (!isPlaying || frames.length < 2) return; const timer = window.setInterval(() => setActive((current) => (current + 1) % frames.length), 900); return () => window.clearInterval(timer); }, [isPlaying, frames.length]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "ArrowLeft") setActive((i) => Math.max(0, i - 1)); if (event.key === "ArrowRight") setActive((i) => Math.min(frames.length - 1, i + 1)); if (event.key === " ") { event.preventDefault(); setIsPlaying((value) => !value); } }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [frames.length]);
  const chooseFile = (next?: File | null) => { if (!next) return; if (next.type !== "image/png") { setMessage("PNG画像を選んでください"); return; } setFile(next); setMessage(""); setIsPanelOpen(true); };
  const onPaste = (event: ClipboardEvent) => { const pasted = Array.from(event.clipboardData.files).find((item) => item.type === "image/png"); if (pasted) chooseFile(pasted); };
  const saveFrame = async () => { if (!file) return; setSaving(true); setMessage(""); try { await writeArchive({ id: crypto.randomUUID(), observedAt: new Date(observedAt).toISOString(), note: note.slice(0, 160), image: file, createdAt: new Date().toISOString() }); await loadFrames(); setActive(0); setFile(null); setNote(""); setIsPanelOpen(false); } catch { setMessage("保存できませんでした。もう一度お試しください。"); } finally { setSaving(false); } };
  const current = frames[active];
  return <main className="app-shell" onPaste={onPaste}>
    <header className="topbar"><div className="brand"><span className="brand-mark">R</span><span>Recocast</span></div><div className="header-date">雨雲アーカイブ <span>／ JAPAN</span></div><button className="add-button" onClick={() => setIsPanelOpen(true)}>＋ PNGを追加</button></header>
    <section className="workspace"><div className="map-area"><JapanMap frame={current} opacity={opacity} /><div className="map-head"><div><p className="eyebrow">ARCHIVED RADAR</p><h1>{current ? formatDate(current.observedAt) : "雨雲レーダーを記録する"}</h1></div><div className="live-chip"><i /> 保存済み {frames.length} 枚</div></div>
      {!current && <button className="empty-state" onClick={() => setIsPanelOpen(true)}><span className="drop-icon">＋</span><strong>最初の雨雲PNGを追加</strong><small>クリック、ドラッグ＆ドロップ、または ⌘V / Ctrl+V</small></button>}
      <div className="map-legend"><span>雨量</span><i className="rain-scale" /><span>弱</span><span>強</span></div><div className="map-attribution">境界データ © Geolonia / 国土地理院</div><div className="map-scale">100 km</div></div>
      <aside className="sidebar"><div className="sidebar-title"><div><p className="eyebrow dark">TIMELINE</p><h2>記録</h2></div><span>{frames.length}</span></div><div className="history-list">{frames.length === 0 ? <div className="history-empty"><span>まだ記録がありません</span><small>PNGを追加すると、ここに時系列で並びます。</small></div> : frames.map((frame, index) => <button key={frame.id} className={`history-card ${active === index ? "active" : ""}`} onClick={() => setActive(index)}><img src={frame.imageUrl} alt="" /><span><strong>{formatDate(frame.observedAt)}</strong><small>{frame.note || "メモなし"}</small></span><i /></button>)}</div><div className="storage-note"><span>✓</span><div><strong>このブラウザに保存中</strong><small>画像と観測日時は端末内だけに保管されます。</small></div></div></aside></section>
    <footer className="timeline-bar"><button className="play-button" onClick={() => setIsPlaying((v) => !v)} aria-label={isPlaying ? "停止" : "再生"}>{isPlaying ? "Ⅱ" : "▶"}</button><div className="timeline-track"><div className="timeline-dates"><span>{frames[frames.length - 1] ? formatDate(frames[frames.length - 1].observedAt).split(" ")[0] : "記録なし"}</span><strong>{current ? formatDate(current.observedAt) : "PNGを追加してください"}</strong><span>{frames[0] ? formatDate(frames[0].observedAt).split(" ")[0] : ""}</span></div><input type="range" min="0" max={Math.max(0, frames.length - 1)} value={active} onChange={(e) => setActive(Number(e.target.value))} aria-label="記録を移動" /><div className="tick-row">{sampleDates.map((time) => <span key={time}>{time}</span>)}</div></div><label className="opacity-control"><span>重なり</span><input type="range" min="20" max="100" value={opacity * 100} onChange={(e) => setOpacity(Number(e.target.value) / 100)} /><b>{Math.round(opacity * 100)}%</b></label></footer>
    {isPanelOpen && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setIsPanelOpen(false); }}><section className="upload-panel" role="dialog" aria-modal="true" aria-label="雨雲PNGを追加"><button className="close-button" onClick={() => setIsPanelOpen(false)}>×</button><p className="eyebrow dark">NEW ARCHIVE</p><h2>雨雲PNGを追加</h2><p className="panel-lead">レーダー画像と、その画像が示す観測日時を記録します。</p><label className={`drop-zone ${file ? "has-file" : ""}`} onDragOver={(e: DragEvent) => e.preventDefault()} onDrop={(e: DragEvent) => { e.preventDefault(); chooseFile(e.dataTransfer.files[0]); }}><input type="file" accept="image/png" onChange={(e: ChangeEvent<HTMLInputElement>) => chooseFile(e.target.files?.[0])} /><span className="drop-icon">{file ? "✓" : "＋"}</span><strong>{file ? file.name : "PNGを選択、またはドロップ"}</strong><small>クリップボードから貼り付けることもできます</small></label><div className="field-grid"><label><span>観測日時</span><input type="datetime-local" value={observedAt} onChange={(e) => setObservedAt(e.target.value)} /></label><label><span>メモ（任意）</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：関東で強い雨" /></label></div>{message && <p className="error-message">{message}</p>}<button className="save-button" disabled={!file || saving} onClick={saveFrame}>{saving ? "保存中…" : "アーカイブに保存"}</button></section></div>}
  </main>;
}

