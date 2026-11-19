import { haversine, type LatLng } from "../geo";
import { LIMITS, SERVICE_AREA, ImportStop, inServiceArea, round6 } from "./types";

export type NominatimItem = {
  lat: string;
  lon: string;
  display_name?: string;
  importance?: number;
  class?: string;
  category?: string;
  type?: string;
  addresstype?: string;
};

export type GeocodeOutcome = {
  status: "ok" | "incerto" | "nenhum";
  lat?: number;
  lng?: number;
  note: string;
};

export function buildQuery(name: string): string {
  const clean = name.replace(/\s*\|.*$/, "").replace(/\s+/g, " ").trim();
  return `${clean}, Macapá, Amapá, Brasil`;
}

const VAGUE = new Set(["city", "town", "village", "suburb", "neighbourhood", "quarter", "state", "county", "municipality", "region", "district"]);

/** Heurística: resultado único, em endereço/POI, dentro da área → "ok" (estimada). Caso contrário → "incerto". */
export function classifyResults(items: NominatimItem[]): GeocodeOutcome {
  const valid = items
    .map((it) => ({ it, lat: Number(it.lat), lng: Number(it.lon) }))
    .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng) && inServiceArea(x.lat, x.lng));
  if (valid.length === 0) return { status: "nenhum", note: "Nenhum resultado dentro da área de serviço." };
  const first = valid[0]!;
  const reasons: string[] = [];
  const cls = first.it.class ?? first.it.category ?? "";
  const type = first.it.type ?? "";
  if (cls === "highway" && !/\d/.test(first.it.display_name?.split(",")[0] ?? ""))
    reasons.push("o resultado é uma via inteira, sem número exato");
  if (cls === "place" && VAGUE.has(type)) reasons.push("o resultado é um bairro/cidade, não um ponto");
  const far = valid.slice(1).filter((x) => haversine([first.lat, first.lng], [x.lat, x.lng]) > 300);
  if (far.length > 0) reasons.push(`há ${far.length} outro(s) resultado(s) a mais de 300 m`);
  const note = `Geocodificado como: ${first.it.display_name ?? "?"}`;
  const base = { lat: round6(first.lat), lng: round6(first.lng) };
  if (reasons.length > 0) return { status: "incerto", ...base, note: `${note} (incerto: ${reasons.join("; ")})` };
  return { status: "ok", ...base, note };
}

export async function geocodeOne(
  name: string,
  opts: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GeocodeOutcome> {
  const f = opts.fetchFn ?? fetch;
  const { latMin, latMax, lngMin, lngMax } = SERVICE_AREA;
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&countrycodes=br&bounded=1" +
    `&viewbox=${lngMin},${latMax},${lngMax},${latMin}&accept-language=pt-BR&q=${encodeURIComponent(buildQuery(name))}`;
  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (opts.signal) init.signal = opts.signal;
  const res = await f(url, init);
  if (!res.ok) throw new Error(`Nominatim respondeu ${res.status}`);
  const json = (await res.json()) as unknown;
  if (!Array.isArray(json)) throw new Error("Resposta inesperada do Nominatim");
  return classifyResults(json as NominatimItem[]);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Geocodifica as paradas sem coordenada (ou incertas), no máximo 1 consulta por segundo
 * e LIMITS.geocodePerRun por execução, conforme a política de uso do Nominatim.
 */
export async function geocodeStops(
  stops: ImportStop[],
  opts: {
    ids?: string[];
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    delayMs?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<{ stops: ImportStop[]; found: number; uncertain: number; missing: number; errors: number; skipped: number }> {
  const want = opts.ids ? new Set(opts.ids) : null;
  const todo = stops.filter((s) =>
    want ? want.has(s.id) : s.coord === "ausente" && s.name.trim() !== "",
  );
  const batch = todo.slice(0, LIMITS.geocodePerRun);
  const result = new Map<string, GeocodeOutcome>();
  let errors = 0;
  let done = 0;
  for (const s of batch) {
    if (opts.signal?.aborted) break;
    try {
      const gopts: { fetchFn?: typeof fetch; signal?: AbortSignal } = {};
      if (opts.fetchFn) gopts.fetchFn = opts.fetchFn;
      if (opts.signal) gopts.signal = opts.signal;
      result.set(s.id, await geocodeOne(s.name, gopts));
    } catch {
      errors++;
    }
    done++;
    opts.onProgress?.(done, batch.length);
    if (done < batch.length) await sleep(opts.delayMs ?? 1100);
  }
  let found = 0;
  let uncertain = 0;
  let missing = 0;
  const out = stops.map((s): ImportStop => {
    const r = result.get(s.id);
    if (!r) return s;
    if (r.status === "nenhum" || r.lat === undefined || r.lng === undefined) {
      missing++;
      return { ...s, note: r.note };
    }
    if (r.status === "incerto") uncertain++;
    else found++;
    return {
      ...s,
      lat: r.lat,
      lng: r.lng,
      coord: r.status === "ok" ? "geocodificada" : "geocodificada_incerta",
      note: r.note,
    };
  });
  return { stops: out, found, uncertain, missing, errors, skipped: Math.max(0, todo.length - batch.length) };
}

export type { LatLng };
