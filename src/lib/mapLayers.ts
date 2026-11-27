import L from "leaflet";

if (typeof window !== "undefined") {
  (window as any).L = L;
}
// @ts-expect-error Import direto do arquivo ESM para contornar o bug de 'this.L' no Vite
import GoogleMutant from "leaflet.gridlayer.googlemutant/src/Leaflet.GoogleMutant.mjs";

export function loadGoogleMaps(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return resolve();
    if ((window as any).google?.maps) return resolve();

    const existing = document.getElementById("google-maps-api-script");
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject());
      return;
    }

    const script = document.createElement("script");
    script.id = "google-maps-api-script";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&loading=async`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = (err) => reject(err);
    document.head.appendChild(script);
  });
}

export function createBaseLayers(m: L.Map) {
  const hasGoogle = Boolean((window as any).google?.maps);

  const street = hasGoogle
    ? new (GoogleMutant as any)({
        type: "roadmap",
        maxZoom: 20,
      }).addTo(m)
    : L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(m);

  const satellite = hasGoogle
    ? new (GoogleMutant as any)({
        type: "hybrid",
        maxZoom: 20,
      })
    : L.layerGroup([
        L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 19,
            maxNativeZoom: 18,
            attribution: "Imagens &copy; Esri, Maxar",
          },
        ),
        L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
          {
            maxZoom: 19,
            maxNativeZoom: 18,
          },
        ),
      ]);

  L.control
    .layers(
      {
        Mapa: street,
        Satélite: satellite,
      },
      undefined,
      { position: "bottomright" },
    )
    .addTo(m);

  return { street, satellite };
}
