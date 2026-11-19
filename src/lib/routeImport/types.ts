import type { LatLng } from "../geo";

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export type Direction = "ida" | "volta" | "circular";
export const DIRECTIONS: Direction[] = ["ida", "volta", "circular"];

export type SourceKind =
  | "moovit_manual"
  | "orgao_transito"
  | "levantamento"
  | "openstreetmap"
  | "outra"
  | "csv"
  | "xlsx"
  | "geojson"
  | "gtfs"
  | "manual";

export const SOURCE_LABELS: Record<SourceKind, string> = {
  moovit_manual: "Moovit (conferência manual)",
  orgao_transito: "Órgão de trânsito / prefeitura",
  levantamento: "Levantamento próprio",
  openstreetmap: "OpenStreetMap",
  outra: "Outra fonte pública",
  csv: "Arquivo CSV",
  xlsx: "Arquivo XLSX",
  geojson: "Arquivo GeoJSON",
  gtfs: "Arquivo GTFS",
  manual: "Cadastro manual",
};

export const ASSISTED_SOURCES: SourceKind[] = [
  "moovit_manual",
  "orgao_transito",
  "levantamento",
  "openstreetmap",
  "outra",
];

/** De onde veio a coordenada da parada. */
export type CoordSource = "fonte" | "geocodificada" | "geocodificada_incerta" | "manual" | "ausente";

export const COORD_LABELS: Record<CoordSource, string> = {
  fonte: "Da fonte",
  geocodificada: "Estimada (geocodificação)",
  geocodificada_incerta: "Incerta (geocodificação)",
  manual: "Ajustada manualmente",
  ausente: "Sem coordenada",
};

export type ImportStop = {
  id: string;
  seq: number;
  name: string;
  lat: number | null;
  lng: number | null;
  coord: CoordSource;
  note?: string | undefined;
  /** Número da linha no arquivo/lista de origem (1 = primeira linha de dados). */
  row?: number | undefined;
};

export type IssueLevel = "erro" | "aviso" | "info";
export type RowIssue = {
  row: number | null;
  field: string;
  level: IssueLevel;
  message: string;
  stopId?: string | undefined;
};

export type GeometryKind = "nenhuma" | "fonte" | "osrm" | "reta" | "mista";
export type Segment = { start: number; end: number; kind: "fonte" | "osrm" | "reta" };

export type ImportMeta = {
  code?: string | undefined;
  name?: string | undefined;
  direction?: Direction | undefined;
  operator?: string | undefined;
};

export type GeoImport = {
  stops: ImportStop[];
  geometry: LatLng[];
  issues: RowIssue[];
  meta: ImportMeta;
};

export const LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  gtfsBytes: 25 * 1024 * 1024,
  zipEntryBytes: 60 * 1024 * 1024,
  zipEntries: 200,
  rows: 20000,
  stops: 500,
  geometryPoints: 5000,
  geocodePerRun: 150,
} as const;

/** Mesma caixa usada pelo banco (função in_service_area): Macapá e Santana. */
export const SERVICE_AREA = { latMin: -0.35, latMax: 0.4, lngMin: -51.45, lngMax: -50.85 } as const;

export function isValidCoord(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function inServiceArea(lat: number, lng: number): boolean {
  return (
    lat >= SERVICE_AREA.latMin &&
    lat <= SERVICE_AREA.latMax &&
    lng >= SERVICE_AREA.lngMin &&
    lng <= SERVICE_AREA.lngMax
  );
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `s${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function parseDirection(raw: string): Direction | null {
  const v = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  if (["ida", "i", "0", "outbound", "ida/volta"].includes(v)) return v === "ida/volta" ? null : "ida";
  if (["volta", "v", "1", "inbound", "retorno"].includes(v)) return "volta";
  if (["circular", "c", "loop"].includes(v)) return "circular";
  return null;
}
