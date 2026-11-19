import type { LatLng } from "../geo";
import {
  Direction,
  GeometryKind,
  ImportError,
  ImportStop,
  RowIssue,
  Segment,
  SourceKind,
  isValidCoord,
  round6,
} from "./types";

export function normalizeLineCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9._-]/g, "-");
}

/** Um registro por linha e sentido, qualquer que seja a fonte: evita duplicar a mesma linha. */
export function makeImportKey(lineCode: string, direction: Direction): string {
  const c = normalizeLineCode(lineCode);
  if (c === "") throw new ImportError("Informe o número/código da linha.");
  return `macapa:${c}:${direction}`;
}

export type PayloadInput = {
  lineCode: string;
  code: string;
  name: string;
  direction: Direction;
  operator: string;
  description: string;
  color: string;
  source: SourceKind;
  sourceUrl: string;
  stops: ImportStop[];
  geometry: LatLng[];
  geometryKind: GeometryKind;
  segments: Segment[];
  issues: RowIssue[];
  reviewed: boolean;
  replace: boolean;
};

export function geometryKindOf(segments: Segment[], geometry: LatLng[]): GeometryKind {
  if (geometry.length === 0) return "nenhuma";
  const kinds = new Set(segments.map((s) => s.kind));
  if (kinds.size > 1) return "mista";
  return (kinds.values().next().value as GeometryKind | undefined) ?? "fonte";
}

export function buildPayload(i: PayloadInput): Record<string, unknown> {
  const stops = i.stops.map((s, idx) => {
    if (!isValidCoord(s.lat, s.lng) || s.coord === "ausente")
      throw new ImportError(`A parada ${idx + 1} (${s.name}) não tem coordenada.`);
    const o: Record<string, unknown> = {
      seq: idx + 1,
      name: s.name.trim(),
      lat: round6(s.lat as number),
      lng: round6(s.lng as number),
      coord: s.coord,
    };
    if (s.note) o["note"] = s.note.slice(0, 300);
    return o;
  });
  const url = i.sourceUrl.trim();
  return {
    import_key: makeImportKey(i.lineCode, i.direction),
    line_code: normalizeLineCode(i.lineCode),
    code: i.code.trim().toUpperCase(),
    name: i.name.trim(),
    direction: i.direction,
    operator: i.operator.trim(),
    description: i.description.trim(),
    color: i.color,
    source: i.source,
    source_url: url === "" ? null : url,
    stops,
    geometry: i.geometry.map((p) => [round6(p[0]), round6(p[1])]),
    geometry_origin: geometryKindOf(i.segments, i.geometry),
    segments: i.segments,
    warnings: i.issues
      .filter((x) => x.level !== "info")
      .slice(0, 100)
      .map((x) => ({ level: x.level, field: x.field, row: x.row, message: x.message.slice(0, 300) })),
    validation: i.reviewed ? "revisado" : "pendente",
    replace: i.replace,
  };
}
