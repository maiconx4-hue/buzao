/** Paradas guardadas em route_imports.stops (jsonb), usadas para reeditar a rota depois de importada. */
export type StoredStop = {
  seq: number;
  name: string;
  lat: number;
  lng: number;
  coord: string;
  note?: string | undefined;
};

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lê o jsonb do banco; ignora entradas inválidas e ordena pela sequência. */
export function parseStoredStops(json: unknown): StoredStop[] {
  if (!Array.isArray(json)) return [];
  const out: StoredStop[] = [];
  json.forEach((raw, i) => {
    if (!isRec(raw)) return;
    const lat = raw["lat"];
    const lng = raw["lng"];
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const seq = typeof raw["seq"] === "number" ? (raw["seq"] as number) : i + 1;
    const note = typeof raw["note"] === "string" ? (raw["note"] as string) : undefined;
    out.push({
      seq,
      name: typeof raw["name"] === "string" ? (raw["name"] as string) : `Parada ${i + 1}`,
      lat,
      lng,
      coord: typeof raw["coord"] === "string" ? (raw["coord"] as string) : "fonte",
      note,
    });
  });
  return out.sort((a, b) => a.seq - b.seq).map((s, i) => ({ ...s, seq: i + 1 }));
}

export function serializeStops(stops: StoredStop[]): Record<string, unknown>[] {
  return stops.map((s, i) => {
    const o: Record<string, unknown> = {
      seq: i + 1,
      name: s.name,
      lat: Math.round(s.lat * 1e6) / 1e6,
      lng: Math.round(s.lng * 1e6) / 1e6,
      coord: s.coord,
    };
    if (s.note) o["note"] = s.note.slice(0, 300);
    return o;
  });
}

export function stopsSignature(stops: StoredStop[]): string {
  return stops.map((s) => `${s.lat.toFixed(6)},${s.lng.toFixed(6)}`).join(";");
}
