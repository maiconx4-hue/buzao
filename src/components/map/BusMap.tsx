import { useEffect, useRef, useState } from "react";
import { Crosshair } from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MACAPA_CENTER, isLatLngArray, type LatLng } from "@/lib/geo";
import type { GroupState } from "@/lib/freshness";

const BUS_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/></svg>';

export type MapRoute = { id: string; code: string; color: string; geometry: unknown };
export type MapGroup = {
  id: string;
  route_id: string;
  lat: number;
  lng: number;
  accuracy_m: number;
  state: GroupState;
  code: string;
  color: string;
};

type Props = {
  routes: MapRoute[];
  groups: MapGroup[];
  selectedRouteId: string | null;
  userPos: LatLng | null;
  focus: { pos: LatLng; zoom: number; key: number } | null;
  followId?: string | null;
  onSelectGroup: (id: string) => void;
  onSelectRoute: (id: string) => void;
  fitRoute?: { id: string; key: number } | null;
  onMapClick?: () => void;
  /** Linha a desenhar mesmo sem filtro de linha (ex.: ao seguir um ônibus). */
  lineRouteId?: string | null;
  /** Áreas cobertas por painéis (px): o mapa centraliza o ônibus na parte visível. */
  insets?: { top: number; bottom: number };
};

export default function BusMap({
  routes,
  groups,
  selectedRouteId,
  userPos,
  focus,
  followId = null,
  onSelectGroup,
  onSelectRoute,
  fitRoute = null,
  onMapClick,
  lineRouteId = null,
  insets,
}: Props) {
  const topInset = insets?.top ?? 0;
  const bottomInset = insets?.bottom ?? 0;
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const routeLayer = useRef<L.LayerGroup | null>(null);
  const groupLayer = useRef<L.LayerGroup | null>(null);
  const meLayer = useRef<L.LayerGroup | null>(null);
  const cb = useRef({ onSelectGroup, onSelectRoute, onMapClick });
  cb.current = { onSelectGroup, onSelectRoute, onMapClick };

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: false, attributionControl: true }).setView(
      MACAPA_CENTER,
      13,
    );
   
    const street = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",  {
      maxZoom: 20,
      subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(m);

    const satellite = L.layerGroup([
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, maxNativeZoom: 18, attribution: "Imagens &copy; Esri, Maxar, Earthstar Geographics" },
      ),
      L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, maxNativeZoom: 18 },
      ),
    ]);
    L.control
      .layers({ Mapa: street, "Satélite": satellite }, undefined, { position: "bottomright" })
      .addTo(m);
    L.control.zoom({ position: "bottomright" }).addTo(m);
    routeLayer.current = L.layerGroup().addTo(m);
    groupLayer.current = L.layerGroup().addTo(m);
    meLayer.current = L.layerGroup().addTo(m);
    m.on("click", () => cb.current.onMapClick?.());
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const layer = routeLayer.current;
    if (!layer) return;
    layer.clearLayers();
    // A linha aparece quando o usuário escolhe uma linha ou segue um ônibus dela.
    const activeLineId = lineRouteId ?? selectedRouteId;
    routes.forEach((r) => {
      if (r.id !== activeLineId) return;
      if (!isLatLngArray(r.geometry) || r.geometry.length < 2) return;
      L.polyline(r.geometry, { color: r.color, weight: 6, opacity: 0.85 })
        .on("click", () => cb.current.onSelectRoute(r.id))
        .addTo(layer);
    });
  }, [routes, selectedRouteId, lineRouteId]);

  useEffect(() => {
    const layer = groupLayer.current;
    if (!layer) return;
    layer.clearLayers();
    groups.forEach((g) => {
      if (g.state === "expirado") return;
      if (selectedRouteId && g.route_id !== selectedRouteId) return;
      const live = g.state === "ativo";
      if (live && g.accuracy_m > 0)
        L.circle([g.lat, g.lng], {
          radius: g.accuracy_m,
          color: g.color,
          weight: 1,
          fillOpacity: 0.08,
        }).addTo(layer);
      L.marker([g.lat, g.lng], {
        icon: L.divIcon({
          className: "",
          html: `<div class="bus-marker ${live ? "live" : "stale"}" style="--route:${g.color}">${BUS_SVG}<span class="bus-code">${g.code.slice(0, 4)}</span></div>`,
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        }),
        title: live ? "Posição colaborativa ativa" : "Última posição conhecida (desatualizada)",
      })
        .on("click", () => cb.current.onSelectGroup(g.id))
        .addTo(layer);
    });
  }, [groups, selectedRouteId]);

  useEffect(() => {
    const layer = meLayer.current;
    if (!layer) return;
    layer.clearLayers();
    if (userPos)
      L.marker(userPos, {
        icon: L.divIcon({
          className: "",
          html: '<div class="me-marker"></div>',
          iconSize: [16, 16],
        }),
      }).addTo(layer);
  }, [userPos]);

  useEffect(() => {
    if (focus && map.current) map.current.flyTo(focus.pos, focus.zoom, { duration: 0.8 });
  }, [focus]);

  useEffect(() => {
    if (!fitRoute || !map.current) return;
    const r = routes.find((x) => x.id === fitRoute.id);
    if (r && isLatLngArray(r.geometry) && r.geometry.length >= 2)
      map.current.flyToBounds(
        L.latLngBounds(r.geometry),
        insets
          ? {
              paddingTopLeft: [40, topInset + 16],
              paddingBottomRight: [40, bottomInset + 16],
              duration: 0.8,
            }
          : { padding: [40, 140], duration: 0.8 },
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRoute]);

  // Follow mode: keep the followed bus centered; a user drag pauses it.
  const [paused, setPaused] = useState(false);
  const followed = followId ? groups.find((g) => g.id === followId) ?? null : null;
  useEffect(() => setPaused(false), [followId]);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const onDrag = () => setPaused(true);
    m.on("dragstart", onDrag);
    return () => {
      m.off("dragstart", onDrag);
    };
  }, []);
  const lat = followed?.lat;
  const lng = followed?.lng;
  // Deslocamento vertical para o ônibus ficar na parte visível (entre o topo e o painel de baixo).
  const offsetY = Math.round((bottomInset - topInset) / 2);
  useEffect(() => {
    const m = map.current;
    if (!m || paused || lat == null || lng == null) return;
    const zoom = Math.max(m.getZoom(), 16);
    const limit = m.getSize().y / 3;
    const dy = Math.max(-limit, Math.min(limit, offsetY));
    const p = m.project([lat, lng], zoom);
    const target = m.unproject(L.point(p.x, p.y + dy), zoom);
    if (zoom !== m.getZoom()) m.setView(target, zoom, { animate: true });
    else m.panTo(target, { animate: true, duration: 0.8 });
  }, [lat, lng, paused, offsetY]);

  const lineId = lineRouteId ?? selectedRouteId;
  const lineRoute = lineId ? routes.find((x) => x.id === lineId) : undefined;
  const lineGeometry =
    lineRoute && isLatLngArray(lineRoute.geometry) && lineRoute.geometry.length >= 2
      ? lineRoute.geometry
      : null;
  const showWholeRoute = () => {
    const m = map.current;
    if (!m || !lineGeometry) return;
    setPaused(true);
    m.flyToBounds(L.latLngBounds(lineGeometry), {
      paddingTopLeft: [40, topInset + 16],
      paddingBottomRight: [40, bottomInset + 16],
      duration: 0.8,
    });
  };

  return (
    <>
      <div ref={el} className="absolute inset-0 z-0" aria-label="Mapa de Macapá" />
      {followed && paused && (
        <button
          type="button"
          onClick={() => setPaused(false)}
          className="absolute left-1/2 top-28 z-[500] flex -translate-x-1/2 items-center gap-2 rounded-full border border-primary bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-lg"
        >
          <Crosshair className="size-4" /> Seguir ônibus {followed.code}
        </button>
      )}
      {followed && !paused && (
        <div className="absolute left-1/2 top-28 z-[500] flex -translate-x-1/2 items-center gap-2">
          <span className="pointer-events-none rounded-full bg-card/95 px-3 py-1 text-xs font-semibold text-foreground shadow">
            Seguindo ônibus {followed.code}
          </span>
          {lineGeometry && (
            <button
              type="button"
              onClick={showWholeRoute}
              className="rounded-full bg-card/95 px-3 py-1 text-xs font-semibold text-primary shadow"
            >
              Ver linha toda
            </button>
          )}
        </div>
      )}
    </>
  );
}
