import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { buildCsvTemplate, parseCsv, toTable, detectDelimiter } from "@/lib/routeImport/csv";
import { buildGroups, guessMapping, parseNumber, parseStopList } from "@/lib/routeImport/mapping";
import { validateStops, hasErrors } from "@/lib/routeImport/validate";
import { parseGeoJson } from "@/lib/routeImport/geojson";
import { listZip } from "@/lib/routeImport/zip";
import { readXlsx } from "@/lib/routeImport/xlsx";
import { gtfsBuild, gtfsListOptions } from "@/lib/routeImport/gtfs";
import { classifyResults, geocodeStops } from "@/lib/routeImport/geocode";
import { chunkWaypoints, parseOsrmResponse, routeThroughStops, straightLine } from "@/lib/routeImport/routing";
import { buildPayload, makeImportKey } from "@/lib/routeImport/payload";
import { parseStoredStops, serializeStops, stopsSignature } from "@/lib/routeImport/stops";
import { parseNativeResume } from "@/lib/nativeGps";
import { ImportError, type ImportStop } from "@/lib/routeImport/types";

// ---- ZIP de teste (compactado de verdade com deflate) ----
function crc32(b: Uint8Array): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function makeZip(files: Record<string, string>, method: 0 | 8 = 8): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const le = (n: number, bytes: number) => Uint8Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 0xff);
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const data = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const nm = enc.encode(name);
    const local = [le(0x04034b50, 4), le(20, 2), le(0, 2), le(method, 2), le(0, 2), le(0, 2), le(crc32(raw), 4), le(data.length, 4), le(raw.length, 4), le(nm.length, 2), le(0, 2), nm, data];
    const lb = Uint8Array.from(local.flatMap((x) => [...x]));
    parts.push(lb);
    central.push(Uint8Array.from([...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), ...le(0, 2), ...le(method, 2), ...le(0, 2), ...le(0, 2), ...le(crc32(raw), 4), ...le(data.length, 4), ...le(raw.length, 4), ...le(nm.length, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(offset, 4), ...nm]));
    offset += lb.length;
  }
  const cd = Uint8Array.from(central.flatMap((x) => [...x]));
  const eocd = Uint8Array.from([...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2), ...le(central.length, 2), ...le(central.length, 2), ...le(cd.length, 4), ...le(offset, 4), ...le(0, 2)]);
  return Uint8Array.from([...parts.flatMap((x) => [...x]), ...cd, ...eocd]);
}

describe("CSV", () => {
  it("lê aspas, vírgulas dentro de campo, BOM e CRLF", () => {
    const rows = parseCsv('\uFEFFa,b\r\n"Tv. Mateus, 108","x ""y"""\r\n');
    expect(rows).toEqual([["a", "b"], ["Tv. Mateus, 108", 'x "y"']]);
  });
  it("detecta ponto e vírgula", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
  });
  it("o modelo só tem linhas de exemplo e elas são recusadas", () => {
    const t = toTable(parseCsv(buildCsvTemplate()));
    const m = guessMapping(t.headers);
    const { groups, issues } = buildGroups(t, m, { code: "", name: "", direction: "ida", operator: "" });
    expect(groups).toHaveLength(0);
    expect(issues.filter((i) => i.level === "erro")).toHaveLength(2);
  });
  it("arquivo vazio e só cabeçalho dão erro claro", () => {
    expect(() => toTable([])).toThrow(ImportError);
    expect(() => toTable([["a", "b"]])).toThrow(ImportError);
  });
});

