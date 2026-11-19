import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Crosshair,
  Download,
  Redo2,
  Route as RouteIcon,
  Search,
  Trash2,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDistance, pathLength, type LatLng } from "@/lib/geo";
import { buildCsvTemplate, parseCsv, toTable, type Table } from "@/lib/routeImport/csv";
import { readXlsx } from "@/lib/routeImport/xlsx";
import { parseGeoJson } from "@/lib/routeImport/geojson";
import { gtfsBuild, gtfsListOptions, type GtfsOption } from "@/lib/routeImport/gtfs";
import {
  FIELD_LABELS,
  buildGroups,
  guessMapping,
  parseNumber,
  parseStopList,
  type FieldKey,
  type Group,
  type Mapping,
} from "@/lib/routeImport/mapping";
import { geocodeStops } from "@/lib/routeImport/geocode";
import { routeThroughStops, straightLine } from "@/lib/routeImport/routing";
import { buildPayload, normalizeLineCode } from "@/lib/routeImport/payload";
import { hasErrors, validateMeta, validateStops } from "@/lib/routeImport/validate";
import {
  ASSISTED_SOURCES,
  COORD_LABELS,
  DIRECTIONS,
  ImportError,
  LIMITS,
  SOURCE_LABELS,
  isValidCoord,
  newId,
  type Direction,
  type GeoImport,
  type GeometryKind,
  type ImportStop,
  type RowIssue,
  type Segment,
  type SourceKind,
} from "@/lib/routeImport/types";
import { COORD_COLORS } from "@/components/map/ImportMap";

const ImportMap = lazy(() => import("@/components/map/ImportMap"));

type Step = "origem" | "mapear" | "gtfs" | "revisar";
type Snap = {
  stops: ImportStop[];
  geometry: LatLng[];
  segments: Segment[];
  kind: GeometryKind;
  stale: boolean;
};

const FIELD_ORDER: FieldKey[] = ["stop_name", "lat", "lng", "sequence", "line_code", "line_name", "direction", "operator"];

const renumber = (st: ImportStop[]): ImportStop[] => st.map((s, i) => ({ ...s, seq: i + 1 }));

function saveErrorText(msg: string): string {
  if (msg.includes("FORBIDDEN")) return "Apenas o administrador pode importar rotas.";
  if (msg.includes("CODE_EXISTS"))
    return "Já existe uma rota com esse código no BusMap. Altere o código (por exemplo, acrescente V no sentido volta) ou edite a rota existente.";
  if (msg.includes("ROUTE_NOT_DRAFT"))
    return "A rota desta importação já foi publicada ou desativada e não é sobrescrita automaticamente. Edite-a pelo editor de rotas.";
  if (msg.includes("RATE_LIMIT")) return "Muitas importações na última hora. Tente novamente mais tarde.";
  const stop = /(INVALID_STOP|STOP_OUT_OF_AREA):(\d+)/.exec(msg);
  if (stop)
    return stop[1] === "STOP_OUT_OF_AREA"
      ? `A parada ${stop[2]} está fora da área de serviço (Macapá/Santana).`
      : `A parada ${stop[2]} é inválida (nome ou coordenada).`;
  if (msg.includes("GEOMETRY_OUT_OF_AREA")) return "O traçado tem pontos fora da área de serviço (Macapá/Santana).";
  if (msg.includes("Could not find the function") || msg.includes("admin_save_route_import"))
    return "A função de importação ainda não existe no banco. Rode o arquivo 04_importar_rota.sql no SQL Editor do Supabase.";
  return msg;
}

