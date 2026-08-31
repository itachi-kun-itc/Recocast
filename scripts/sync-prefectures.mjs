import { mkdir, writeFile } from "node:fs/promises";

const source = "https://raw.githubusercontent.com/wvdtc7bjwn-bit/MeteoScope/main/public/data/japan-prefectures-map.geojson";
const destination = new URL("../public/data/japan-prefectures-map.geojson", import.meta.url);
const tolerance = 0.015;

function squaredSegmentDistance(point, start, end) {
  let x = start[0];
  let y = start[1];
  let dx = end[0] - x;
  let dy = end[1] - y;
  if (dx || dy) {
    const t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = end[0]; y = end[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = point[0] - x;
  dy = point[1] - y;
  return dx * dx + dy * dy;
}

function simplifyLine(points, toleranceSquared) {
  if (points.length <= 2) return points;
  let maxDistance = toleranceSquared;
  let split = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = squaredSegmentDistance(points[index], points[0], points.at(-1));
    if (distance > maxDistance) { split = index; maxDistance = distance; }
  }
  if (!split) return [points[0], points.at(-1)];
  return [...simplifyLine(points.slice(0, split + 1), toleranceSquared).slice(0, -1), ...simplifyLine(points.slice(split), toleranceSquared)];
}

function simplifyRing(ring) {
  if (ring.length <= 5) return ring;
  const points = ring.slice(0, -1);
  let opposite = 1;
  let farthest = 0;
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index][0] - points[0][0];
    const dy = points[index][1] - points[0][1];
    const distance = dx * dx + dy * dy;
    if (distance > farthest) { opposite = index; farthest = distance; }
  }
  const firstHalf = simplifyLine(points.slice(0, opposite + 1), tolerance * tolerance);
  const secondHalf = simplifyLine([...points.slice(opposite), points[0]], tolerance * tolerance);
  const simplified = [...firstHalf.slice(0, -1), ...secondHalf];
  return simplified.length >= 4 ? simplified : ring;
}

function simplifyGeometry(geometry) {
  const simplifyPolygon = (polygon) => polygon.map(simplifyRing);
  return {
    ...geometry,
    coordinates: geometry.type === "Polygon"
      ? simplifyPolygon(geometry.coordinates)
      : geometry.coordinates.map(simplifyPolygon),
  };
}
const response = await fetch(source, { headers: { "user-agent": "Recocast data sync" } });
if (!response.ok) throw new Error(`Prefecture GeoJSON download failed: ${response.status}`);

const collection = await response.json();
if (collection?.type !== "FeatureCollection" || collection.features?.length !== 47) {
  throw new Error("Expected a 47-feature prefecture FeatureCollection");
}

const simplified = {
  type: "FeatureCollection",
  features: collection.features.map((feature) => ({
    type: "Feature",
    properties: feature.properties,
    geometry: simplifyGeometry(feature.geometry),
  })),
};
const text = JSON.stringify(simplified);

await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await writeFile(destination, text, "utf8");
console.log(`Saved 47 prefectures (${Buffer.byteLength(text)} bytes)`);
