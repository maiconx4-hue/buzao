import type { LatLng } from "../geo";
import { forEachCsvRecord } from "./csv";
import { decimate } from "./geojson";
import { parseNumber } from "./mapping";
import {
  GeoImport,
  ImportError,
  ImportStop,
  LIMITS,
  RowIssue,
  isValidCoord,
  newId,
  round6,
  type Direction,
} from "./types";
import { findEntry, listZip, readText, type ZipEntry } from "./zip";

export type GtfsOption = {
  routeId: string;
  directionId: string;
  shortName: string;
  longName: string;
  tripCount: number;
  label: string;
};

type Table = { cols: Map<string, number>; rows: string[][] };

async function readTable(buf: Uint8Array, entries: ZipEntry[], name: string, required: string[]): Promise<Table> {
  const text = await readText(buf, entries, name);
  if (text === null) throw new ImportError(`GTFS inválido: falta o arquivo ${name}.`);
  const cols = new Map<string, number>();
  const rows: string[][] = [];
  let header = true;
  forEachCsvRecord(text, (rec) => {
    if (header) {
      rec.forEach((h, i) => cols.set(h.trim().toLowerCase(), i));
      header = false;
    } else rows.push(rec);
  });
  for (const c of required)
    if (!cols.has(c)) throw new ImportError(`GTFS inválido: ${name} não tem a coluna "${c}".`);
  return { cols, rows };
}

const get = (t: Table, r: string[], c: string): string => {
  const i = t.cols.get(c);
  return i === undefined ? "" : (r[i] ?? "").trim();
};

function openZip(buf: Uint8Array): ZipEntry[] {
  const entries = listZip(buf);
  for (const f of ["routes.txt", "trips.txt", "stops.txt", "stop_times.txt"])
    if (!findEntry(entries, f)) throw new ImportError(`GTFS inválido: falta o arquivo ${f}.`);
  return entries;
}

