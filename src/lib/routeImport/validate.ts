import { haversine, type LatLng } from "../geo";
import {
  ImportStop,
  LIMITS,
  RowIssue,
  inServiceArea,
  isValidCoord,
  type Direction,
  DIRECTIONS,
} from "./types";

export function hasErrors(issues: RowIssue[]): boolean {
  return issues.some((i) => i.level === "erro");
}

function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function pos(s: ImportStop): LatLng | null {
  return isValidCoord(s.lat, s.lng) ? [s.lat as number, s.lng as number] : null;
}

export function validateMeta(m: { code: string; name: string; direction: Direction }): RowIssue[] {
  const out: RowIssue[] = [];
  const code = m.code.trim();
  if (code.length < 1 || code.length > 20)
    out.push({ row: null, field: "código", level: "erro", message: "O código da rota deve ter de 1 a 20 caracteres." });
  const name = m.name.trim();
  if (name.length < 2 || name.length > 120)
    out.push({ row: null, field: "nome", level: "erro", message: "O nome da rota deve ter de 2 a 120 caracteres." });
  if (!DIRECTIONS.includes(m.direction))
    out.push({ row: null, field: "sentido", level: "erro", message: "Sentido inválido." });
  return out;
}

export function validateStops(stops: ImportStop[]): RowIssue[] {
  const out: RowIssue[] = [];
  if (stops.length === 0) {
    out.push({ row: null, field: "paradas", level: "erro", message: "Nenhuma parada na lista." });
    return out;
  }
  if (stops.length === 1)
    out.push({ row: null, field: "paradas", level: "aviso", message: "Só há uma parada; uma linha costuma ter pelo menos duas." });
  if (stops.length > LIMITS.stops)
    out.push({ row: null, field: "paradas", level: "erro", message: `São ${stops.length} paradas; o limite é ${LIMITS.stops}.` });

  let estimated = 0;
  stops.forEach((s, i) => {
    const where = `Parada ${i + 1} (${s.name || "sem nome"})`;
    const base = { row: s.row ?? null, stopId: s.id } as const;
    if (s.name.trim() === "") out.push({ ...base, field: "nome", level: "erro", message: `${where}: nome vazio.` });
    if (s.name.length > 200) out.push({ ...base, field: "nome", level: "erro", message: `${where}: nome com mais de 200 caracteres.` });
    if (!isValidCoord(s.lat, s.lng)) {
      out.push({ ...base, field: "coordenadas", level: "erro", message: `${where}: sem coordenada válida — geocodifique, informe ou arraste no mapa.` });
      return;
    }
    if (!inServiceArea(s.lat as number, s.lng as number))
      out.push({ ...base, field: "coordenadas", level: "erro", message: `${where}: fora da área de serviço (Macapá/Santana) — provável erro de coordenada ou geocodificação.` });
    if (s.coord === "geocodificada_incerta")
      out.push({ ...base, field: "coordenadas", level: "aviso", message: `${where}: coordenada incerta (geocodificação ambígua) — confira no mapa.` });
    if (s.coord === "geocodificada") estimated++;
  });
  if (estimated > 0)
    out.push({ row: null, field: "coordenadas", level: "info", message: `${estimated} parada(s) têm coordenadas estimadas por geocodificação (não são dados da fonte).` });

  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    const pa = pos(a);
    const pb = pos(b);
    if (!pa || !pb) continue;
    const d = haversine(pa, pb);
    if (normName(a.name) === normName(b.name) && d < 15)
      out.push({ row: b.row ?? null, stopId: b.id, field: "paradas", level: "aviso", message: `Parada ${i + 1} repete a parada ${i} (mesmo nome e posição).` });
    else if (d < 3)
      out.push({ row: b.row ?? null, stopId: b.id, field: "paradas", level: "aviso", message: `Paradas ${i} e ${i + 1} estão praticamente na mesma posição.` });
    if (d > 5000)
      out.push({ row: b.row ?? null, stopId: b.id, field: "paradas", level: "aviso", message: `Salto de ${(d / 1000).toFixed(1)} km entre as paradas ${i} e ${i + 1} — confira a ordem e as coordenadas.` });
  }
  return out;
}
