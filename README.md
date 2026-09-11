# Helsinki City Bikes — live map

A single-page web map of every HSL city bike station in Helsinki and Espoo,
with live bike counts, your position, and a walking route to the nearest bike.

**Live:** https://uenian33.github.io/city-bike-map/

## Features

- Every station is a pin; the number on the pin is the bikes available right
  now (green: plenty, amber: ≤3, grey: none / closed). Zoom out to see all
  456 stations at once, zoom in for full-size pins.
- **My location** button shows your position and accuracy.
- **Nearest bike** finds the closest station that actually has a bike and
  draws a walking route with turn-by-turn steps and an ETA.
- Tap any pin (or search by name) for bikes, free docks, capacity, distance,
  directions, and an "Open in Maps" hand-off (Apple Maps on Apple devices,
  Google Maps elsewhere).
- Refreshes every 60 s and whenever the tab becomes visible again.
- Responsive: side panel on desktop and tablet, bottom sheet on phones.
  Follows the system light/dark theme.

## Stack

No build step — three static files.

| Concern | Source |
|---|---|
| Station data | HSL GBFS 2.2 feed (`gbfs.theta.fifteen.eu`), CORS-enabled, no key |
| Base map | [OpenFreeMap](https://openfreemap.org) vector tiles (`positron` / `dark`), rendered with MapLibre GL JS |
| Walking routes | [Valhalla](https://valhalla1.openstreetmap.de) pedestrian profile; public OSRM as a geometry fallback |

## Develop

Any static file server works, e.g.

```bash
npx -y serve -l 8765 .
```

Geolocation requires `https://` or `localhost`.

## Deploy

The site is served by GitHub Pages straight from the `main` branch root.
Push to `main` and it is live within a minute.