export async function gtfsListOptions(buf: Uint8Array): Promise<{ options: GtfsOption[]; issues: RowIssue[] }> {
  const entries = openZip(buf);
  const routes = await readTable(buf, entries, "routes.txt", ["route_id"]);
  const trips = await readTable(buf, entries, "trips.txt", ["route_id", "trip_id"]);
  const issues: RowIssue[] = [];
  const names = new Map<string, { s: string; l: string }>();
  routes.rows.forEach((r) =>
    names.set(get(routes, r, "route_id"), {
      s: get(routes, r, "route_short_name"),
      l: get(routes, r, "route_long_name"),
    }),
  );
  const counts = new Map<string, number>();
  trips.rows.forEach((r) => {
    const k = `${get(trips, r, "route_id")}\u0000${get(trips, r, "direction_id")}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  });
  const options: GtfsOption[] = [];
  for (const [k, n] of counts) {
    const [routeId, directionId] = k.split("\u0000") as [string, string];
    const nm = names.get(routeId) ?? { s: "", l: "" };
    const dir = directionId === "0" ? "ida (direction_id 0)" : directionId === "1" ? "volta (direction_id 1)" : "sentido não informado";
    options.push({
      routeId,
      directionId,
      shortName: nm.s,
      longName: nm.l,
      tripCount: n,
      label: `${nm.s || routeId}${nm.l ? " — " + nm.l : ""} · ${dir} · ${n} viagem(ns)`,
    });
  }
  options.sort((a, b) => a.label.localeCompare(b.label, "pt-BR", { numeric: true }));
  if (options.length === 0) issues.push({ row: null, field: "trips.txt", level: "erro", message: "O GTFS não tem viagens (trips.txt vazio)." });
  return { options, issues };
}

export async function gtfsBuild(buf: Uint8Array, opt: GtfsOption): Promise<GeoImport> {
  const entries = openZip(buf);
  const issues: RowIssue[] = [];
  const trips = await readTable(buf, entries, "trips.txt", ["route_id", "trip_id"]);
  const tripRows = trips.rows.filter(
    (r) => get(trips, r, "route_id") === opt.routeId && get(trips, r, "direction_id") === opt.directionId,
  );
  if (tripRows.length === 0) throw new ImportError("Nenhuma viagem encontrada para a linha/sentido escolhidos.");
  const tripIds = new Set(tripRows.map((r) => get(trips, r, "trip_id")));

  // viagem representativa = a com mais paradas
  const stRaw = await readText(buf, entries, "stop_times.txt");
  if (stRaw === null) throw new ImportError("GTFS inválido: falta stop_times.txt.");
  let tIdx = -1;
  let sIdx = -1;
  let qIdx = -1;
  const counts = new Map<string, number>();
  const rowsByTrip = new Map<string, { q: number; stop: string }[]>();
  let header = true;
  forEachCsvRecord(stRaw, (rec) => {
    if (header) {
      const h = rec.map((x) => x.trim().toLowerCase());
      tIdx = h.indexOf("trip_id");
      sIdx = h.indexOf("stop_id");
      qIdx = h.indexOf("stop_sequence");
      header = false;
      if (tIdx < 0 || sIdx < 0 || qIdx < 0)
        throw new ImportError("GTFS inválido: stop_times.txt precisa de trip_id, stop_id e stop_sequence.");
      return;
    }
    const t = (rec[tIdx] ?? "").trim();
    if (!tripIds.has(t)) return;
    counts.set(t, (counts.get(t) ?? 0) + 1);
    const list = rowsByTrip.get(t) ?? [];
    list.push({ q: Number((rec[qIdx] ?? "").trim()), stop: (rec[sIdx] ?? "").trim() });
    rowsByTrip.set(t, list);
  });
  let bestTrip = "";
  let bestN = -1;
  for (const r of tripRows) {
    const id = get(trips, r, "trip_id");
    const n = counts.get(id) ?? 0;
    if (n > bestN) {
      bestN = n;
      bestTrip = id;
    }
  }
  if (bestN <= 0) throw new ImportError("As viagens dessa linha não têm paradas em stop_times.txt.");
  const seqStops = (rowsByTrip.get(bestTrip) ?? []).sort((a, b) => a.q - b.q);
  issues.push({
    row: null,
    field: "viagem",
    level: "info",
    message: `Usada a viagem "${bestTrip}" (${seqStops.length} paradas), a mais completa entre ${tripRows.length} viagem(ns).`,
  });

  // coordenadas das paradas
  const need = new Set(seqStops.map((s) => s.stop));
  const stopsT = await readTable(buf, entries, "stops.txt", ["stop_id"]);
  const info = new Map<string, { name: string; lat: number | null; lng: number | null }>();
  stopsT.rows.forEach((r) => {
    const id = get(stopsT, r, "stop_id");
    if (!need.has(id)) return;
    info.set(id, {
      name: get(stopsT, r, "stop_name"),
      lat: parseNumber(get(stopsT, r, "stop_lat")),
      lng: parseNumber(get(stopsT, r, "stop_lon")),
    });
  });
  const stops: ImportStop[] = seqStops.map((s, i) => {
    const st = info.get(s.stop);
    const ok = st !== undefined && isValidCoord(st.lat, st.lng);
    if (!st) issues.push({ row: i + 1, field: "stops.txt", level: "erro", message: `Parada ${s.stop} não existe em stops.txt.` });
    else if (!ok) issues.push({ row: i + 1, field: "coordenadas", level: "erro", message: `Parada "${st.name}" sem coordenadas válidas no GTFS.` });
    return {
      id: newId(),
      seq: i + 1,
      name: st?.name || s.stop,
      lat: ok ? round6(st!.lat as number) : null,
      lng: ok ? round6(st!.lng as number) : null,
      coord: ok ? "fonte" : "ausente",
      row: i + 1,
    };
  });
  if (stops.length > LIMITS.stops)
    issues.push({ row: null, field: "paradas", level: "erro", message: `A viagem tem ${stops.length} paradas; o limite é ${LIMITS.stops}.` });

  // traçado (shapes.txt é opcional)
  let geometry: LatLng[] = [];
  const shapeId = get(trips, tripRows.find((r) => get(trips, r, "trip_id") === bestTrip) ?? [], "shape_id");
  if (shapeId && findEntry(entries, "shapes.txt")) {
    const sh = await readTable(buf, entries, "shapes.txt", ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"]);
    const pts: { q: number; p: LatLng }[] = [];
    sh.rows.forEach((r) => {
      if (get(sh, r, "shape_id") !== shapeId) return;
      const la = parseNumber(get(sh, r, "shape_pt_lat"));
      const lo = parseNumber(get(sh, r, "shape_pt_lon"));
      if (la !== null && lo !== null && isValidCoord(la, lo))
        pts.push({ q: Number(get(sh, r, "shape_pt_sequence")), p: [round6(la), round6(lo)] });
    });
    pts.sort((a, b) => a.q - b.q);
    geometry = pts.map((x) => x.p);
    if (geometry.length > LIMITS.geometryPoints) {
      issues.push({ row: null, field: "traçado", level: "aviso", message: `O traçado tinha ${geometry.length} pontos e foi simplificado.` });
      geometry = decimate(geometry, LIMITS.geometryPoints);
    }
  } else {
    issues.push({ row: null, field: "traçado", level: "aviso", message: "O GTFS não traz shape para esta viagem: o traçado precisa ser sugerido pelas vias ou desenhado." });
  }

  // metadados
  const routes = await readTable(buf, entries, "routes.txt", ["route_id"]);
  const rr = routes.rows.find((r) => get(routes, r, "route_id") === opt.routeId);
  let operator: string | undefined;
  const agText = await readText(buf, entries, "agency.txt");
  if (agText && rr) {
    const ag = await readTable(buf, entries, "agency.txt", []);
    const aid = get(routes, rr, "agency_id");
    const row = ag.rows.find((r) => aid === "" || get(ag, r, "agency_id") === aid);
    operator = row ? get(ag, row, "agency_name") || undefined : undefined;
  }
  const dir: Direction | undefined = opt.directionId === "0" ? "ida" : opt.directionId === "1" ? "volta" : undefined;
  const headsign = get(trips, tripRows.find((r) => get(trips, r, "trip_id") === bestTrip) ?? [], "trip_headsign");
  return {
    stops,
    geometry,
    issues,
    meta: {
      code: opt.shortName || opt.routeId,
      name: opt.longName || headsign || undefined,
      direction: dir,
      operator,
    },
  };
}
