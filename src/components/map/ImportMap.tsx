import { loadGoogleMaps, createBaseLayers } from "@/lib/mapLayers";
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MACAPA_CENTER, type LatLng } from "@/lib/geo";
import type { ImportStop, Segment } from "@/lib/routeImport/types";

export const COORD_COLORS: Record<ImportStop["coord"], string> = {
  fonte: "#16a34a",
  geocodificada: "#f59e0b",
  geocodificada_incerta: "#dc2626",
  manual: "#2563eb",
  ausente: "#6b7280",
};

type Props = {
  stops: ImportStop[];
  geometry: LatLng[];
  segments: Segment[];
  color: string;
  selectedId: string | null;
  addMode: boolean;
  fitKey: number;
  onSelect: (id: string | null) => void;
  onMoveStop: (id: string, lat: number, lng: number) => void;
  onAddStop: (lat: number, lng: number) => void;
};

export default function ImportMap({
  stops,
  geometry,
  segments,
  color,
  selectedId,
  addMode,
  fitKey,
  onSelect,
  onMoveStop,
  onAddStop,
}: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const cb = useRef({ onSelect, onMoveStop, onAddStop, addMode });
  cb.current = { onSelect, onMoveStop, onAddStop, addMode };
  const lastFit = useRef<number | null>(null);
  

  useEffect(() => {
    if (!el.current || map.current) return;

    let isMounted = true;
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

    const initMap = () => {
      if (!isMounted || !el.current || map.current) return;

      const m = L.map(el.current).setView(MACAPA_CENTER, 12);
      createBaseLayers(m);

      layer.current = L.layerGroup().addTo(m);
      map.current = m;
    };

    if (apiKey) {
      loadGoogleMaps(apiKey).then(initMap).catch(initMap);
    } else {
      initMap();
    }

    return () => {
      isMounted = false;
      map.current?.remove();
      map.current = null;
    };
  }, []);


  useEffect(() => {
    const lg = layer.current;
    const m = map.current;
    if (!lg || !m) return;
    lg.clearLayers();

    // Traçado: sólido = da fonte; tracejado = calculado pelo roteador; vermelho = linha reta provisória.
    if (geometry.length >= 2) {
      const segs: Segment[] =
        segments.length > 0 ? segments : [{ start: 0, end: geometry.length - 1, kind: "fonte" }];
      segs.forEach((s) => {
        const pts = geometry.slice(s.start, s.end + 1);
        if (pts.length < 2) return;
        const style: L.PolylineOptions =
          s.kind === "fonte"
            ? { color, weight: 5, opacity: 0.85 }
            : s.kind === "osrm"
              ? { color, weight: 5, opacity: 0.8, dashArray: "10 8" }
              : { color: "#dc2626", weight: 4, opacity: 0.9, dashArray: "3 9" };
        L.polyline(pts, style).addTo(lg);
      });
    }

    stops.forEach((s, i) => {
      if (s.lat === null || s.lng === null) return;
      const c = COORD_COLORS[s.coord];
      const sel = s.id === selectedId;
      const size = sel ? 30 : 24;
      const mk = L.marker([s.lat, s.lng], {
        draggable: true,
        zIndexOffset: sel ? 1000 : 0,
        icon: L.divIcon({
          className: "",
          html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:#fff;border:3px solid ${c};color:#111;display:grid;place-items:center;font:700 11px/1 system-ui;box-shadow:${sel ? "0 0 0 3px rgba(0,0,0,.35)" : "0 1px 3px rgba(0,0,0,.45)"}">${i + 1}</div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        }),
        title: `${i + 1}. ${s.name} — arraste para mover`,
      });
      mk.on("click", (ev: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(ev);
        cb.current.onSelect(s.id);
      });
      mk.on("dragend", () => {
        const ll = mk.getLatLng();
        cb.current.onMoveStop(s.id, +ll.lat.toFixed(6), +ll.lng.toFixed(6));
      });
      mk.addTo(lg);
    });

    // Ajusta o zoom na primeira vez e quando fitKey muda
    if (lastFit.current !== fitKey) {
      const all: LatLng[] = [
        ...geometry,
        ...(stops.filter((s) => s.lat !== null && s.lng !== null).map((s) => [s.lat, s.lng]) as LatLng[]),
      ];
      if (all.length >= 1) {
        lastFit.current = fitKey;
        if (all.length === 1) m.setView(all[0]!, 16);
        else m.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
      }
    }
  }, [stops, geometry, segments, color, selectedId, fitKey]);

  useEffect(() => {
    if (el.current) el.current.style.cursor = addMode ? "crosshair" : "";
  }, [addMode]);

  return <div ref={el} className="h-full w-full rounded-xl" />;
}
