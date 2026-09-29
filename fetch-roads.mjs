#!/usr/bin/env node
// Pulls Iowa 511 crashes, closures, construction and winter road conditions
// from the Iowa DOT's public data feeds and writes roads.json for the website.
// The feeds need no key or account. Runs in GitHub Actions (see roads.yml).

import { readFileSync, writeFileSync } from 'node:fs';

const OUT = 'roads.json';
const TZ = 'America/Chicago';
const EVENTS_ITEM = '5e924db11ba94ce4bda1b38dfe0cdcdf'; // 511 Traveler Information Events - Iowa
const WINTER_ITEM = '181770a5c1bf498797245c13afffa155'; // Iowa Winter Road Conditions
const ITEMS_BASE = process.env.ARCGIS_ITEMS || 'https://www.arcgis.com/sharing/rest/content/items/';
const EVENTS_URL = process.env.EVENTS_URL || ''; // optional: paste a FeatureServer layer URL to skip the lookup
const WINTER_URL = process.env.WINTER_URL || '';
const BBOX = [-95.5, 42.45, -94.85, 43.3]; // west, south, east, north: covers Spencer to Storm Lake

// ===== EDIT THIS SECTION =====
// path = [lat, lon] points. One point means "everything within `miles` of it".
// Several points draw a line, and everything within `miles` of the line counts.
// Events that mention Highway 71 by name count out to roadMiles.
const CORRIDORS = [
  { name: 'Spencer area', miles: 6, path: [[43.1414, -95.1444]] },
  {
    name: 'Highway 71', miles: 4,
    path: [[43.1414, -95.1444], [42.89, -95.17], [42.6411, -95.2097]],
    roadPattern: /\b(?:US|U\.S\.|HWY|HIGHWAY)\s*-?\s*71\b/i, roadMiles: 12
  }
];
// ===== END EDIT SECTION =====

/* ---------- geometry (flat-earth math is plenty at this scale) ---------- */
const KX = 69.17 * Math.cos((43 * Math.PI) / 180), KY = 69.0; // miles per degree
const xy = ([lat, lon]) => [(lon + 95) * KX, (lat - 43) * KY];

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function pathDist(p, path) {
  if (path.length === 1) return Math.hypot(p[0] - path[0][0], p[1] - path[0][1]);
  let m = Infinity;
  for (let i = 0; i < path.length - 1; i++) m = Math.min(m, segDist(p, path[i], path[i + 1]));
  return m;
}
function densify(line, step = 0.25) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    out.push(line[i]);
    if (i < line.length - 1) {
      const a = line[i], b = line[i + 1], n = Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
      for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / (n + 1), a[1] + ((b[1] - a[1]) * k) / (n + 1)]);
    }
  }
  return out;
}
function geomLines(g) {
  if (!g || !g.coordinates) return [];
  const c = g.coordinates;
  switch (g.type) {
    case 'Point': return [[c]];
    case 'MultiPoint': return c.map((p) => [p]);
    case 'LineString': return [c];
    case 'MultiLineString': return c;
    case 'Polygon': return c;
    case 'MultiPolygon': return c.flat();
    default: return [];
  }
}
function featureDist(geom, path) {
  let m = Infinity;
  for (const line of geomLines(geom)) {
    const pts = densify(line.map(([lon, lat]) => xy([lat, lon])));
    for (const p of pts) m = Math.min(m, pathDist(p, path));
  }
  return m;
}
const corridors = CORRIDORS.map((c) => ({ ...c, xyPath: c.path.map(xy) }));

