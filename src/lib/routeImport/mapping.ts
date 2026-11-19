import type { Table } from "./csv";
import {
  ImportStop,
  LIMITS,
  RowIssue,
  isValidCoord,
  newId,
  parseDirection,
  round6,
  type Direction,
} from "./types";

export type FieldKey =
  | "line_code"
  | "line_name"
  | "direction"
  | "operator"
  | "sequence"
  | "stop_name"
  | "lat"
  | "lng";

export const FIELD_LABELS: Record<FieldKey, string> = {
  line_code: "Código/número da linha",
  line_name: "Nome da linha",
  direction: "Sentido",
  operator: "Operador",
  sequence: "Sequência da parada",
  stop_name: "Nome da parada",
  lat: "Latitude",
  lng: "Longitude",
};

export const REQUIRED_FIELDS: FieldKey[] = ["stop_name"];

const SYNONYMS: Record<FieldKey, string[]> = {
  line_code: ["linha_codigo", "codigo_linha", "linha", "line", "route_short_name", "route", "numero_linha", "codigo", "cod_linha"],
  line_name: ["linha_nome", "nome_linha", "route_long_name", "nome_da_linha", "itinerario", "descricao_linha"],
  direction: ["sentido", "direcao", "direction", "direction_id"],
  operator: ["operador", "empresa", "agency", "agency_name", "concessionaria"],
  sequence: ["sequencia", "seq", "ordem", "stop_sequence", "sequence", "order", "posicao", "ordem_parada"],
  stop_name: ["parada_nome", "nome_parada", "parada", "stop_name", "nome", "ponto", "endereco", "local"],
  lat: ["latitude", "lat", "stop_lat", "y"],
  lng: ["longitude", "lng", "lon", "long", "stop_lon", "x"],
};

export type Mapping = Partial<Record<FieldKey, number>>;

