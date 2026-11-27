import { loadGoogleMaps, createBaseLayers } from "@/lib/mapLayers";
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MACAPA_CENTER, type LatLng } from "@/lib/geo";

export type EditorMode = "draw" | "origin" | "dest" | "view";

/** Parada de uma rota importada, arrastável no editor. */
export type EditorStop = { lat: number; lng: number; name: string; coord: string };

const STOP_COLORS: Record<string, string> = {
  fonte: "#16a34a",
  geocodificada: "#f59e0b",
  geocodificada_incerta: "#dc2626",
  manual: "#2563eb",
};

type Props = {
  points: LatLng[];
  color: string;
  mode: EditorMode;
  origin: LatLng | null;
  dest: LatLng | null;
  onMapClick: (p: LatLng) => void;
  onMovePoint: (i: number, p: LatLng) => void;
  onDeletePoint: (i: number) => void;
  stops?: EditorStop[] | undefined;
  onMoveStop?: ((i: number, p: LatLng) => void) | undefined;
};

export default function EditorMap({
  points,
  color,
  mode,
  origin,
  dest,
  onMapClick,
  onMovePoint,
  onDeletePoint,
  stops,
  onMoveStop,
}: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const cb = useRef({ onMapClick, onMovePoint, onDeletePoint, onMoveStop });
  cb.current = { onMapClick, onMovePoint, onDeletePoint, onMoveStop };
  const fitted = useRef(false);

    useEffect(() => {
    if (!el.current || map.current) return;

    let isMounted = true;
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

    const initMap = () => {
      if (!isMounted || !el.current || map.current) return;

      const m = L.map(el.current).setView(MACAPA_CENTER, 13);
      createBaseLayers(m);

      layer.current = L.layerGroup().addTo(m);

      m.on("click", (e: L.LeafletMouseEvent) => {
        onMapClickRef.current?.([e.latlng.lat, e.latlng.lng]);
      });

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
    if (points.length >= 2) L.polyline(points, { color, weight: 5, opacity: 0.85 }).addTo(lg);
    if (mode === "draw" && points.length <= 400) {
      points.forEach((p, i) => {
        const mk = L.marker(p, {
          draggable: true,
          icon: L.divIcon({
            className: "",
            html: '<div class="edit-point"></div>',
            iconSize: [14, 14],
          }),
          title: `Ponto ${i + 1} — arraste para mover, clique para excluir`,
        });
        mk.on("dragend", () => {
          const ll = mk.getLatLng();
          cb.current.onMovePoint(i, [+ll.lat.toFixed(6), +ll.lng.toFixed(6)]);
        });
        mk.on("click", (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev);
          cb.current.onDeletePoint(i);
        });
        mk.addTo(lg);
      });
    }
    // Paradas da importação: pontos numerados e arrastáveis (a posição vira a coordenada da parada).
    stops?.forEach((st, i) => {
      const c = STOP_COLORS[st.coord] ?? "#6b7280";
      const mk = L.marker([st.lat, st.lng], {
        draggable: true,
        zIndexOffset: 500,
        icon: L.divIcon({
          className: "",
          html: `<div style="width:26px;height:26px;border-radius:9999px;background:#fff;border:3px solid ${c};color:#111;display:grid;place-items:center;font:700 11px/1 system-ui;box-shadow:0 1px 3px rgba(0,0,0,.45)">${i + 1}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
        title: `${i + 1}. ${st.name} — arraste para mover`,
      });
      mk.on("dragend", () => {
        const ll = mk.getLatLng();
        cb.current.onMoveStop?.(i, [+ll.lat.toFixed(6), +ll.lng.toFixed(6)]);
      });
      mk.addTo(lg);
    });
    const pin = (p: LatLng, cls: string) =>
      L.marker(p, {
        icon: L.divIcon({
          className: "",
          html: `<div class="pin-marker ${cls}"></div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 22],
        }),
      }).addTo(lg);
    if (origin) pin(origin, "origin");
    if (dest) pin(dest, "dest");
    const all: LatLng[] = [...points, ...(stops ?? []).map((x) => [x.lat, x.lng] as LatLng)];
    if (!fitted.current && all.length >= 2) {
      m.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
      fitted.current = true;
    }
  }, [points, color, mode, origin, dest, stops]);

  useEffect(() => {
    if (el.current) el.current.style.cursor = mode === "view" ? "" : "crosshair";
  }, [mode]);

  return <div ref={el} className="h-full w-full rounded-xl" />;
}
