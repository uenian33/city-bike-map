# Helsinki City Bikes — live map

A single-page web map of every HSL city bike station in Helsinki and Espoo,
with live bike counts, your position, and a walking route to the nearest bike.

**Live:** https://uenian33.github.io/city-bike-map/

## Features

- Every station is a pin; the number on the pin is the bikes available right
  now (green: plenty, amber: ≤3, grey: none / closed). Zoomed out, all 456
  stations are drawn by the GPU as MapLibre circle/text layers; from zoom 14
  the stations inside the viewport become HTML "glass" pins, added and removed
  as you pan. Nothing off-screen costs anything.
- **My location** button shows your position and accuracy.
- **Nearest bike** finds the closest station that actually has a bike and
  draws a walking route with turn-by-turn steps and an ETA.
- **Search** matches station names and, via Photon (OpenStreetMap), streets,
  addresses and places — typing "emma" suggests EMMA, the Espoo Museum of
  Modern Art. Picking a place drops a pin and lists the nearest stations.
- **Get there by city bike** plans a door-to-door journey to a searched
  destination: walk to the nearest station with a bike, ride to the station
  nearest the destination that has a free dock, walk the rest — three routed
  legs with a total time and a 30-minute warning. If riding would be a detour
  it just gives the walking route.
- Tap any pin (or search by name) for bikes, free docks, capacity, distance,
  directions, and an "Open in Maps" hand-off (Apple Maps on Apple devices,
  Google Maps elsewhere).
- **Ride from here** plans a cycling route between two stations (Valhalla
  bicycle profile tuned for city bikes), shows the ride time against HSL's
  free 30-minute limit, and warns when the destination has no free docks.
- **Map view** switcher: Standard (follows light/dark), Detailed, Satellite
  (Esri World Imagery), Dark. Remembered across visits.
- Refreshes every 60 s and whenever the tab becomes visible again.
- Responsive: side panel on desktop and tablet, bottom sheet on phones that
  you drag between collapsed / half / full and fling down to dismiss.
  Follows the system light/dark theme.

## Performance notes

- Station metadata and the last status are cached in `localStorage`, so a
  revisit paints all pins before the network answers (the chip says
  "updating…" until fresh data lands). Both feeds load in parallel and are
  `preload`ed from the HTML head.
- Zoomed out, stations are GPU layers; zoomed in, only stations inside the
  viewport are HTML pins. Pin repaints are diffed, and the sheet only
  re-renders (and only animates) when its subject changes.
- Glass surfaces use a 16 px blur; the opaque FAB has none; the live dot
  pulses with a composited transform rather than an animated shadow.

## Stack

No build step — three static files.

| Concern | Source |
|---|---|
| Station data | HSL GBFS 2.2 feed (`gbfs.theta.fifteen.eu`), CORS-enabled, no key |
| Base map | [OpenFreeMap](https://openfreemap.org) vector tiles (`positron` / `dark`), rendered with MapLibre GL JS |
| Walking & cycling routes | [Valhalla](https://valhalla1.openstreetmap.de) pedestrian / bicycle profiles; public OSRM as a geometry fallback |
| Address & place search | [Photon](https://photon.komoot.io) (OpenStreetMap), biased to your position and limited to the Helsinki region |
| Satellite view | Esri World Imagery raster tiles |

## Develop

Any static file server works, e.g.

```bash
npx -y serve -l 8765 .
```

Geolocation requires `https://` or `localhost`.

## Deploy

The site is served by GitHub Pages straight from the `main` branch root.
Push to `main` and it is live within a minute.
