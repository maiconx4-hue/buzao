import type { LatLng } from "../geo";
import { parseNumber } from "./mapping";
import {
  GeoImport,
  ImportError,
  ImportStop,
  LIMITS,
  RowIssue,
  isValidCoord,
  newId,
  parseDirection,
  round6,
} from "./types";

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

export function decimate(points: LatLng[], max: number): LatLng[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % step === 0);
  const last = points[points.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function pick(props: Record<string, Json>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = props[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function coordPair(c: Json): LatLng | null {
  if (!Array.isArray(c) || c.length < 2) return null;
  const lng = c[0];
  const lat = c[1];
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return isValidCoord(lat, lng) ? [round6(lat), round6(lng)] : null;
}

function dedupe(points: LatLng[]): LatLng[] {
  return points.filter((p, i) => i === 0 || p[0] !== points[i - 1]![0] || p[1] !== points[i - 1]![1]);
}

/** Aceita FeatureCollection/Feature/geometria solta: Point = parada, LineString/MultiLineString = traçado. */
export function parseGeoJson(text: string): GeoImport {
  let doc: Json;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new ImportError("O arquivo não é um JSON/GeoJSON válido.");
  }
  if (!isObj(doc) || typeof doc["type"] !== "string") throw new ImportError("GeoJSON inválido: falta o campo \"type\".");

  const issues: RowIssue[] = [];
  const features: { geom: Json; props: Record<string, Json> }[] = [];
  const collect = (node: Json) => {
    if (!isObj(node)) return;
    const t = node["type"];
    if (t === "FeatureCollection" && Array.isArray(node["features"])) {
      (node["features"] as Json[]).forEach(collect);
    } else if (t === "Feature") {
      features.push({ geom: node["geometry"], props: isObj(node["properties"]) ? node["properties"] : {} });
    } else if (t === "GeometryCollection" && Array.isArray(node["geometries"])) {
      (node["geometries"] as Json[]).forEach((g) => features.push({ geom: g, props: {} }));
    } else if (typeof t === "string") {
      features.push({ geom: node, props: {} });
    }
  };
  collect(doc);
  if (features.length === 0) throw new ImportError("O GeoJSON não tem nenhuma feição.");

  const stops: { stop: ImportStop; seq: number | null }[] = [];
  const lines: LatLng[][] = [];
  let skipped = 0;
  features.forEach((f, idx) => {
    const g = f.geom;
    if (!isObj(g)) return;
    const gt = g["type"];
    const row = idx + 1;
    if (gt === "Point") {
      const p = coordPair(g["coordinates"]);
      const name = pick(f.props, ["name", "stop_name", "nome", "parada", "title", "label"]);
      const seqRaw = pick(f.props, ["sequence", "stop_sequence", "seq", "sequencia", "ordem", "order", "index"]);
      const seqNum = seqRaw === undefined ? null : parseNumber(seqRaw);
      if (!p) {
        issues.push({ row, field: "coordenadas", level: "erro", message: `Feição ${row}: coordenadas do ponto inválidas.` });
      }
      stops.push({
        stop: {
          id: newId(),
          seq: 0,
          name: name ?? "",
          lat: p ? p[0] : null,
          lng: p ? p[1] : null,
          coord: p ? "fonte" : "ausente",
          row,
        },
        seq: seqNum,
      });
      if (!name) issues.push({ row, field: "nome", level: "erro", message: `Feição ${row}: ponto sem nome (use a propriedade "name").` });
    } else if (gt === "LineString" || gt === "MultiLineString") {
      const arrs = gt === "LineString" ? [g["coordinates"]] : Array.isArray(g["coordinates"]) ? (g["coordinates"] as Json[]) : [];
      const pts: LatLng[] = [];
      for (const a of arrs) {
        if (!Array.isArray(a)) continue;
        for (const c of a as Json[]) {
          const p = coordPair(c);
          if (p) pts.push(p);
          else skipped++;
        }
      }
      if (pts.length >= 2) lines.push(dedupe(pts));
    } else if (gt !== "Point") {
      issues.push({ row, field: "tipo", level: "info", message: `Feição ${row}: tipo ${String(gt)} ignorado.` });
    }
  });
  if (skipped > 0)
    issues.push({ row: null, field: "traçado", level: "aviso", message: `${skipped} coordenada(s) inválida(s) do traçado foram ignoradas.` });

  const allSeq = stops.length > 0 && stops.every((s) => s.seq !== null);
  if (allSeq) stops.sort((a, b) => (a.seq as number) - (b.seq as number));
  else if (stops.some((s) => s.seq !== null))
    issues.push({ row: null, field: "sequência", level: "aviso", message: "Sequência incompleta nos pontos; usando a ordem do arquivo." });
  else if (stops.length > 1)
    issues.push({ row: null, field: "sequência", level: "info", message: "Os pontos não têm sequência; usando a ordem do arquivo." });
  const outStops = stops.map((s, i) => ({ ...s.stop, seq: i + 1 }));
  if (outStops.length > LIMITS.stops)
    issues.push({ row: null, field: "paradas", level: "erro", message: `O arquivo tem ${outStops.length} paradas; o limite é ${LIMITS.stops}.` });

  let geometry: LatLng[] = [];
  if (lines.length === 1) geometry = lines[0]!;
  else if (lines.length > 1) {
    geometry = dedupe(lines.flat());
    issues.push({ row: null, field: "traçado", level: "aviso", message: `O arquivo tem ${lines.length} linhas; elas foram unidas na ordem do arquivo. Confira o traçado.` });
  }
  if (geometry.length > LIMITS.geometryPoints) {
    issues.push({ row: null, field: "traçado", level: "aviso", message: `O traçado tinha ${geometry.length} pontos e foi simplificado para até ${LIMITS.geometryPoints}.` });
    geometry = decimate(geometry, LIMITS.geometryPoints);
  }
  if (outStops.length === 0 && geometry.length === 0)
    throw new ImportError("O GeoJSON não tem pontos (paradas) nem linhas (traçado) utilizáveis.");
  if (outStops.length === 0)
    issues.push({ row: null, field: "paradas", level: "aviso", message: "O arquivo só tem o traçado, sem paradas." });

  // Metadados opcionais (propriedades do documento ou da primeira linha)
  const topProps = isObj(doc["properties"]) ? doc["properties"] : {};
  const lineProps = features.find((f) => isObj(f.geom) && /LineString/.test(String(f.geom["type"])))?.props ?? {};
  const merged = { ...topProps, ...lineProps };
  const dirRaw = pick(merged, ["direction", "sentido", "direction_id"]);
  return {
    stops: outStops,
    geometry,
    issues,
    meta: {
      code: pick(merged, ["code", "codigo", "linha", "route_short_name", "line"]),
      name: pick(merged, ["name", "nome", "route_long_name", "itinerario"]),
      direction: dirRaw ? (parseDirection(dirRaw) ?? undefined) : undefined,
      operator: pick(merged, ["operator", "operador", "empresa", "agency"]),
    },
  };
}