/* ---------- fetching ---------- */
async function getJSON(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'family-drive-forecast', accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} from ${url.split('?')[0]}`);
  const j = await r.json();
  if (j && j.error) throw new Error(`Service error from ${url.split('?')[0]}: ${JSON.stringify(j.error)}`);
  return j;
}
async function serviceUrl(itemId, override) {
  if (override) return override.replace(/\/query.*$/, '').replace(/\/$/, '');
  const j = await getJSON(`${ITEMS_BASE}${itemId}?f=json`);
  if (!j.url) throw new Error(`Item ${itemId} has no service URL`);
  let url = j.url.replace(/\/$/, '');
  if (!/\/\d+$/.test(url)) url += '/0';
  return url;
}
function fromEsri(f) {
  const g = f.geometry || {};
  let geometry = null;
  if (g.paths) geometry = { type: 'MultiLineString', coordinates: g.paths };
  else if (g.x != null) geometry = { type: 'Point', coordinates: [g.x, g.y] };
  return { properties: f.attributes || {}, geometry };
}
async function queryLayer(base) {
  const common = {
    where: '1=1', outFields: '*', outSR: '4326', inSR: '4326',
    geometry: BBOX.join(','), geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects',
    resultRecordCount: '2000'
  };
  try {
    const j = await getJSON(`${base}/query?${new URLSearchParams({ ...common, f: 'geojson' })}`);
    if (Array.isArray(j.features)) return j.features;
  } catch (e) {
    console.warn('GeoJSON query failed, trying plain JSON:', e.message);
  }
  const j = await getJSON(`${base}/query?${new URLSearchParams({ ...common, f: 'json' })}`);
  if (!Array.isArray(j.features)) throw new Error('No features array in response');
  return j.features.map(fromEsri);
}

/* ---------- reading attributes (field names are matched loosely) ---------- */
const clean = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function pick(props, re) {
  for (const [k, v] of Object.entries(props)) if (re.test(k) && typeof v === 'string' && clean(v)) return clean(v);
  return '';
}
function asTime(v) {
  if (typeof v === 'number' && v > 1e11) return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}
function pickTime(props, re) {
  for (const [k, v] of Object.entries(props)) if (re.test(k)) { const t = asTime(v); if (t) return t; }
  return null;
}
const day = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(new Date(ms));
const clip = (s, n = 220) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// The feed often repeats a road label ("US 71:") and a "Starts Monday April 06." lead-in inside the
// description, and sometimes only on one of two copies of the same project. Strip both so copies match.
function tidy(d) {
  let prev;
  do {
    prev = d;
    d = d.replace(/^starts\s+\w+\s+\w+\s+\d{1,2}\.?\s*/i, '').replace(/^[A-Za-z.]{1,4}[\s-]?\d{1,3}\s*:\s*/, '');
  } while (d !== prev);
  return d.trim();
}

function kindOf(type, desc) {
  const all = `${type} ${desc}`;
  const closed = /road (is )?closed|closed to (all )?traffic|full closure|detour|impassable/i.test(all);
  if (/accident|incident|crash/i.test(type)) return { kind: 'Crash or incident', rank: 0 };
  if (/construct|road ?work|maint/i.test(type)) return closed ? { kind: 'Road closure', rank: 1 } : { kind: 'Construction', rank: 3 };
  if (/crash|accident|collision|overturn|jackknif|spill|disabled|stalled|debris/i.test(all)) return { kind: 'Crash or incident', rank: 0 };
  if (closed) return { kind: 'Road closure', rank: 1 };
  if (/(lane|shoulder).{0,25}(closed|closure|restrict)|(closed|closure).{0,25}(lane|shoulder)/i.test(all)) return { kind: 'Lane or shoulder closed', rank: 2.5 };
  if (/weather|snow|\bice\b|icy|fog|flood|wind/i.test(all)) return { kind: 'Weather', rank: 2 };
  if (/construct|road ?work|maint|resurfac|paving|bridge|work zone|repair/i.test(all)) return { kind: 'Construction', rank: 3 };
  return { kind: 'Traffic event', rank: 4 };
}

function matchCorridors(geom, roadText) {
  const hit = [];
  for (const c of corridors) {
    const d = featureDist(geom, c.xyPath);
    if (d <= c.miles || (c.roadPattern && c.roadPattern.test(roadText) && d <= c.roadMiles)) hit.push(c.name);
  }
  return hit;
}

/* ---------- build items ---------- */
function eventItems(features, now) {
  const items = [];
  for (const f of features) {
    const p = f.properties || {};
    const type = pick(p, /^(event_?type|type|category|event_?category)$/i);
    const sub = pick(p, /^(event_?sub_?type|sub_?type)$/i);
    let desc = pick(p, /^(description|event_?description|desc|message|headline|summary|comments?)$/i) || pick(p, /descr/i);
    if (!desc) {
      desc = Object.entries(p)
        .filter(([k, v]) => typeof v === 'string' && v.length > 3 && !/(^|_)(id|guid|url|link|image|icon|uuid)/i.test(k))
        .slice(0, 3).map(([, v]) => clean(v)).join('. ');
    }
    const road = pick(p, /^(road|roadway|road_?name|roadway_?name|route|route_?name|highway|location)$/i);
    const start = pickTime(p, /start|begin/i), end = pickTime(p, /(^|_)(end|expire|finish|estimated)/i);
    if (end && end < now) continue;
    if (start && start > now + 7 * 864e5) continue;
    const routes = matchCorridors(f.geometry, `${road} ${desc}`);
    if (!routes.length) continue;
    desc = tidy(desc) || type || 'Traffic event';
    const { kind, rank } = kindOf(`${type} ${sub}`, desc);
    const num = (road.match(/\d+/) || [''])[0];
    const named = road && (desc.toLowerCase().includes(road.toLowerCase()) || (num && new RegExp(`\\b${num}\\b`).test(desc)));
    let text = road && !named ? `${road}: ${desc}` : desc;
    if (!/[.!?]$/.test(text)) text += '.';
    if (start && start > now) text += ` Starts ${day(start)}.`;
    if (end && kind !== 'Crash or incident') text += ` Until ${day(end)}.`;
    items.push({
      kind, route: routes.join(' and '), text: clip(text), rank,
      key: `${kind}|${routes.join('+')}|${num || road.toLowerCase()}|${desc.toLowerCase().replace(/[^a-z0-9]/g, '')}|${end ? day(end) : ''}`
    });
  }
  return items;
}

const WINTER_BAD = /(partly|mostly|completely|fully)\s+covered|snow|slush|\bice\b|icy|slippery|frost|drift|blowing|travel not advised|impassable|closed|hazard/i;
const WINTER_OK = /^(dry|clear|normal|no (reported )?(adverse|issues?)|seasonal)/i;
function winterItems(features) {
  const groups = new Map();
  for (const f of features) {
    const p = f.properties || {};
    const cond = pick(p, /condition|status|surface/i) || pick(p, /descr/i);
    if (!cond || WINTER_OK.test(cond) || !WINTER_BAD.test(cond)) continue;
    const road = pick(p, /^(road|roadway|road_?name|roadway_?name|route|route_?name|highway)$/i);
    for (const name of matchCorridors(f.geometry, road)) {
      const g = groups.get(name) || { conds: new Set(), roads: new Set(), n: 0 };
      g.conds.add(cond); if (road) g.roads.add(road); g.n++;
      groups.set(name, g);
    }
  }
  return [...groups].map(([route, g]) => ({
    kind: 'Winter road conditions', route, rank: 2,
    text: clip(`${[...g.conds].slice(0, 3).join(', ')}${g.roads.size ? ` on ${[...g.roads].slice(0, 3).join(', ')}` : ''} (${g.n} road segment${g.n === 1 ? '' : 's'}).`)
  }));
}

/* ---------- main ---------- */
async function main() {
  const warnings = [];
  const now = Date.now();

  const eventsBase = await serviceUrl(EVENTS_ITEM, EVENTS_URL);
  const eventFeatures = await queryLayer(eventsBase); // if this fails, the run fails and the old roads.json stays
  console.log(`Events: ${eventFeatures.length} features in the area.`);
  if (eventFeatures[0]) console.log('Event fields:', Object.keys(eventFeatures[0].properties || {}).join(', '));
  let items = eventItems(eventFeatures, now);

  try {
    const winterBase = await serviceUrl(WINTER_ITEM, WINTER_URL);
    const winterFeatures = await queryLayer(winterBase);
    console.log(`Winter conditions: ${winterFeatures.length} features in the area.`);
    if (winterFeatures[0]) console.log('Winter fields:', Object.keys(winterFeatures[0].properties || {}).join(', '));
    items = items.concat(winterItems(winterFeatures));
  } catch (e) {
    console.warn('Winter road conditions unavailable:', e.message);
    warnings.push('Winter road conditions were unavailable on the last update.');
  }

  // Merge duplicates, then keep crashes, closures and weather on top. Long-running
  // construction is capped at 3 per route, with a summary line for the rest.
  const seen = new Set();
  items = items.filter((i) => { const k = i.key || `${i.kind}|${i.route}|${i.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const others = items.filter((i) => i.rank !== 3);
  const byRoute = new Map();
  for (const i of items.filter((x) => x.rank === 3)) byRoute.set(i.route, [...(byRoute.get(i.route) || []), i]);
  const impact = (i) => (/lane|clos|flagger|restrict|narrow|width|detour|delay|one-way/i.test(i.text) ? 0 : 1);
  const construction = [];
  for (const [route, list] of byRoute) {
    list.sort((a, b) => impact(a) - impact(b));
    construction.push(...list.slice(0, 3));
    if (list.length > 3) {
      construction.push({ kind: 'Construction', route, rank: 3, text: `${list.length - 3} more long-running road project${list.length - 3 === 1 ? '' : 's'}. Check the Iowa 511 map for lane closures.` });
    }
  }
  items = [...others, ...construction]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 20)
    .map(({ kind, route, text }) => ({ kind, route, text }));

  let prev = null;
  try { prev = JSON.parse(readFileSync(OUT, 'utf8')); } catch { /* first run */ }
  const same = prev && JSON.stringify(prev.items) === JSON.stringify(items) && JSON.stringify(prev.warnings || []) === JSON.stringify(warnings);
  const fresh = prev && Date.now() - Date.parse(prev.updatedAt) < 60 * 60000;
  if (same && fresh) { console.log(`No change. ${items.length} item(s).`); return; }

  writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), source: 'Iowa DOT 511', warnings, items }, null, 1) + '\n');
  console.log(`Wrote ${OUT} with ${items.length} item(s).`);
}

main().catch((e) => { console.error('Road update failed:', e.message); process.exit(1); });