export function normHeader(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function guessMapping(headers: string[]): Mapping {
  const norm = headers.map(normHeader);
  const used = new Set<number>();
  const out: Mapping = {};
  (Object.keys(SYNONYMS) as FieldKey[]).forEach((f) => {
    const idx = norm.findIndex((h, i) => !used.has(i) && SYNONYMS[f].includes(h));
    if (idx >= 0) {
      out[f] = idx;
      used.add(idx);
    }
  });
  return out;
}

/** Aceita "0.0349", "0,0349" e espaços. Devolve null se não for número finito. */
export function parseNumber(raw: string): number | null {
  let s = raw.trim().replace(/\s+/g, "");
  if (s === "") return null;
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export type Group = {
  key: string;
  code: string;
  name: string;
  direction: Direction;
  operator: string;
  stops: ImportStop[];
};

export type GroupDefaults = { code: string; name: string; direction: Direction; operator: string };

export function buildGroups(
  table: Table,
  mapping: Mapping,
  defaults: GroupDefaults,
): { groups: Group[]; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const groups = new Map<string, Group & { seqs: (number | null)[] }>();
  const cell = (r: string[], f: FieldKey): string => {
    const i = mapping[f];
    return i === undefined ? "" : (r[i] ?? "").trim();
  };

  table.rows.forEach((r, idx) => {
    const row = table.rowNumbers[idx] ?? idx + 1;
    const name = cell(r, "stop_name");
    if (name === "") {
      issues.push({ row, field: "nome da parada", level: "erro", message: "Nome da parada vazio — linha ignorada." });
      return;
    }
    if (/^exemplo\b/i.test(name)) {
      issues.push({ row, field: "nome da parada", level: "erro", message: "Linha de exemplo do modelo — apague-a do arquivo. Linha ignorada." });
      return;
    }

    let dir: Direction = defaults.direction;
    const dirRaw = cell(r, "direction");
    if (dirRaw !== "") {
      const parsed = parseDirection(dirRaw);
      if (parsed) dir = parsed;
      else issues.push({ row, field: "sentido", level: "aviso", message: `Sentido "${dirRaw}" não reconhecido; usando "${defaults.direction}".` });
    }
    const code = cell(r, "line_code") || defaults.code;
    const key = `${code.toUpperCase()}|${dir}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        code,
        name: cell(r, "line_name") || defaults.name,
        direction: dir,
        operator: cell(r, "operator") || defaults.operator,
        stops: [],
        seqs: [],
      };
      groups.set(key, g);
    }

    const latRaw = cell(r, "lat");
    const lngRaw = cell(r, "lng");
    let lat: number | null = null;
    let lng: number | null = null;
    let coord: ImportStop["coord"] = "ausente";
    let note: string | undefined;
    if (latRaw === "" && lngRaw === "") {
      issues.push({ row, field: "latitude/longitude", level: "aviso", message: "Sem coordenadas — geocodifique ou informe na revisão." });
    } else {
      const la = parseNumber(latRaw);
      const lo = parseNumber(lngRaw);
      if (la === null || lo === null) {
        issues.push({ row, field: "latitude/longitude", level: "erro", message: `Coordenadas inválidas ("${latRaw}", "${lngRaw}"). Corrija na revisão.` });
        note = `Valor original: ${latRaw} / ${lngRaw}`;
      } else if (!isValidCoord(la, lo)) {
        issues.push({ row, field: "latitude/longitude", level: "erro", message: `Coordenadas fora do intervalo válido (${la}, ${lo}). Corrija na revisão.` });
        note = `Valor original: ${latRaw} / ${lngRaw}`;
      } else {
        lat = round6(la);
        lng = round6(lo);
        coord = "fonte";
      }
    }

    const seqRaw = cell(r, "sequence");
    let seq: number | null = null;
    if (seqRaw !== "") {
      const n = parseNumber(seqRaw);
      if (n === null || !Number.isInteger(n) || n < 0)
        issues.push({ row, field: "sequência", level: "aviso", message: `Sequência "${seqRaw}" inválida; será usada a ordem do arquivo.` });
      else seq = n;
    }
    g.seqs.push(seq);
    g.stops.push({ id: newId(), seq: 0, name, lat, lng, coord, note, row });
  });

  const out: Group[] = [];
  for (const g of groups.values()) {
    const allSeq = g.seqs.every((s) => s !== null);
    if (allSeq) {
      const seen = new Set<number>();
      g.seqs.forEach((s, i) => {
        if (s !== null && seen.has(s))
          issues.push({ row: g.stops[i]?.row ?? null, field: "sequência", level: "aviso", message: `Sequência ${s} repetida na linha ${g.code} (${g.direction}).` });
        if (s !== null) seen.add(s);
      });
      const order = g.stops.map((s, i) => ({ s, q: g.seqs[i] as number, i }));
      order.sort((a, b) => a.q - b.q || a.i - b.i);
      g.stops = order.map((o) => o.s);
    } else if (g.seqs.some((s) => s !== null)) {
      issues.push({ row: null, field: "sequência", level: "aviso", message: `Linha ${g.code} (${g.direction}): sequência incompleta; usando a ordem do arquivo.` });
    }
    g.stops.forEach((s, i) => (s.seq = i + 1));
    if (g.stops.length > LIMITS.stops)
      issues.push({ row: null, field: "paradas", level: "erro", message: `Linha ${g.code} (${g.direction}) tem ${g.stops.length} paradas; o limite é ${LIMITS.stops}.` });
    const { seqs: _seqs, ...clean } = g;
    void _seqs;
    out.push(clean);
  }
  return { groups: out, issues };
}

const COORD_PAIR = /(-?\d{1,2}[.,]\d{3,})\s*[;,|\s]\s*(-?\d{1,3}[.,]\d{3,})\s*$/;

/**
 * Lista colada (uma parada por linha). Formatos aceitos:
 *   Nome da parada
 *   Nome da parada | -0.0349 , -51.0694
 *   Nome da parada;0,0349;-51,0694
 * Números de endereço como "Tv. Mateus, 108" NÃO são lidos como coordenada.
 */
export function parseStopList(text: string): { stops: ImportStop[]; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const stops: ImportStop[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let row = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    row++;
    if (/^exemplo\b/i.test(line)) {
      issues.push({ row, field: "parada", level: "erro", message: "Linha de exemplo — apague-a. Linha ignorada." });
      continue;
    }
    let name = line;
    let lat: number | null = null;
    let lng: number | null = null;
    let coord: ImportStop["coord"] = "ausente";
    let note: string | undefined;
    const m = COORD_PAIR.exec(line);
    if (m) {
      const la = parseNumber(m[1]!);
      const lo = parseNumber(m[2]!);
      if (la !== null && lo !== null && isValidCoord(la, lo)) {
        lat = round6(la);
        lng = round6(lo);
        coord = "fonte";
        name = line.slice(0, m.index).replace(/[\s|;,\t-]+$/, "").trim();
      } else {
        issues.push({ row, field: "coordenadas", level: "erro", message: "Coordenadas inválidas na linha; corrija na revisão." });
      }
    }
    if (name === "") {
      issues.push({ row, field: "parada", level: "erro", message: "Nome da parada vazio — linha ignorada." });
      continue;
    }
    if (name.length > 200) {
      name = name.slice(0, 200);
      issues.push({ row, field: "parada", level: "aviso", message: "Nome muito longo; foi cortado em 200 caracteres." });
    }
    stops.push({ id: newId(), seq: stops.length + 1, name, lat, lng, coord, note, row });
  }
  if (stops.length > LIMITS.stops)
    issues.push({ row: null, field: "paradas", level: "erro", message: `A lista tem ${stops.length} paradas; o limite é ${LIMITS.stops}.` });
  return { stops, issues };
}