describe("mapeamento e erros por linha", () => {
  const csv = [
    "linha,sentido,seq,parada,lat,lng",
    "101,ida,2,Segunda,0.0400,-51.0600",
    "101,ida,1,Primeira,\"0,0349\",\"-51,0694\"",
    "101,ida,3,,0.05,-51.05",
    "101,ida,4,Quarta,abc,-51.05",
    "101,ida,5,Quinta,95,-51.05",
    "101,ida,6,Sexta,,",
    "101,volta,1,Volta 1,0.03,-51.07",
  ].join("\n");
  const t = toTable(parseCsv(csv));
  const { groups, issues } = buildGroups(t, guessMapping(t.headers), { code: "", name: "", direction: "ida", operator: "" });
  it("agrupa por linha e sentido e ordena pela sequência", () => {
    expect(groups.map((g) => g.key)).toEqual(["101|ida", "101|volta"]);
    expect(groups[0]!.stops.map((s) => s.name).slice(0, 2)).toEqual(["Primeira", "Segunda"]);
  });
  it("aceita vírgula decimal", () => {
    expect(groups[0]!.stops[0]!.lat).toBeCloseTo(0.0349, 6);
    expect(parseNumber("-51,0694")).toBeCloseTo(-51.0694, 6);
    expect(parseNumber("abc")).toBeNull();
  });
  it("reporta erro por linha (nome vazio, coordenada inválida/fora de faixa)", () => {
    const err = issues.filter((i) => i.level === "erro").map((i) => i.row);
    expect(err).toEqual(expect.arrayContaining([3, 4, 5]));
  });
  it("coordenada ausente vira parada pendente de geocodificação", () => {
    const sexta = groups[0]!.stops.find((s) => s.name === "Sexta")!;
    expect(sexta.coord).toBe("ausente");
  });
});

describe("lista colada", () => {
  it("não confunde número de endereço com coordenada", () => {
    const { stops } = parseStopList("Tv. Mateus, 108\nVia Chico Mendes, 2411\nPraça | 0.0349, -51.0694");
    expect(stops).toHaveLength(3);
    expect(stops[0]!.coord).toBe("ausente");
    expect(stops[1]!.name).toBe("Via Chico Mendes, 2411");
    expect(stops[2]!.coord).toBe("fonte");
    expect(stops[2]!.name).toBe("Praça");
  });
});

describe("validação", () => {
  const mk = (name: string, lat: number | null, lng: number | null, coord: ImportStop["coord"] = "fonte"): ImportStop => ({
    id: name, seq: 1, name, lat, lng, coord,
  });
  it("detecta sem coordenada, fora da área, duplicada e salto grande", () => {
    const issues = validateStops([
      mk("A", 0.03, -51.07),
      mk("A", 0.03, -51.07),
      mk("B", null, null, "ausente"),
      mk("C", 10, 10),
      mk("D", 0.3, -51.4),
    ]);
    expect(hasErrors(issues)).toBe(true);
    expect(issues.some((i) => /repete/.test(i.message))).toBe(true);
    expect(issues.some((i) => /sem coordenada/.test(i.message))).toBe(true);
    expect(issues.some((i) => /fora da área/.test(i.message))).toBe(true);
    expect(issues.some((i) => /Salto/.test(i.message))).toBe(true);
  });
  it("lista válida não tem erros", () => {
    expect(hasErrors(validateStops([mk("A", 0.03, -51.07), mk("B", 0.04, -51.06)]))).toBe(false);
  });
});

describe("GeoJSON", () => {
  const gj = JSON.stringify({
    type: "FeatureCollection",
    properties: { code: "101", direction: "volta" },
    features: [
      { type: "Feature", properties: { name: "B", sequence: 2 }, geometry: { type: "Point", coordinates: [-51.06, 0.04] } },
      { type: "Feature", properties: { name: "A", sequence: 1 }, geometry: { type: "Point", coordinates: [-51.07, 0.03] } },
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[-51.07, 0.03], [-51.065, 0.035], [-51.06, 0.04]] } },
    ],
  });
  it("lê paradas ordenadas, traçado e metadados (lng,lat → lat,lng)", () => {
    const r = parseGeoJson(gj);
    expect(r.stops.map((s) => s.name)).toEqual(["A", "B"]);
    expect(r.stops[0]!.lat).toBeCloseTo(0.03, 6);
    expect(r.geometry).toHaveLength(3);
    expect(r.geometry[0]).toEqual([0.03, -51.07]);
    expect(r.meta.code).toBe("101");
    expect(r.meta.direction).toBe("volta");
  });
  it("recusa JSON inválido e documento sem feições", () => {
    expect(() => parseGeoJson("{")).toThrow(ImportError);
    expect(() => parseGeoJson('{"type":"FeatureCollection","features":[]}')).toThrow(ImportError);
  });
});

