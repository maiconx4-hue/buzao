import { pathLength, type LatLng } from "../geo";
import { ImportError, Segment, round6 } from "./types";
import { decimate } from "./geojson";
import { LIMITS } from "./types";

export type RouteResult = {
  geometry: LatLng[];
  segments: Segment[];
  /** Distância (m) de cada parada até a via mais próxima segundo o roteador (alinhado às paradas). */
  snapDistances: number[];
  distance_m: number;
};

export function chunkWaypoints<T>(points: T[], size = 25): { from: number; items: T[] }[] {
  const out: { from: number; items: T[] }[] = [];
  for (let i = 0; i < points.length - 1; i += size - 1) {
    out.push({ from: i, items: points.slice(i, Math.min(points.length, i + size)) });
    if (i + size >= points.length) break;
  }
  return out;
}

export function parseOsrmResponse(json: unknown): { geometry: LatLng[]; snap: number[] } {
  const j = json as {
    code?: string;
    routes?: { geometry?: { coordinates?: unknown } }[];
    waypoints?: { distance?: number }[];
  };
  const coords = j?.routes?.[0]?.geometry?.coordinates;
  if (j?.code && j.code !== "Ok") throw new ImportError(`OSRM: ${j.code}`);
  if (!Array.isArray(coords) || coords.length === 0) throw new ImportError("OSRM não devolveu trajeto.");
  const geometry: LatLng[] = [];
  for (const c of coords as unknown[]) {
    if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number")
      throw new ImportError("Resposta inválida do OSRM.");
    geometry.push([round6(c[1] as number), round6(c[0] as number)]);
  }
  const snap = (j.waypoints ?? []).map((w) => (typeof w?.distance === "number" ? w.distance : 0));
  return { geometry, snap };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sugere o traçado pelas vias passando pelas paradas, na ordem. É uma SUGESTÃO do roteador
 * (perfil de carro do OSRM público), não o itinerário oficial. Falhas lançam ImportError;
 * nada é inventado em silêncio.
 */
export async function routeThroughStops(
  points: LatLng[],
  opts: {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    chunkSize?: number;
    delayMs?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<RouteResult> {
  if (points.length < 2) throw new ImportError("São necessárias pelo menos 2 paradas com coordenadas.");
  const f = opts.fetchFn ?? fetch;
  const chunks = chunkWaypoints(points, opts.chunkSize ?? 25);
  const geometry: LatLng[] = [];
  const segments: Segment[] = [];
  const snapDistances: number[] = new Array<number>(points.length).fill(0);
  let done = 0;
  for (const ch of chunks) {
    if (opts.signal?.aborted) throw new ImportError("Cálculo cancelado.");
    const coords = ch.items.map((p) => `${p[1]},${p[0]}`).join(";");
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=false`;
    let parsed: { geometry: LatLng[]; snap: number[] } | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const init: RequestInit = {};
        if (opts.signal) init.signal = opts.signal;
        const res = await f(url, init);
        if (!res.ok) throw new ImportError(`OSRM respondeu ${res.status}`);
        parsed = parseOsrmResponse(await res.json());
      } catch (e) {
        lastErr = e instanceof Error ? e.message : "erro de rede";
        if (attempt === 0) await sleep(opts.delayMs ?? 1000);
      }
    }
    if (!parsed)
      throw new ImportError(
        `Roteamento indisponível nas paradas ${ch.from + 1}–${ch.from + ch.items.length} (${lastErr}). Tente de novo, ligue as paradas em linha reta (provisório) ou ajuste no editor.`,
      );
    const start = geometry.length === 0 ? 0 : geometry.length - 1;
    for (const p of parsed.geometry) {
      const last = geometry[geometry.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) geometry.push(p);
    }
    segments.push({ start, end: geometry.length - 1, kind: "osrm" });
    parsed.snap.forEach((d, i) => {
      snapDistances[ch.from + i] = Math.max(snapDistances[ch.from + i] ?? 0, d);
    });
    done++;
    opts.onProgress?.(done, chunks.length);
    if (done < chunks.length) await sleep(opts.delayMs ?? 300);
  }
  const g = geometry.length > LIMITS.geometryPoints ? decimate(geometry, LIMITS.geometryPoints) : geometry;
  if (g !== geometry) {
    // simplificação: segmentos viram um só trecho calculado
    return { geometry: g, segments: [{ start: 0, end: g.length - 1, kind: "osrm" }], snapDistances, distance_m: pathLength(g) };
  }
  return { geometry, segments, snapDistances, distance_m: pathLength(geometry) };
}

/** Provisório e explícito: liga as paradas em linha reta. Nunca é usado automaticamente. */
export function straightLine(points: LatLng[]): RouteResult {
  if (points.length < 2) throw new ImportError("São necessárias pelo menos 2 paradas com coordenadas.");
  return {
    geometry: points.map((p) => [p[0], p[1]] as LatLng),
    segments: [{ start: 0, end: points.length - 1, kind: "reta" }],
    snapDistances: points.map(() => 0),
    distance_m: pathLength(points),
  };
}