export function RouteImporter({
  onClose,
  onSaved,
  onOpenEditor,
}: {
  onClose: () => void;
  onSaved: () => void;
  onOpenEditor: (routeId: string) => void;
}) {
  const [step, setStep] = useState<Step>("origem");
  const [tab, setTab] = useState<"assistido" | "arquivo">("assistido");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  // metadados da rota
  const [lineCode, setLineCode] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<Direction>("ida");
  const [operator, setOperator] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#0e9f8e");
  const [source, setSource] = useState<SourceKind>("moovit_manual");
  const [sourceUrl, setSourceUrl] = useState("");
  const [pasted, setPasted] = useState("");

  // arquivo
  const [fileName, setFileName] = useState("");
  const [fileKind, setFileKind] = useState<"csv" | "xlsx">("csv");
  const [table, setTable] = useState<Table | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [fileIssues, setFileIssues] = useState<RowIssue[]>([]);
  const [gtfsBuf, setGtfsBuf] = useState<Uint8Array | null>(null);
  const [gtfsOptions, setGtfsOptions] = useState<GtfsOption[]>([]);
  const [gtfsPick, setGtfsPick] = useState("0");

  // revisão
  const [hist, setHist] = useState<{ list: Snap[]; i: number }>({ list: [], i: -1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const [snapWarn, setSnapWarn] = useState<{ stopId: string; index: number; d: number }[]>([]);
  const [routeFailed, setRouteFailed] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [saved, setSaved] = useState<{ routeId: string; snap: Snap; sig: string } | null>(null);
  const [published, setPublished] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const cur = hist.list[hist.i];

  // Código sugerido no BusMap: o código da linha (+V no sentido volta, +C no circular)
  useEffect(() => {
    if (codeTouched) return;
    const base = normalizeLineCode(lineCode);
    setCode(direction === "volta" ? `${base}V` : direction === "circular" ? `${base}C` : base);
  }, [lineCode, direction, codeTouched]);

  const mutate = (fn: (c: Snap) => Snap, record: boolean) =>
    setHist((h) => {
      const c = h.list[h.i];
      if (!c) return h;
      const next = fn(c);
      if (!record) {
        const list = h.list.slice();
        list[h.i] = next;
        return { list, i: h.i };
      }
      const list = [...h.list.slice(0, h.i + 1), next].slice(-100);
      return { list, i: list.length - 1 };
    });
  const withStops = (c: Snap, stops: ImportStop[]): Snap => ({
    ...c,
    stops: renumber(stops),
    stale: c.kind === "osrm" || c.kind === "reta" || c.kind === "mista" ? true : c.stale,
  });

  const startReview = (data: GeoImport, src: SourceKind) => {
    if (data.meta.code) {
      setLineCode(data.meta.code);
      setCodeTouched(false);
    }
    if (data.meta.name) setName(data.meta.name);
    if (data.meta.direction) setDirection(data.meta.direction);
    if (data.meta.operator) setOperator(data.meta.operator);
    setSource(src);
    const hasGeom = data.geometry.length >= 2;
    const snap: Snap = {
      stops: renumber(data.stops),
      geometry: data.geometry,
      segments: hasGeom ? [{ start: 0, end: data.geometry.length - 1, kind: "fonte" }] : [],
      kind: hasGeom ? "fonte" : "nenhuma",
      stale: false,
    };
    setHist({ list: [snap], i: 0 });
    setFileIssues(data.issues);
    setSelectedId(null);
    setAddMode(false);
    setSnapWarn([]);
    setRouteFailed(false);
    setReviewed(false);
    setSaved(null);
    setPublished(false);
    setFitKey((k) => k + 1);
    setStep("revisar");
  };

  /* ------------------------------ origem: lista assistida ------------------------------ */
  const startAssisted = () => {
    if (lineCode.trim() === "") {
      toast.error("Informe o número/código da linha.");
      return;
    }
    const r = parseStopList(pasted);
    if (r.stops.length === 0) {
      toast.error(r.issues[0]?.message ?? "Cole a lista de paradas (uma por linha).");
      return;
    }
    if (sourceUrl.trim() !== "" && !/^https?:\/\//i.test(sourceUrl.trim())) {
      toast.error("A URL de referência deve começar com http:// ou https://.");
      return;
    }
    startReview({ stops: r.stops, geometry: [], issues: r.issues, meta: { name: name || undefined } }, source);
  };

  /* ------------------------------ origem: arquivo ------------------------------ */
  const loadTable = (t: Table, kind: "csv" | "xlsx") => {
    setTable(t);
    setFileKind(kind);
    setMapping(guessMapping(t.headers));
    setGroups([]);
    setFileIssues([]);
    setStep("mapear");
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const ext = (file.name.split(".").pop() ?? "").toLowerCase();
      if (!["csv", "xlsx", "geojson", "json", "zip"].includes(ext))
        throw new ImportError("Formato não suportado. Use CSV, XLSX, GeoJSON ou GTFS (.zip).");
      const max = ext === "zip" ? LIMITS.gtfsBytes : LIMITS.fileBytes;
      if (file.size === 0) throw new ImportError("O arquivo está vazio.");
      if (file.size > max)
        throw new ImportError(`Arquivo grande demais (limite de ${Math.round(max / 1048576)} MB para .${ext}).`);
      setFileName(file.name);
      if (ext === "csv") {
        const text = await file.text();
        if (text.includes("\u0000")) throw new ImportError("O arquivo parece binário, não um CSV de texto.");
        loadTable(toTable(parseCsv(text)), "csv");
      } else if (ext === "xlsx") {
        const rows = await readXlsx(new Uint8Array(await file.arrayBuffer()));
        loadTable(toTable(rows), "xlsx");
      } else if (ext === "geojson" || ext === "json") {
        startReview(parseGeoJson(await file.text()), "geojson");
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { options, issues } = await gtfsListOptions(bytes);
        if (options.length === 0) throw new ImportError(issues[0]?.message ?? "O GTFS não tem linhas.");
        setGtfsBuf(bytes);
        setGtfsOptions(options);
        setGtfsPick("0");
        setFileIssues(issues);
        setStep("gtfs");
      }
    } catch (e) {
      toast.error(e instanceof ImportError ? e.message : "Não foi possível ler o arquivo.");
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([buildCsvTemplate()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "modelo-importar-rota.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const validateMapping = () => {
    if (!table) return;
    if (mapping.stop_name === undefined) {
      toast.error('Indique a coluna do "Nome da parada".');
      return;
    }
    const r = buildGroups(table, mapping, { code: lineCode.trim(), name: name.trim(), direction, operator: operator.trim() });
    setGroups(r.groups);
    setFileIssues(r.issues);
    if (r.groups.length === 0) toast.error("Nenhuma parada utilizável. Veja os erros por linha abaixo.");
    else if (r.groups.length === 1) pickGroup(r.groups[0]!, r.issues);
  };

  const pickGroup = (g: Group, issues: RowIssue[]) => {
    startReview(
      {
        stops: g.stops,
        geometry: [],
        issues,
        meta: { code: g.code || undefined, name: g.name || undefined, direction: g.direction, operator: g.operator || undefined },
      },
      fileKind,
    );
  };

  const useGtfs = async () => {
    const opt = gtfsOptions[Number(gtfsPick)];
    if (!opt || !gtfsBuf) return;
    setBusy(true);
    try {
      startReview(await gtfsBuild(gtfsBuf, opt), "gtfs");
    } catch (e) {
      toast.error(e instanceof ImportError ? e.message : "Não foi possível montar a linha do GTFS.");
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------ revisão: paradas ------------------------------ */
  const undo = () => setHist((h) => (h.i > 0 ? { ...h, i: h.i - 1 } : h));
  const redo = () => setHist((h) => (h.i < h.list.length - 1 ? { ...h, i: h.i + 1 } : h));

  const updateName = (id: string, v: string) =>
    mutate((c) => ({ ...c, stops: c.stops.map((s) => (s.id === id ? { ...s, name: v } : s)) }), false);

  const setCoord = (id: string, patch: { lat?: number | null; lng?: number | null }) =>
    mutate(
      (c) =>
        withStops(
          c,
          c.stops.map((s) => {
            if (s.id !== id) return s;
            const lat = patch.lat !== undefined ? patch.lat : s.lat;
            const lng = patch.lng !== undefined ? patch.lng : s.lng;
            return { ...s, lat, lng, coord: isValidCoord(lat, lng) ? "manual" : "ausente" };
          }),
        ),
      true,
    );

  const coordText = (id: string, which: "lat" | "lng", text: string) => {
    if (text.trim() === "") return setCoord(id, { [which]: null });
    const n = parseNumber(text);
    if (n === null) {
      toast.error(`${which === "lat" ? "Latitude" : "Longitude"} inválida: "${text}".`);
      return;
    }
    setCoord(id, { [which]: n });
  };

  const moveStop = (id: string, delta: -1 | 1) =>
    mutate((c) => {
      const i = c.stops.findIndex((s) => s.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= c.stops.length) return c;
      const arr = c.stops.slice();
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      return withStops(c, arr);
    }, true);

  const deleteStop = (id: string) => {
    mutate((c) => withStops(c, c.stops.filter((s) => s.id !== id)), true);
    if (selectedId === id) setSelectedId(null);
  };

  const addStopAt = (lat: number, lng: number) => {
    const id = newId();
    mutate((c) => {
      const at = selectedId ? c.stops.findIndex((s) => s.id === selectedId) + 1 : c.stops.length;
      const arr = c.stops.slice();
      arr.splice(at, 0, { id, seq: 0, name: `Nova parada ${c.stops.length + 1}`, lat, lng, coord: "manual" });
      return withStops(c, arr);
    }, true);
    setSelectedId(id);
    setAddMode(false);
  };

  /* ------------------------------ revisão: geocodificação e traçado ------------------------------ */
  const geocode = async (ids?: string[]) => {
    if (!cur) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    try {
      const opts: { ids?: string[]; signal: AbortSignal; onProgress: (d: number, t: number) => void } = {
        signal: ctrl.signal,
        onProgress: (d, t) => setProgress(`Geocodificando ${d}/${t}… (1 consulta por segundo)`),
      };
      if (ids) opts.ids = ids;
      const r = await geocodeStops(cur.stops, opts);
      const original = new Map(cur.stops.map((s) => [s.id, s]));
      const changed = new Map(r.stops.filter((s) => original.get(s.id) !== s).map((s) => [s.id, s]));
      mutate(
        (c) =>
          withStops(
            c,
            c.stops.map((s) => {
              const g = changed.get(s.id);
              return g ? { ...s, lat: g.lat, lng: g.lng, coord: g.coord, note: g.note } : s;
            }),
          ),
        true,
      );
      const parts = [`${r.found} estimada(s)`, `${r.uncertain} incerta(s)`, `${r.missing} sem resultado`];
      if (r.errors > 0) parts.push(`${r.errors} falha(s) de rede`);
      if (r.skipped > 0) parts.push(`${r.skipped} ficaram para outra rodada (limite de ${LIMITS.geocodePerRun})`);
      toast.message("Geocodificação: " + parts.join(", ") + ". Confira cada ponto no mapa.");
    } catch {
      toast.error("A geocodificação falhou. Informe as coordenadas manualmente.");
    } finally {
      setProgress(null);
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stopPoints = (): LatLng[] | null => {
    if (!cur) return null;
    const pts: LatLng[] = [];
    for (const s of cur.stops) {
      if (!isValidCoord(s.lat, s.lng)) {
        toast.error(`A parada ${s.seq} (${s.name}) ainda não tem coordenada.`);
        return null;
      }
      pts.push([s.lat as number, s.lng as number]);
    }
    if (pts.length < 2) {
      toast.error("São necessárias pelo menos 2 paradas.");
      return null;
    }
    return pts;
  };

  const applyRoute = (r: { geometry: LatLng[]; segments: Segment[]; snapDistances: number[] }, kind: GeometryKind) => {
    mutate((c) => ({ ...c, geometry: r.geometry, segments: r.segments, kind, stale: false }), true);
    setSnapWarn(
      cur
        ? r.snapDistances
            .map((d, index) => ({ stopId: cur.stops[index]?.id ?? "", index, d }))
            .filter((x) => x.d > 100 && x.stopId !== "")
        : [],
    );
    setFitKey((k) => k + 1);
  };

  const calcRoute = async () => {
    const pts = stopPoints();
    if (!pts) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setRouteFailed(false);
    try {
      const r = await routeThroughStops(pts, {
        signal: ctrl.signal,
        onProgress: (d, t) => setProgress(`Calculando trajeto pelas vias ${d}/${t}…`),
      });
      applyRoute(r, "osrm");
      toast.success("Trajeto sugerido pelo roteador. Ele NÃO é o itinerário oficial: confira no mapa.");
    } catch (e) {
      setRouteFailed(true);
      toast.error(e instanceof ImportError ? e.message : "Roteamento indisponível.");
    } finally {
      setProgress(null);
      setBusy(false);
      abortRef.current = null;
    }
  };

  const useStraight = () => {
    const pts = stopPoints();
    if (!pts) return;
    applyRoute(straightLine(pts), "reta");
    toast.message("Paradas ligadas em linha reta (provisório). Ajuste o traçado no editor de rotas.");
  };

  const clearGeometry = () => {
    mutate((c) => ({ ...c, geometry: [], segments: [], kind: "nenhuma", stale: false }), true);
    setSnapWarn([]);
  };

  /* ------------------------------ revisão: alertas ------------------------------ */
  const issues = useMemo<RowIssue[]>(() => {
    if (!cur) return [];
    const out: RowIssue[] = [...validateMeta({ code, name, direction }), ...validateStops(cur.stops)];
    if (cur.stale)
      out.push({ row: null, field: "traçado", level: "erro", message: "O traçado está desatualizado: as paradas mudaram. Recalcule o trajeto ou remova o traçado." });
    else if (cur.kind === "nenhuma")
      out.push({ row: null, field: "traçado", level: "aviso", message: "Sem traçado: a rota só poderá ser publicada depois de ter um traçado (mínimo de 2 pontos)." });
    else if (cur.kind === "reta")
      out.push({ row: null, field: "traçado", level: "aviso", message: "Traçado provisório em linha reta entre as paradas — ajuste-o no editor de rotas." });
    else if (cur.kind === "osrm" || cur.kind === "mista")
      out.push({ row: null, field: "traçado", level: "info", message: "Há trechos calculados pelo roteador (sugestão pelas vias, tracejados no mapa); não são o itinerário oficial." });
    if (!cur.stale)
      snapWarn.forEach((w) =>
        out.push({ row: null, stopId: w.stopId, field: "traçado", level: "aviso", message: `Parada ${w.index + 1} está a ${Math.round(w.d)} m da via mais próxima — o trecho pode estar impreciso.` }),
      );
    if (source === "moovit_manual")
      out.push({ row: null, field: "fonte", level: "info", message: "Fonte informada: Moovit (conferência manual). Confirme que o uso desses dados respeita os termos do Moovit." });
    return out;
  }, [cur, code, name, direction, snapWarn, source]);

  const errors = issues.filter((i) => i.level === "erro");
  const warnings = issues.filter((i) => i.level === "aviso");
  const metaSig = JSON.stringify([lineCode, code, name, direction, operator, description, color, source, sourceUrl, reviewed]);
  const dirty = !saved || saved.snap !== cur || saved.sig !== metaSig;

  /* ------------------------------ salvar e publicar ------------------------------ */
  const save = async (forceReplace = false) => {
    if (!cur) return;
    if (errors.length > 0) {
      toast.error("Corrija os erros antes de salvar o rascunho.");
      return;
    }
    setBusy(true);
    try {
      const payload = buildPayload({
        lineCode,
        code,
        name,
        direction,
        operator,
        description,
        color,
        source,
        sourceUrl,
        stops: cur.stops,
        geometry: cur.geometry,
        geometryKind: cur.kind,
        segments: cur.segments,
        issues,
        reviewed,
        replace: forceReplace || saved !== null,
      });
      const { data, error } = await supabase.rpc("admin_save_route_import", { p: payload as unknown as Json });
      if (error) {
        if (error.message.includes("IMPORT_EXISTS")) {
          if (confirm("Já existe uma importação desta linha e sentido. Atualizar o rascunho existente com estes dados?")) {
            setBusy(false);
            await save(true);
          }
          return;
        }
        toast.error(saveErrorText(error.message));
        return;
      }
      const r = data as { route_id: string; created: boolean };
      setSaved({ routeId: r.route_id, snap: cur, sig: metaSig });
      onSaved();
      toast.success(r.created ? "Rascunho criado (privado)." : "Rascunho atualizado (privado).");
    } catch (e) {
      toast.error(e instanceof ImportError ? e.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!saved || dirty) return;
    if (!reviewed) {
      toast.error("Marque a confirmação de revisão antes de publicar.");
      return;
    }
    if (!confirm(`Publicar a rota ${code}? Ela passará a aparecer no mapa público.`)) return;
    setBusy(true);
    const { error } = await supabase.from("routes").update({ status: "published" }).eq("id", saved.routeId);
    if (error) {
      setBusy(false);
      toast.error(
        error.message.includes("pelo menos 2 pontos")
          ? "A rota precisa de um traçado com pelo menos 2 pontos para ser publicada."
          : error.message,
      );
      return;
    }
    await supabase.from("route_imports").update({ validation: "revisado" }).eq("route_id", saved.routeId);
    setBusy(false);
    setPublished(true);
    onSaved();
    toast.success("Rota publicada.");
  };

  /* ------------------------------ telas ------------------------------ */
  const back = () => {
    abortRef.current?.abort();
    if (step === "origem") onClose();
    else setStep("origem");
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={back}>
          <ArrowLeft /> {step === "origem" ? "Voltar às rotas" : "Voltar à origem dos dados"}
        </Button>
        <h2 className="text-lg font-bold">Importar rota</h2>
      </div>

      {step === "origem" && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as "assistido" | "arquivo")}>
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="assistido">Por linha (lista de paradas)</TabsTrigger>
            <TabsTrigger value="arquivo">Por arquivo</TabsTrigger>
          </TabsList>

          <TabsContent value="assistido" className="space-y-3">
            <div className="rounded-xl border bg-card p-3 text-sm">
              <p>
                Informe a linha e cole a lista de paradas na ordem do itinerário. O BusMap geocodifica as paradas
                sem coordenada, sugere o trajeto pelas vias e deixa tudo como <b>rascunho privado</b> para revisão.
              </p>
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer font-semibold">Por que o BusMap não lê o Moovit automaticamente?</summary>
                <p className="mt-1">
                  Os Termos de Serviço do Moovit proíbem robôs e ferramentas automáticas de coleta de dados e a criação
                  de bases a partir do conteúdo do serviço. Por isso esta ferramenta nunca acessa o Moovit. Cole apenas
                  listas de paradas que você tem permissão para usar (órgão de trânsito do município, levantamento
                  próprio, OpenStreetMap…). Se usar o Moovit como referência, confirme que o uso respeita os termos dele.
                  Nada é inventado: paradas sem coordenada ficam marcadas até você resolver.
                </p>
              </details>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Número/código da linha *</Label>
                <Input value={lineCode} onChange={(e) => setLineCode(e.target.value)} maxLength={20} placeholder="ex.: 101" />
              </div>
              <div>
                <Label>Nome da linha</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              </div>
              <div>
                <Label>Sentido</Label>
                <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {DIRECTIONS.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Operador (opcional)</Label>
                <Input value={operator} onChange={(e) => setOperator(e.target.value)} maxLength={120} />
              </div>
              <div>
                <Label>Fonte da lista</Label>
                <select value={source} onChange={(e) => setSource(e.target.value as SourceKind)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {ASSISTED_SOURCES.map((s) => (
                    <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>URL de referência (opcional)</Label>
                <Input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} maxLength={500} placeholder="https://…" />
              </div>
            </div>
            <div>
              <Label>Lista de paradas (uma por linha, na ordem)</Label>
              <Textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={10}
                placeholder={"Uma parada por linha.\nOpcional: nome | latitude, longitude"}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Máximo de {LIMITS.stops} paradas. Endereços com número (ex.: “Rua X, 108”) são lidos como nome, não como coordenada.
              </p>
            </div>
            <Button onClick={startAssisted}>Continuar para a revisão</Button>
          </TabsContent>

          <TabsContent value="arquivo" className="space-y-3">
            <div className="rounded-xl border bg-card p-3 text-sm">
              <p>
                Envie CSV, XLSX, GeoJSON ou GTFS (.zip). Até {Math.round(LIMITS.fileBytes / 1048576)} MB
                (GTFS: {Math.round(LIMITS.gtfsBytes / 1048576)} MB). O arquivo é lido no seu navegador e nada é salvo antes da revisão.
              </p>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                <li>CSV/XLSX: uma linha por parada; você escolhe quais colunas são nome, latitude, longitude etc.</li>
                <li>GeoJSON: pontos = paradas (propriedade name), linha = traçado.</li>
                <li>GTFS: routes, trips, stops, stop_times e (opcional) shapes.</li>
              </ul>
              <Button variant="outline" size="sm" className="mt-2" onClick={downloadTemplate}>
                <Download /> Baixar modelo CSV
              </Button>
            </div>
            <div>
              <Label>Arquivo</Label>
              <Input
                type="file"
                accept=".csv,.xlsx,.geojson,.json,.zip"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  void onFile(f);
                }}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label>Código da linha (se não houver coluna)</Label>
                <Input value={lineCode} onChange={(e) => setLineCode(e.target.value)} maxLength={20} />
              </div>
              <div>
                <Label>Sentido padrão</Label>
                <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {DIRECTIONS.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Nome da linha (se não houver coluna)</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      )}

      {step === "mapear" && table && (
        <div className="space-y-3">
          <p className="text-sm">
            Arquivo <b>{fileName}</b> · {table.rows.length} linha(s) de dados. Indique o que cada coluna significa:
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {FIELD_ORDER.map((f) => (
              <div key={f}>
                <Label>{FIELD_LABELS[f]}{f === "stop_name" ? " *" : ""}</Label>
                <select
                  value={mapping[f] === undefined ? "" : String(mapping[f])}
                  onChange={(e) => {
                    const m = { ...mapping };
                    if (e.target.value === "") delete m[f];
                    else m[f] = Number(e.target.value);
                    setMapping(m);
                  }}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">— não usar —</option>
                  {table.headers.map((h, i) => (
                    <option key={i} value={i}>{h || `(coluna ${i + 1})`}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border text-xs">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>{table.headers.map((h, i) => <th key={i} className="px-2 py-1 text-left">{h}</th>)}</tr>
              </thead>
              <tbody>
                {table.rows.slice(0, 5).map((r, i) => (
                  <tr key={i} className="border-t">{r.map((c, j) => <td key={j} className="px-2 py-1">{c}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2">
            <Button onClick={validateMapping}>Validar e continuar</Button>
            <Button variant="ghost" onClick={() => setStep("origem")}>Cancelar importação</Button>
          </div>
          {groups.length > 1 && (
            <div className="space-y-2 rounded-xl border bg-card p-3">
              <p className="text-sm font-semibold">O arquivo tem mais de uma linha/sentido. Escolha qual revisar agora:</p>
              {groups.map((g) => (
                <div key={g.key} className="flex items-center justify-between gap-2 text-sm">
                  <span>{g.code || "(sem código)"} · {g.direction} · {g.stops.length} parada(s){g.name ? ` · ${g.name}` : ""}</span>
                  <Button size="sm" onClick={() => pickGroup(g, fileIssues)}>Revisar esta</Button>
                </div>
              ))}
            </div>
          )}
          <IssueTable issues={fileIssues} title="Erros e avisos por linha do arquivo" />
        </div>
      )}

      {step === "gtfs" && (
        <div className="space-y-3">
          <p className="text-sm">GTFS <b>{fileName}</b>: escolha a linha e o sentido.</p>
          <select value={gtfsPick} onChange={(e) => setGtfsPick(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            {gtfsOptions.map((o, i) => (
              <option key={i} value={i}>{o.label}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <Button onClick={useGtfs} disabled={busy}>Usar esta linha</Button>
            <Button variant="ghost" onClick={() => setStep("origem")}>Cancelar importação</Button>
          </div>
        </div>
      )}

      {step === "revisar" && cur && (
        <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
          <div className="space-y-3">
            {saved && (
              <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-3 text-sm">
                <p className="font-semibold">
                  {published ? "Rota publicada no mapa." : "Rascunho salvo (privado — não aparece no mapa)."}
                </p>
                {dirty && !published && (
                  <p className="text-xs text-warn">Há alterações não salvas. Salve o rascunho antes de publicar.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => onOpenEditor(saved.routeId)}>
                    Abrir no editor de rotas
                  </Button>
                  {!published && (
                    <Button size="sm" variant="live" disabled={busy || dirty || !reviewed} onClick={publish}>
                      Publicar…
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={onClose}>Concluir</Button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Linha (número)</Label>
                <Input value={lineCode} onChange={(e) => setLineCode(e.target.value)} maxLength={20} disabled={saved !== null} />
              </div>
              <div>
                <Label>Código no BusMap</Label>
                <Input
                  value={code}
                  onChange={(e) => {
                    setCodeTouched(true);
                    setCode(e.target.value);
                  }}
                  maxLength={20}
                />
              </div>
              <div className="col-span-2">
                <Label>Nome</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              </div>
              <div>
                <Label>Sentido</Label>
                <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)} disabled={saved !== null} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {DIRECTIONS.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Cor</Label>
                <Input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 p-1" />
              </div>
              <div>
                <Label>Operador</Label>
                <Input value={operator} onChange={(e) => setOperator(e.target.value)} maxLength={120} />
              </div>
              <div>
                <Label>Fonte</Label>
                <select value={source} onChange={(e) => setSource(e.target.value as SourceKind)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {(Object.keys(SOURCE_LABELS) as SourceKind[]).map((s) => (
                    <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <Label>URL de origem (opcional)</Label>
                <Input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} maxLength={500} placeholder="https://…" />
              </div>
              <div className="col-span-2">
                <Label>Descrição</Label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={2} />
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" disabled={hist.i <= 0} onClick={undo} aria-label="Desfazer"><Undo2 /></Button>
              <Button size="sm" variant="outline" disabled={hist.i >= hist.list.length - 1} onClick={redo} aria-label="Refazer"><Redo2 /></Button>
              <Button size="sm" variant={addMode ? "default" : "outline"} onClick={() => setAddMode((v) => !v)}>
                <Crosshair /> {addMode ? "Clique no mapa…" : "Adicionar parada"}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void geocode()}>
                <Search /> Geocodificar pendentes
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void calcRoute()}>
                <RouteIcon /> Sugerir trajeto pelas vias
              </Button>
              {routeFailed && (
                <Button size="sm" variant="outline" onClick={useStraight}>Ligar em linha reta (provisório)</Button>
              )}
              {cur.kind !== "nenhuma" && (
                <Button size="sm" variant="ghost" onClick={clearGeometry}><Trash2 /> Remover traçado</Button>
              )}
              {busy && abortRef.current && (
                <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>Cancelar</Button>
              )}
            </div>
            {progress && <p className="text-xs text-muted-foreground">{progress}</p>}
            <p className="text-sm">
              {cur.stops.length} paradas · traçado: <b>{cur.kind === "nenhuma" ? "nenhum" : cur.kind === "fonte" ? "da fonte" : cur.kind === "osrm" ? "calculado (OSRM)" : cur.kind === "reta" ? "linha reta provisória" : "misto"}</b> ·{" "}
              distância <b>{cur.geometry.length >= 2 ? formatDistance(pathLength(cur.geometry)) : "—"}</b>
            </p>
            <p className="text-[11px] text-muted-foreground">
              Geocodificação e mapa: © OpenStreetMap contributors (Nominatim). Trajeto sugerido: OSRM (servidor público de demonstração).
            </p>

            <IssueTable issues={issues} title={`Alertas (${errors.length} erro(s), ${warnings.length} aviso(s))`} open={errors.length > 0} />
            <IssueTable issues={fileIssues} title="Erros e avisos por linha da origem" />

            <ul className="max-h-[42vh] space-y-1.5 overflow-y-auto pr-1">
              {cur.stops.map((s, i) => (
                <li key={s.id} onClick={() => setSelectedId(s.id)} className={`rounded-lg border p-2 text-xs ${s.id === selectedId ? "border-primary bg-primary/5" : ""}`}>
                  <div className="flex items-center gap-1.5">
                    <span className="grid size-6 shrink-0 place-items-center rounded-full border-2 text-[11px] font-bold" style={{ borderColor: COORD_COLORS[s.coord] }}>
                      {i + 1}
                    </span>
                    <Input className="h-8 flex-1 text-xs" value={s.name} maxLength={200} onChange={(e) => updateName(s.id, e.target.value)} />
                    <Button size="icon" variant="ghost" className="size-7" disabled={i === 0} aria-label="Subir" onClick={(e) => { e.stopPropagation(); moveStop(s.id, -1); }}><ArrowUp /></Button>
                    <Button size="icon" variant="ghost" className="size-7" disabled={i === cur.stops.length - 1} aria-label="Descer" onClick={(e) => { e.stopPropagation(); moveStop(s.id, 1); }}><ArrowDown /></Button>
                    <Button size="icon" variant="ghost" className="size-7" aria-label="Excluir parada" onClick={(e) => { e.stopPropagation(); deleteStop(s.id); }}><Trash2 /></Button>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Input key={`${s.id}-lat-${s.lat}`} className="h-7 w-24 text-xs" inputMode="decimal" placeholder="latitude" defaultValue={s.lat ?? ""} onClick={(e) => e.stopPropagation()} onBlur={(e) => { if (e.currentTarget.value !== String(s.lat ?? "")) coordText(s.id, "lat", e.currentTarget.value); }} />
                    <Input key={`${s.id}-lng-${s.lng}`} className="h-7 w-24 text-xs" inputMode="decimal" placeholder="longitude" defaultValue={s.lng ?? ""} onClick={(e) => e.stopPropagation()} onBlur={(e) => { if (e.currentTarget.value !== String(s.lng ?? "")) coordText(s.id, "lng", e.currentTarget.value); }} />
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{ background: COORD_COLORS[s.coord] }}>
                      {COORD_LABELS[s.coord]}
                    </span>
                    {(s.coord === "ausente" || s.coord === "geocodificada_incerta") && (
                      <Button size="icon" variant="ghost" className="size-7" disabled={busy} title="Geocodificar esta parada" aria-label="Geocodificar" onClick={(e) => { e.stopPropagation(); void geocode([s.id]); }}>
                        <Search />
                      </Button>
                    )}
                  </div>
                  {s.note && <p className="mt-1 text-[11px] text-muted-foreground">{s.note}</p>}
                </li>
              ))}
            </ul>

            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
              <span>Revisei as paradas, as coordenadas e o traçado no mapa e entendo que trechos calculados são sugestões do roteador.</span>
            </label>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={busy || errors.length > 0} onClick={() => void save()}>
                {saved ? "Atualizar rascunho" : "Salvar rascunho"}
              </Button>
              <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            </div>
            {errors.length > 0 && (
              <p className="flex items-center gap-1 text-xs text-destructive"><TriangleAlert className="size-3.5" /> Corrija os erros para salvar.</p>
            )}
          </div>

          <div className="h-[70vh] min-h-[380px] overflow-hidden rounded-xl border lg:sticky lg:top-4">
            <ClientOnly fallback={<div className="h-full bg-muted" />}>
              <Suspense fallback={<div className="h-full bg-muted" />}>
                <ImportMap
                  stops={cur.stops}
                  geometry={cur.geometry}
                  segments={cur.segments}
                  color={color}
                  selectedId={selectedId}
                  addMode={addMode}
                  fitKey={fitKey}
                  onSelect={setSelectedId}
                  onMoveStop={(id, lat, lng) => setCoord(id, { lat, lng })}
                  onAddStop={addStopAt}
                />
              </Suspense>
            </ClientOnly>
          </div>
        </div>
      )}
    </div>
  );
}

function IssueTable({ issues, title, open = false }: { issues: RowIssue[]; title: string; open?: boolean }) {
  if (issues.length === 0) return null;
  const color = { erro: "text-destructive", aviso: "text-warn", info: "text-muted-foreground" } as const;
  const sorted = [...issues].sort((a, b) => ({ erro: 0, aviso: 1, info: 2 })[a.level] - ({ erro: 0, aviso: 1, info: 2 })[b.level]);
  return (
    <details open={open} className="rounded-xl border bg-card text-xs">
      <summary className="cursor-pointer px-3 py-2 font-semibold">{title}</summary>
      <ul className="max-h-48 space-y-1 overflow-y-auto px-3 pb-2">
        {sorted.slice(0, 200).map((i, k) => (
          <li key={k} className={color[i.level]}>
            {i.row !== null ? `Linha ${i.row} · ` : ""}
            {i.message}
          </li>
        ))}
        {sorted.length > 200 && <li className="text-muted-foreground">… e mais {sorted.length - 200}.</li>}
      </ul>
    </details>
  );
}