describe("ZIP / XLSX", () => {
  it("lê ZIP armazenado e compactado e recusa lixo", () => {
    for (const m of [0, 8] as const) {
      const z = makeZip({ "a.txt": "olá" }, m);
      expect(listZip(z).map((e) => e.name)).toEqual(["a.txt"]);
    }
    expect(() => listZip(new Uint8Array([1, 2, 3]))).toThrow(ImportError);
  });
  it("lê a primeira planilha do XLSX (strings compartilhadas, números e células vazias)", async () => {
    const xlsx = makeZip({
      "xl/workbook.xml": '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="x"/></Relationships>',
      "xl/sharedStrings.xml": '<sst><si><t>parada</t></si><si><t>lat</t></si><si><t>Tv. Mateus &amp; Cia, 108</t></si></sst>',
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>0.0349</v></c></row></sheetData></worksheet>',
    });
    const rows = await readXlsx(xlsx);
    expect(rows[0]).toEqual(["parada", "", "lat"]);
    expect(rows[1]).toEqual(["Tv. Mateus & Cia, 108", "", "0.0349"]);
  });
  it("recusa arquivo que não é xlsx", async () => {
    await expect(readXlsx(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(ImportError);
  });
});

describe("GTFS", () => {
  const gtfs = makeZip({
    "routes.txt": "route_id,route_short_name,route_long_name\nR1,101,Centro - Zerão\n",
    "trips.txt": "route_id,trip_id,direction_id,shape_id,trip_headsign\nR1,T1,0,SH1,Zerão\nR1,T2,0,SH1,Zerão\nR1,T3,1,SH2,Centro\n",
    "stops.txt": 'stop_id,stop_name,stop_lat,stop_lon\nS1,"Praça, Centro",0.0349,-51.0694\nS2,Segunda,0.04,-51.06\nS3,Terceira,0.05,-51.05\n',
    "stop_times.txt": "trip_id,stop_id,stop_sequence\nT1,S2,2\nT1,S1,1\nT2,S1,1\nT3,S3,1\n",
    "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH1,0.04,-51.06,2\nSH1,0.0349,-51.0694,1\n",
  });
  it("lista linhas/sentidos e monta paradas e traçado da viagem mais completa", async () => {
    const { options } = await gtfsListOptions(gtfs);
    expect(options).toHaveLength(2);
    const ida = options.find((o) => o.directionId === "0")!;
    const r = await gtfsBuild(gtfs, ida);
    expect(r.stops.map((s) => s.name)).toEqual(["Praça, Centro", "Segunda"]);
    expect(r.stops.every((s) => s.coord === "fonte")).toBe(true);
    expect(r.geometry).toEqual([[0.0349, -51.0694], [0.04, -51.06]]);
    expect(r.meta.code).toBe("101");
    expect(r.meta.direction).toBe("ida");
  });
  it("recusa GTFS sem arquivo obrigatório", async () => {
    await expect(gtfsListOptions(makeZip({ "routes.txt": "route_id\nR1\n" }))).rejects.toThrow(/falta o arquivo/);
  });
});

describe("geocodificação", () => {
  const it1 = { lat: "0.0349", lon: "-51.0694", display_name: "Rua X 10, Macapá", class: "place", type: "house" };
  it("um resultado em endereço → estimada", () => {
    expect(classifyResults([it1]).status).toBe("ok");
  });
  it("sem resultado ou fora da área → nenhum", () => {
    expect(classifyResults([]).status).toBe("nenhum");
    expect(classifyResults([{ ...it1, lat: "10", lon: "10" }]).status).toBe("nenhum");
  });
  it("resultados distantes entre si ou via inteira → incerto", () => {
    expect(classifyResults([it1, { ...it1, lat: "0.2", lon: "-51.0" }]).status).toBe("incerto");
    expect(classifyResults([{ ...it1, class: "highway", type: "residential", display_name: "Avenida Y, Macapá" }]).status).toBe("incerto");
  });
  it("geocodifica só quem não tem coordenada e marca a origem", async () => {
    const calls: string[] = [];
    const fake = (async (u: string) => {
      calls.push(String(u));
      return { ok: true, json: async () => [it1] } as unknown as Response;
    }) as unknown as typeof fetch;
    const stops: ImportStop[] = [
      { id: "1", seq: 1, name: "Sem coord", lat: null, lng: null, coord: "ausente" },
      { id: "2", seq: 2, name: "Com coord", lat: 0.03, lng: -51.07, coord: "fonte" },
    ];
    const r = await geocodeStops(stops, { fetchFn: fake, delayMs: 0 });
    expect(calls).toHaveLength(1);
    expect(r.stops[0]!.coord).toBe("geocodificada");
    expect(r.stops[1]!.coord).toBe("fonte");
  });
  it("erro de rede não inventa coordenada", async () => {
    const fake = (async () => { throw new Error("rede"); }) as unknown as typeof fetch;
    const r = await geocodeStops([{ id: "1", seq: 1, name: "X", lat: null, lng: null, coord: "ausente" }], { fetchFn: fake, delayMs: 0 });
    expect(r.errors).toBe(1);
    expect(r.stops[0]!.coord).toBe("ausente");
  });
});

describe("roteamento (OSRM)", () => {
  const osrm = (coords: [number, number][]) => ({ code: "Ok", routes: [{ geometry: { coordinates: coords } }], waypoints: coords.map(() => ({ distance: 12 })) });
  it("divide em blocos com 1 parada de sobreposição", () => {
    const ch = chunkWaypoints([1, 2, 3, 4, 5, 6, 7], 3);
    expect(ch.map((c) => c.items)).toEqual([[1, 2, 3], [3, 4, 5], [5, 6, 7]]);
  });
  it("converte lng,lat em lat,lng", () => {
    expect(parseOsrmResponse(osrm([[-51.07, 0.03], [-51.06, 0.04]])).geometry[0]).toEqual([0.03, -51.07]);
    expect(() => parseOsrmResponse({ code: "NoRoute" })).toThrow(ImportError);
  });
  it("monta o traçado calculado; falha do roteador lança erro em vez de inventar trecho", async () => {
    const ok = (async () => ({ ok: true, json: async () => osrm([[-51.07, 0.03], [-51.06, 0.04]]) }) as unknown as Response) as unknown as typeof fetch;
    const r = await routeThroughStops([[0.03, -51.07], [0.04, -51.06]], { fetchFn: ok, delayMs: 0 });
    expect(r.segments[0]!.kind).toBe("osrm");
    expect(r.distance_m).toBeGreaterThan(1000);
    const bad = (async () => ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch;
    await expect(routeThroughStops([[0.03, -51.07], [0.04, -51.06]], { fetchFn: bad, delayMs: 0 })).rejects.toThrow(/indispon/i);
  });
  it("linha reta é explícita e marcada como provisória", () => {
    const r = straightLine([[0.03, -51.07], [0.04, -51.06]]);
    expect(r.segments[0]!.kind).toBe("reta");
  });
});

describe("payload para o banco", () => {
  const stops: ImportStop[] = [
    { id: "1", seq: 1, name: "A", lat: 0.03, lng: -51.07, coord: "fonte" },
    { id: "2", seq: 2, name: "B", lat: 0.04, lng: -51.06, coord: "geocodificada", note: "x" },
  ];
  const base = {
    lineCode: " 101 ", code: "101", name: "Linha", direction: "ida" as const, operator: "", description: "", color: "#0e9f8e",
    source: "csv" as const, sourceUrl: "", stops, geometry: [], geometryKind: "nenhuma" as const, segments: [], issues: [], reviewed: false, replace: false,
  };
  it("chave de importação única por linha e sentido", () => {
    expect(makeImportKey("101", "ida")).toBe("macapa:101:ida");
    expect(makeImportKey(" 10 a ", "volta")).toBe("macapa:10A:volta");
  });
  it("gera rascunho pendente de revisão e preserva a origem das coordenadas", () => {
    const p = buildPayload(base) as { validation: string; stops: { coord: string }[]; source_url: unknown; geometry_origin: string };
    expect(p.validation).toBe("pendente");
    expect(p.stops.map((s) => s.coord)).toEqual(["fonte", "geocodificada"]);
    expect(p.source_url).toBeNull();
    expect(p.geometry_origin).toBe("nenhuma");
  });
  it("recusa parada sem coordenada", () => {
    expect(() => buildPayload({ ...base, stops: [{ id: "1", seq: 1, name: "A", lat: null, lng: null, coord: "ausente" }] })).toThrow(ImportError);
  });
});

describe("paradas guardadas para reeditar no editor", () => {
  const json = [
    { seq: 2, name: "B", lat: 0.04, lng: -51.06, coord: "geocodificada", note: "n" },
    { seq: 1, name: "A", lat: 0.03, lng: -51.07, coord: "fonte" },
    { seq: 3, name: "ruim", lat: "x", lng: -51 },
    "lixo",
  ];
  it("lê, descarta entradas inválidas e ordena pela sequência", () => {
    const r = parseStoredStops(json);
    expect(r.map((x) => x.name)).toEqual(["A", "B"]);
    expect(r.map((x) => x.seq)).toEqual([1, 2]);
    expect(parseStoredStops(null)).toEqual([]);
  });
  it("arrastar uma parada muda a assinatura; voltar ao lugar restaura", () => {
    const r = parseStoredStops(json);
    const moved = r.map((x, i) => (i === 0 ? { ...x, lat: 0.0301 } : x));
    expect(stopsSignature(moved)).not.toBe(stopsSignature(r));
    expect(stopsSignature(moved.map((x, i) => (i === 0 ? { ...x, lat: 0.03 } : x)))).toBe(stopsSignature(r));
  });
  it("serializa com 6 casas, renumera e preserva a origem da coordenada", () => {
    const out = serializeStops([{ seq: 9, name: "A", lat: 0.0300004, lng: -51.07, coord: "manual" }]);
    expect(out).toEqual([{ seq: 1, name: "A", lat: 0.03, lng: -51.07, coord: "manual" }]);
  });
});

describe("retomada pelo app Android (NATIVE_RESUME)", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const secret = "a".repeat(64);
  it("aceita só a mensagem completa e bem formada", () => {
    expect(parseNativeResume(JSON.stringify({ action: "NATIVE_RESUME", visitor_id: id, secret }))).toEqual({ visitor_id: id, secret });
    expect(parseNativeResume(JSON.stringify({ action: "GPS_UPDATE", visitor_id: id, secret }))).toBeNull();
    expect(parseNativeResume(JSON.stringify({ action: "NATIVE_RESUME", visitor_id: "x", secret }))).toBeNull();
    expect(parseNativeResume(JSON.stringify({ action: "NATIVE_RESUME", visitor_id: id, secret: "curto" }))).toBeNull();
    expect(parseNativeResume("não é json")).toBeNull();
    expect(parseNativeResume(null)).toBeNull();
  });
});
