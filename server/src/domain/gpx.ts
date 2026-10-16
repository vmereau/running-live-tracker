// Minimal GPX reader (no XML dependency): extracts the points of the first track,
// or of the first route when that track has none. Pure; reused by Story 3.3.

export type GpxPoint = { lat: number; lon: number; altitudeM?: number };

const ATTRIBUTE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Points of every `trkseg` of the first `trk`, in file order; if it has none, the
 * `rtept`s of the first `rte`; `[]` when neither exists. `<ele>` becomes `altitudeM`.
 * Throws an Error naming the point on a missing, non-numeric or out-of-range lat/lon.
 */
export function parseGpx(xml: string): GpxPoint[] {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  const trk = firstElementBody(text, 'trk');
  if (trk !== undefined) {
    const points = readPoints(trk, 'trkpt');
    if (points.length > 0) return points;
  }
  const rte = firstElementBody(text, 'rte');
  return rte === undefined ? [] : readPoints(rte, 'rtept');
}

/** Inner text of the first `<name …>…</name>` element (undefined if absent or self-closing). */
function firstElementBody(text: string, name: string): string | undefined {
  const open = new RegExp(`<${name}(?=[\\s>/])[^>]*>`).exec(text);
  if (open === null || open[0].endsWith('/>')) return undefined;
  const start = open.index + open[0].length;
  const end = text.indexOf(`</${name}>`, start);
  return text.slice(start, end < 0 ? text.length : end);
}

function readPoints(body: string, name: 'trkpt' | 'rtept'): GpxPoint[] {
  const points: GpxPoint[] = [];
  const tag = new RegExp(`<${name}(?=[\\s>/])([^>]*?)(/?)>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = tag.exec(body)) !== null) {
    const label = `GPX ${name} #${points.length + 1}`;
    const attrs = new Map<string, string>();
    for (const a of m[1]!.matchAll(ATTRIBUTE)) attrs.set(a[1]!, a[2] ?? a[3]!);
    const point: GpxPoint = {
      lat: coordinate(attrs.get('lat'), 'lat', 90, label),
      lon: coordinate(attrs.get('lon'), 'lon', 180, label),
    };
    if (m[2] !== '/') {
      const close = body.indexOf(`</${name}>`, tag.lastIndex);
      const inner = body.slice(tag.lastIndex, close < 0 ? body.length : close);
      const ele = /<ele(?:\s[^>]*)?>([^<]*)<\/ele>/.exec(inner)?.[1]?.trim();
      if (ele !== undefined && ele !== '' && Number.isFinite(Number(ele))) point.altitudeM = Number(ele);
      if (close >= 0) tag.lastIndex = close;
    }
    points.push(point);
  }
  return points;
}

function coordinate(raw: string | undefined, attr: 'lat' | 'lon', limit: number, label: string): number {
  if (raw === undefined) throw new Error(`${label}: missing ${attr}`);
  const value = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${label}: ${attr} "${raw}" is not a number`);
  if (value < -limit || value > limit) throw new Error(`${label}: ${attr} ${value} is out of range [-${limit}, ${limit}]`);
  return value;
}
