import { ImportError, LIMITS } from "./types";

export type Table = { headers: string[]; rows: string[][]; rowNumbers: number[] };

export function detectDelimiter(text: string): "," | ";" | "\t" {
  let line = "";
  let inQ = false;
  for (const ch of text) {
    if (ch === '"') inQ = !inQ;
    if (!inQ && (ch === "\n" || ch === "\r")) {
      if (line.trim() !== "") break;
      line = "";
      continue;
    }
    line += ch;
  }
  let comma = 0;
  let semi = 0;
  let tab = 0;
  inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ) {
      if (ch === ",") comma++;
      else if (ch === ";") semi++;
      else if (ch === "\t") tab++;
    }
  }
  if (semi > comma && semi >= tab) return ";";
  if (tab > comma && tab > semi) return "\t";
  return ",";
}

/** CSV no estilo RFC 4180: aspas, aspas duplicadas, quebras de linha dentro de aspas, BOM. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const d = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  const pushRow = () => {
    row.push(field);
    field = "";
    rows.push(row);
    row = [];
    if (rows.length > LIMITS.rows + 1)
      throw new ImportError(`O arquivo tem mais de ${LIMITS.rows} linhas.`);
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"' && field === "") inQ = true;
    else if (ch === d) {
      row.push(field);
      field = "";
    } else if (ch === "\n") pushRow();
    else if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      pushRow();
    } else field += ch;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/** Percorre registros GTFS sem montar uma matriz gigante (stop_times pode ter milhares de linhas). */
export function forEachCsvRecord(text: string, cb: (record: string[], recordNumber: number) => void) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let n = 0;
  let pos = 0;
  while (pos <= src.length) {
    let end = src.indexOf("\n", pos);
    if (end < 0) end = src.length;
    let line = src.slice(pos, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    pos = end + 1;
    if (line.trim() === "") {
      if (end >= src.length) break;
      continue;
    }
    n++;
    cb(splitCsvLine(line), n);
    if (end >= src.length) break;
  }
}

export function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let f = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          f += '"';
          i++;
        } else inQ = false;
      } else f += ch;
    } else if (ch === '"' && f === "") inQ = true;
    else if (ch === ",") {
      out.push(f);
      f = "";
    } else f += ch;
  }
  out.push(f);
  return out;
}

export function toTable(rows: string[][]): Table {
  const first = rows.findIndex((r) => r.some((c) => c.trim() !== ""));
  if (first < 0) throw new ImportError("O arquivo está vazio.");
  const headers = rows[first]!.map((h) => h.trim());
  const width = headers.length;
  const out: string[][] = [];
  const rowNumbers: number[] = [];
  for (let i = first + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.some((c) => c.trim() !== "")) continue;
    const padded = r.slice(0, width);
    while (padded.length < width) padded.push("");
    out.push(padded);
    rowNumbers.push(i - first); // 1 = primeira linha de dados
  }
  if (out.length === 0) throw new ImportError("O arquivo tem cabeçalho, mas nenhuma linha de dados.");
  return { headers, rows: out, rowNumbers };
}

export function csvEscape(v: string): string {
  return /[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const TEMPLATE_HEADERS = [
  "linha_codigo",
  "linha_nome",
  "sentido",
  "operador",
  "sequencia",
  "parada_nome",
  "latitude",
  "longitude",
] as const;

/**
 * Modelo para download. As duas linhas de exemplo começam com "EXEMPLO" e são recusadas na importação,
 * para que nenhum dado de demonstração seja tratado como itinerário real.
 */
export function buildCsvTemplate(): string {
  const rows = [
    [...TEMPLATE_HEADERS],
    ["EXEMPLO", "EXEMPLO - apague estas linhas", "ida", "", "1", "EXEMPLO - nome da primeira parada", "", ""],
    ["EXEMPLO", "EXEMPLO - apague estas linhas", "ida", "", "2", "EXEMPLO - nome da segunda parada", "", ""],
  ];
  return "\uFEFF" + rows.map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}
