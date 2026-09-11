/* Helsinki City Bikes — live station map.
 * Data: HSL GBFS 2.2 feed (CORS-enabled, no key). Routing: Valhalla pedestrian, OSRM fallback.
 */
(() => {
  'use strict';

  const GBFS = 'https://gbfs.theta.fifteen.eu/gbfs/2.2/helsinki/en';
  const OSRM = 'https://router.project-osrm.org/route/v1/foot';
  const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
  const REFRESH_MS = 60_000;
  const HELSINKI = [60.1699, 24.9384];

  const $ = (id) => document.getElementById(id);
  const el = {
    map: $('map'), search: $('search-input'), clear: $('clear-btn'), results: $('results'),
    chip: $('status-chip'), statusText: $('status-text'), liveDot: $('live-dot'),
    sheet: $('sheet'), sheetBody: $('sheet-body'), sheetClose: $('sheet-close'),
    locate: $('locate'), nearest: $('nearest-btn'), fitAll: $('fit-all'),
    zoomIn: $('zoom-in'), zoomOut: $('zoom-out'), about: $('about'), menu: $('menu-btn'),
  };

  // ---------- Map ----------
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const OFM = 'https://tiles.openfreemap.org/styles/';
  const SATELLITE_STYLE = {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      esri: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      },
    },
    layers: [{ id: 'esri', type: 'raster', source: 'esri' }],
  };
  // Map views. 'auto' follows the system theme; the others are explicit.
  const VIEWS = {
    auto: { label: 'Standard', style: () => OFM + (dark.matches ? 'dark' : 'positron'), dark: () => dark.matches },
    detailed: { label: 'Detailed', style: () => OFM + 'liberty', dark: () => false },
    satellite: { label: 'Satellite', style: () => SATELLITE_STYLE, dark: () => true },
    dark: { label: 'Dark', style: () => OFM + 'dark', dark: () => true },
  };
  let view = 'auto';
  try { if (VIEWS[localStorage.getItem('cbm-view')]) view = localStorage.getItem('cbm-view'); } catch {}
  const isDarkMap = () => VIEWS[view].dark();
  const styleUrl = () => VIEWS[view].style();
  const map = new maplibregl.Map({
    container: el.map, style: styleUrl(),
    center: [HELSINKI[1], HELSINKI[0]], zoom: 12.5, minZoom: 9, maxZoom: 19,
    attributionControl: false, pitchWithRotate: false, dragRotate: false, touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: 'Bikes: HSL / Fifteen',
  }), 'bottom-right');
  map.once('load', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));

  const EMPTY = { type: 'FeatureCollection', features: [] };
  let routeGeo = EMPTY, accGeo = EMPTY, stationGeo = EMPTY;
  // Below this zoom stations are drawn by the GPU (circle + text layers); above it the
  // stations inside the viewport become HTML "glass" pins. Both are cheap.
  const PIN_ZOOM = 14;
  const LEVEL_COLOR = ['match', ['get', 'level'], 'ok', '#34c759', 'warn', '#ff9f0a', '#8e8e93'];
  function addOverlays() {
    if (map.getSource('route')) return;
    const isDark = isDarkMap();
    el.map.classList.toggle('map-dark', isDark);
    map.addSource('stations', { type: 'geojson', data: stationGeo });
    map.addLayer({
      id: 'st-circle', type: 'circle', source: 'stations', maxzoom: PIN_ZOOM,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 11, 7, 13, 11, PIN_ZOOM, 13],
        'circle-color': isDark ? '#1e2026' : '#ffffff',
        'circle-stroke-color': LEVEL_COLOR,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 12, 2.5],
        'circle-opacity': 0.95,
        'circle-stroke-color-transition': { duration: 400 },
      },
    });
    map.addLayer({
      id: 'st-selected', type: 'circle', source: 'stations', maxzoom: PIN_ZOOM,
      filter: ['==', ['get', 'id'], selectedId ?? ''],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 8, 11, 12, 13, 17, PIN_ZOOM, 19],
        'circle-color': '#0a84ff', 'circle-opacity': 0.25,
        'circle-radius-transition': { duration: 300 },
      },
    }, 'st-circle');
    map.addLayer({
      id: 'st-count', type: 'symbol', source: 'stations', minzoom: 11, maxzoom: PIN_ZOOM,
      layout: {
        'text-field': ['to-string', ['get', 'bikes']], 'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 8, 13, 11, PIN_ZOOM, 12],
        'text-allow-overlap': true, 'text-ignore-placement': true,
      },
      paint: { 'text-color': ['case', ['==', ['get', 'level'], 'none'], '#8e8e93', isDark ? '#f2f2f7' : '#1c1c1e'] },
    });
    map.addSource('route', { type: 'geojson', data: routeGeo });
    map.addSource('me-acc', { type: 'geojson', data: accGeo });
    map.addLayer({ id: 'me-acc', type: 'fill', source: 'me-acc', paint: { 'fill-color': '#0a84ff', 'fill-opacity': 0.1 } });
    map.addLayer({ id: 'me-acc-line', type: 'line', source: 'me-acc', paint: { 'line-color': '#0a84ff', 'line-opacity': 0.35, 'line-width': 1 } });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': isDark ? '#111318' : '#ffffff', 'line-width': 10, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['match', ['get', 'mode'], 'bike', '#34c759', '#0a84ff'], 'line-width': 6 } });
  }
  map.on('style.load', addOverlays);
  // Layer-scoped handlers are looked up by id at event time, so they survive setStyle().
  map.on('click', 'st-circle', (e) => {
    const f = e.features?.[0]; if (!f) return;
    clickedFeature = true;
    select(String(f.id), false);
  });
  map.on('mouseenter', 'st-circle', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'st-circle', () => { map.getCanvas().style.cursor = ''; });
  function setView(v) {
    if (!VIEWS[v]) return;
    view = v;
    try { localStorage.setItem('cbm-view', v); } catch {}
    map.setStyle(styleUrl(), { diff: false });
    document.querySelectorAll('.view-opt').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    setOpen($('view-menu'), false);
  }
  dark.addEventListener('change', () => { if (view === 'auto') map.setStyle(styleUrl(), { diff: false }); });
  $('layers').addEventListener('click', (e) => { e.stopPropagation(); const m = $('view-menu'); setOpen(m, !m.classList.contains('open')); });
  document.querySelectorAll('.view-opt').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    b.addEventListener('click', () => setView(b.dataset.view));
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#view-menu, #layers')) setOpen($('view-menu'), false); });
  const setRouteNow = (geo) => { routeGeo = geo; map.getSource('route')?.setData(geo); };
  // Routes "draw themselves" onto the map: every line grows from its start over ~700 ms.
  let routeAnim = 0;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function setRoute(geo) {
    cancelAnimationFrame(routeAnim);
    const feats = geo.type === 'FeatureCollection' ? geo.features : geo.type === 'Feature' ? [geo] : [];
    if (!feats.length || reduceMotion.matches) return setRouteNow(geo);
    const total = feats.reduce((n, f) => n + f.geometry.coordinates.length, 0);
    const dur = Math.min(1100, 450 + total * 2), t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const frame = (now) => {
      const k = ease(Math.min(1, (now - t0) / dur));
      setRouteNow({ type: 'FeatureCollection', features: feats.map((f) => {
        const c = f.geometry.coordinates, n = Math.max(2, Math.ceil(c.length * k));
        return { ...f, geometry: { type: 'LineString', coordinates: c.slice(0, n) } };
      }) });
      if (k < 1) routeAnim = requestAnimationFrame(frame); else setRouteNow(geo);
    };
    routeAnim = requestAnimationFrame(frame);
  }
  // Popovers (search results, view menu) animate in and out via a class; `hidden` is set
  // only after the exit transition so the element can actually animate.
  function setOpen(node, open) {
    if (open) {
      node.hidden = false;
      requestAnimationFrame(() => node.classList.add('open'));
    } else if (node.classList.contains('open')) {
      node.classList.remove('open');
      const done = () => { if (!node.classList.contains('open')) node.hidden = true; };
      node.addEventListener('transitionend', done, { once: true });
      setTimeout(done, 260);
    } else node.hidden = true;
  }
  const setAcc = (geo) => { accGeo = geo; map.getSource('me-acc')?.setData(geo); };
  let clickedFeature = false;
  const setSelectedLayer = () => { if (map.getLayer('st-selected')) map.setFilter('st-selected', ['==', ['get', 'id'], selectedId ?? '']); };

  let meMarker = null, me = null; // me = {lat, lon, acc}

  const zoomClass = () => el.map.classList.toggle('zoom-mid', map.getZoom() < 15.5);
  map.on('zoom', zoomClass);
  zoomClass();

  function circlePolygon(lat, lon, radiusM, n = 48) {
    const coords = [];
    const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 2 * Math.PI;
      coords.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } };
  }

  // ---------- Stations ----------
  const stations = new Map(); // id -> {id,name,lat,lon,capacity,bikes,docks,renting,marker}
  let selectedId = null;

  const level = (s) => (!s.renting || s.bikes === 0) ? 'none' : s.bikes <= 3 ? 'warn' : 'ok';
  function paintPin(s) {
    if (!s.el) return;
    const d = s.el;
    d.className = `station-pin ${level(s)}${s.id === selectedId ? ' selected' : ''}`;
    d.textContent = s.bikes;
    d.title = s.name;
    s.marker.getElement().style.zIndex = s.id === selectedId ? 1000 : level(s) === 'none' ? 0 : 1;
  }
  function esc(str) { return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  async function loadInfo() {
    const r = await fetch(`${GBFS}/station_information.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`station_information ${r.status}`);
    const { data } = await r.json();
    for (const st of data.stations) {
      stations.set(st.station_id, {
        id: st.station_id, name: st.name, lat: st.lat, lon: st.lon, capacity: st.capacity ?? 0,
        bikes: 0, docks: 0, renting: true, marker: null, el: null,
      });
    }
  }
  async function loadStatus() {
    const r = await fetch(`${GBFS}/station_status.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`station_status ${r.status}`);
    const { data, last_updated } = await r.json();
    for (const st of data.stations) {
      const s = stations.get(st.station_id);
      if (!s) continue;
      s.bikes = st.num_bikes_available ?? 0;
      s.docks = st.num_docks_available ?? 0;
      s.renting = st.is_installed !== false && st.is_renting !== false;
    }
    return last_updated ? new Date(last_updated * 1000) : new Date();
  }
  function renderStations() {
    stationGeo = {
      type: 'FeatureCollection',
      features: [...stations.values()].map((s) => ({
        type: 'Feature', id: s.id,
        properties: { id: s.id, bikes: s.bikes, level: level(s) },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    };
    map.getSource('stations')?.setData(stationGeo);
    syncPins();
  }
  // Keep HTML pins only for stations inside the (padded) viewport, and only when zoomed in.
  const visible = new Set();
  function syncPins() {
    const z = map.getZoom();
    const b = z >= PIN_ZOOM ? map.getBounds() : null;
    const pad = b ? (b.getEast() - b.getWest()) * 0.15 : 0;
    for (const s of stations.values()) {
      const show = b && s.lon > b.getWest() - pad && s.lon < b.getEast() + pad
        && s.lat > b.getSouth() - pad / 2 && s.lat < b.getNorth() + pad / 2;
      if (show) {
        if (!s.marker) {
          const wrap = document.createElement('div');
          wrap.className = 'pin-wrap';
          s.el = document.createElement('div');
          wrap.appendChild(s.el);
          wrap.addEventListener('click', (e) => { e.stopPropagation(); select(s.id, false); });
          s.marker = new maplibregl.Marker({ element: wrap, anchor: 'bottom' }).setLngLat([s.lon, s.lat]);
        }
        if (!visible.has(s.id)) {
          s.marker.addTo(map); visible.add(s.id);
          const w = s.marker.getElement(); w.classList.remove('pop'); void w.offsetWidth; w.classList.add('pop');
        }
        paintPin(s);
      } else if (visible.has(s.id)) { s.marker.remove(); visible.delete(s.id); }
    }
  }
  map.on('moveend', syncPins);
  function totals() {
    let bikes = 0, n = 0;
    for (const s of stations.values()) { bikes += s.bikes; n++; }
    return { bikes, n };
  }
  async function refresh(initial = false) {
    try {
      if (initial) await loadInfo();
      const at = await loadStatus();
      renderStations();
      const { bikes, n } = totals();
      el.chip.classList.remove('tick'); void el.chip.offsetWidth; el.chip.classList.add('tick');
      el.statusText.textContent = `${n} stations · ${bikes.toLocaleString('en')} bikes · ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      el.liveDot.classList.remove('dot-err'); el.liveDot.classList.add('dot-live');
      rerenderSheet();
      if (initial) fitAll(false);
    } catch (err) {
      console.error(err);
      el.statusText.textContent = initial ? 'Could not load stations' : 'Live update failed — retrying';
      el.liveDot.classList.add('dot-err'); el.liveDot.classList.remove('dot-live');
    }
  }

  function fitAll(animate = true) {
    const b = new maplibregl.LngLatBounds();
    for (const s of stations.values()) b.extend([s.lon, s.lat]);
    if (b.isEmpty()) return;
    const wide = matchMedia('(min-width: 720px)').matches;
    const padding = wide ? { top: 90, left: 40, right: 80, bottom: 60 } : { top: 110, left: 24, right: 24, bottom: 110 };
    map.fitBounds(b, { padding, animate, maxZoom: 15, duration: animate ? 700 : 0 });
  }

  // ---------- Selection & sheet ----------
  function select(id, fly = true) {
    if (trip && !trip.to && id !== trip.from) { completeTrip(id); return; }
    if (trip) trip = null; // picking a station outside the planner ends it
    if (journey) { journey = null; setRoute(EMPTY); }
    const prev = selectedId ? stations.get(selectedId) : null;
    selectedId = id;
    const s = stations.get(id);
    if (prev) paintPin(prev);
    if (s) paintPin(s);
    setSelectedLayer();
    if (fly && s) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 16), duration: 700 });
    renderSheet(s);
    openSheet();
  }
  let sheetCloseTimer = null;
  function openSheet() {
    clearTimeout(sheetCloseTimer);
    el.sheet.classList.remove('closing');
    if (el.sheet.hidden) { el.sheet.hidden = false; el.sheet.classList.add('opening'); setTimeout(() => el.sheet.classList.remove('opening'), 400); }
    applySnap('half'); el.chip.classList.add('pushed');
  }
  function closeSheet() {
    if (!el.sheet.hidden) {
      el.sheet.classList.add('closing');
      sheetCloseTimer = setTimeout(() => { el.sheet.hidden = true; el.sheet.classList.remove('closing'); }, 260);
    }
    el.chip.classList.remove('pushed');
    const s = selectedId ? stations.get(selectedId) : null;
    selectedId = null;
    if (s) paintPin(s);
    setSelectedLayer();
    setRoute(EMPTY);
    currentRoute = null;
    trip = null; journey = null;
    clearPlace();
  }
  el.sheetClose.addEventListener('click', closeSheet);
  // Bottom sheet (phone layout): drag the handle to resize; snap to collapsed / half / full,
  // or dismiss by flinging it down. Tap toggles collapsed <-> half.
  const grabber = $('grabber');
  const SNAP = { collapsed: 150 };
  const snapHeights = () => ({ collapsed: SNAP.collapsed, half: Math.round(innerHeight * 0.5), full: Math.round(innerHeight * 0.9) });
  const isPhone = () => !matchMedia('(min-width: 720px)').matches;
  let drag = null; // { y0, h0, t0, moved }
  function sheetHeight() { return el.sheet.getBoundingClientRect().height; }
  function applySnap(name) {
    el.sheet.classList.remove('collapsed', 'full', 'dragging');
    if (name !== 'half') el.sheet.classList.add(name);
    el.sheet.style.maxHeight = ''; el.sheet.style.transform = '';
  }
  grabber.addEventListener('pointerdown', (e) => {
    if (!isPhone()) return;
    drag = { y0: e.clientY, h0: sheetHeight(), t0: performance.now(), moved: false, id: e.pointerId };
    grabber.setPointerCapture(e.pointerId);
    el.sheet.classList.add('dragging');
  });
  grabber.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (Math.abs(dy) > 3) drag.moved = true;
    const h = drag.h0 - dy;
    const { full } = snapHeights();
    if (h >= 80) { el.sheet.style.maxHeight = `${Math.min(h, full)}px`; el.sheet.style.transform = ''; }
    else { el.sheet.style.maxHeight = '80px'; el.sheet.style.transform = `translateY(${80 - h}px)`; }
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0, dt = Math.max(1, performance.now() - drag.t0), v = dy / dt; // px per ms, + = down
    const h = drag.h0 - dy, snaps = snapHeights();
    const wasCollapsed = el.sheet.classList.contains('collapsed');
    drag = null;
    if (Math.abs(dy) <= 3) { // tap
      applySnap(wasCollapsed ? 'half' : 'collapsed'); return;
    }
    if ((v > 0.6 && h < snaps.half) || h < 90 || (wasCollapsed && dy > 40)) { applySnap('half'); closeSheet(); return; }
    let target = 'half';
    if (v > 0.4) target = h < snaps.half ? 'collapsed' : 'half';
    else if (v < -0.4) target = h > snaps.half ? 'full' : 'half';
    else {
      const d = Object.entries(snaps).map(([k, hh]) => [Math.abs(hh - h), k]).sort((a, b) => a[0] - b[0]);
      target = d[0][1];
    }
    applySnap(target);
  };
  grabber.addEventListener('pointerup', endDrag);
  grabber.addEventListener('pointercancel', endDrag);

  const fmtDist = (m) => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  const fmtDur = (s) => { const m = Math.max(1, Math.round(s / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const haversine = (a, b) => {
    const R = 6371e3, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  let currentRoute = null; // {toId, distance, duration, steps}
  // Only touch the DOM when the content actually changed, so periodic refreshes don't
  // reset scroll position or interrupt a tap.
  let lastSheetHtml = '';
  function setSheet(html) {
    if (html === lastSheetHtml) return false;
    lastSheetHtml = html; el.sheetBody.innerHTML = html;
    el.sheetBody.classList.remove('swap'); void el.sheetBody.offsetWidth; el.sheetBody.classList.add('swap');
    return true;
  }
  function renderSheet(s) {
    if (!s) return;
    const lv = level(s);
    const pct = s.capacity ? Math.min(100, Math.round(100 * s.bikes / s.capacity)) : 0;
    const dist = me ? fmtDist(haversine(me, s)) + ' away' : '';
    const status = !s.renting ? 'Station closed' : s.bikes === 0 ? 'No bikes right now' : s.bikes <= 3 ? 'Only a few bikes left' : 'Bikes available';
    const route = currentRoute && currentRoute.toId === s.id ? currentRoute : null;
    const appleUrl = `https://maps.apple.com/?daddr=${s.lat},${s.lon}&dirflg=w`;
    const gUrl = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=walking`;
    if (!setSheet(`
      <h2>${esc(s.name)}</h2>
      <p class="sub">${esc(status)}${dist ? ' · ' + dist : ''}</p>
      <div class="stats">
        <div class="stat ${lv}"><div class="v">${s.bikes}</div><div class="l">Bikes</div></div>
        <div class="stat"><div class="v">${s.docks}</div><div class="l">Free docks</div></div>
        <div class="stat"><div class="v">${s.capacity}</div><div class="l">Capacity</div></div>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      ${route ? `
        <div class="route-summary">
          <span class="big">${fmtDur(route.duration)}</span>
          <span class="dim">${fmtDist(route.distance)} · walking</span>
        </div>` : ''}
      <div class="actions">
        <button class="btn primary" id="dir-btn">
          <svg viewBox="0 0 24 24"><path d="M21.7 11.3l-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4ZM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5L14 14.5Z"/></svg>
          ${route ? 'Re-route' : 'Directions'}
        </button>
        <button class="btn" id="ride-btn" ${s.bikes < 1 || !s.renting ? 'title="No bikes here right now"' : ''}>
          <svg viewBox="0 0 24 24"><path d="M15.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7ZM19 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7ZM12 16.5V12h3.5v-1.5H12.4l-2-3.3 2.3-2.2 1.9 2.3H17V5.8h-1.7L13.6 3.7a1.5 1.5 0 0 0-2.2-.2L8.3 6.4a1.5 1.5 0 0 0-.1 2l2.3 3.6v4.5H12Z"/></svg>
          Ride from here
        </button>
        <a class="btn" href="${/iPhone|iPad|Macintosh/.test(navigator.userAgent) ? appleUrl : gUrl}" target="_blank" rel="noopener">Open in Maps</a>
      </div>
      ${route && route.steps.length ? `<ol class="steps">${route.steps.map((st) =>
        `<li><span>${esc(st.text)}</span><span class="d">${st.distance ? fmtDist(st.distance) : ''}</span></li>`).join('')}</ol>` : ''}
    `)) return;
    $('dir-btn').addEventListener('click', () => routeTo(s.id));
    $('ride-btn').addEventListener('click', () => startTrip(s.id));
  }

  function rerenderSheet() {
    if (el.sheet.hidden || el.sheet.classList.contains('closing')) return;
    if (journey) renderJourneySheet();
    else if (trip) renderTripSheet();
    else if (place && !selectedId) renderPlaceSheet(place);
    else if (selectedId) renderSheet(stations.get(selectedId));
  }

  // ---------- Station-to-station cycling trip ----------
  const FREE_RIDE_MIN = 30; // HSL city bike rides over 30 min cost extra
  let trip = null; // { from, to, route }
  function startTrip(fromId) {
    trip = { from: fromId, to: null, route: null };
    setRoute(EMPTY); currentRoute = null;
    renderTripSheet();
    openSheet();
    map.flyTo({ zoom: Math.min(map.getZoom(), 14), duration: 500 });
  }
  function cancelTrip() {
    trip = null;
    setRoute(EMPTY);
    if (selectedId) renderSheet(stations.get(selectedId));
  }
  async function completeTrip(toId) {
    if (!trip || toId === trip.from) return;
    trip.to = toId; trip.route = null;
    renderTripSheet(); openSheet();
    const a = stations.get(trip.from), b = stations.get(toId);
    try {
      const route = await fetchRoute(a, b, 'bike');
      if (!trip || trip.to !== toId) return;
      trip.route = route;
      drawRoute(route, a, b, 'bike');
      renderTripSheet();
    } catch (e) { toast(e.message); trip.to = null; renderTripSheet(); }
  }
  function renderTripSheet() {
    if (!trip) return;
    const a = stations.get(trip.from), b = trip.to ? stations.get(trip.to) : null, r = trip.route;
    const mins = r ? r.duration / 60 : 0;
    const over = r && mins > FREE_RIDE_MIN;
    const bikeSvg = '<svg viewBox="0 0 24 24"><path d="M5 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7ZM19 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7ZM12 16.5V12h3.5v-1.5H12.4l-2-3.3 2.3-2.2 1.9 2.3H17V5.8h-1.7L13.6 3.7a1.5 1.5 0 0 0-2.2-.2L8.3 6.4a1.5 1.5 0 0 0-.1 2l2.3 3.6v4.5H12Z"/></svg>';
    if (!setSheet(`
      <h2>Plan a ride</h2>
      <p class="sub">${b ? 'City bike route between two stations' : 'Tap a destination station on the map, or search for one'}</p>
      <div class="trip">
        <div class="trip-row"><span class="station-pin ${level(a)}">${a.bikes}</span><div><div class="trip-name">${esc(a.name)}</div><div class="sub">From · ${a.bikes} bikes available</div></div></div>
        <div class="trip-line"></div>
        <div class="trip-row">${b
          ? `<span class="station-pin dock">${b.docks}</span><div><div class="trip-name">${esc(b.name)}</div><div class="sub">To · ${b.docks} free docks</div></div>`
          : `<span class="station-pin dash">?</span><div><div class="trip-name dim">Choose destination…</div><div class="sub">Any other station</div></div>`}</div>
      </div>
      ${b && !r ? '<p class="sub"><span class="spin" style="display:inline-block;vertical-align:middle;margin-right:8px"></span>Finding a cycling route…</p>' : ''}
      ${r ? `
        <div class="route-summary">
          <span class="big">${fmtDur(r.duration)}</span>
          <span class="dim">${fmtDist(r.distance)} · cycling</span>
        </div>
        ${over ? `<p class="note warn">Over ${FREE_RIDE_MIN} min — HSL charges extra beyond the free ${FREE_RIDE_MIN} min. Consider docking at a station on the way.</p>`
               : `<p class="note ok">Within the free ${FREE_RIDE_MIN} min ride.</p>`}
        ${b.docks === 0 ? '<p class="note warn">No free docks at the destination right now — check again before you arrive.</p>' : ''}` : ''}
      <div class="actions">
        ${b ? `<button class="btn" id="trip-swap">${bikeSvg} Reverse</button>` : ''}
        <button class="btn" id="trip-cancel">Done</button>
      </div>
      ${r && r.steps.length ? `<ol class="steps">${r.steps.map((st) =>
        `<li><span>${esc(st.text)}</span><span class="d">${st.distance ? fmtDist(st.distance) : ''}</span></li>`).join('')}</ol>` : ''}
    `)) return;
    $('trip-cancel').addEventListener('click', () => { cancelTrip(); closeSheet(); });
    $('trip-swap')?.addEventListener('click', () => { const f = trip.from; trip.from = trip.to; completeTrip(f); });
  }

  // ---------- Geolocation ----------
  let watchId = null;
  function setMe(pos) {
    me = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
    const ll = [me.lon, me.lat];
    if (!meMarker) {
      const w = document.createElement('div'); w.className = 'me-wrap'; w.innerHTML = '<div class="me-dot"></div>';
      meMarker = new maplibregl.Marker({ element: w, anchor: 'center' }).setLngLat(ll).addTo(map);
      meMarker.getElement().style.zIndex = 2000;
    } else meMarker.setLngLat(ll);
    setAcc(me.acc > 25 ? circlePolygon(me.lat, me.lon, me.acc) : EMPTY);
    el.locate.classList.add('active');
    rerenderSheet();
  }
  function locate({ timeout = 12000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Geolocation is not supported by this browser'));
      el.locate.classList.add('busy');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          el.locate.classList.remove('busy');
          setMe(pos);
          if (watchId == null) watchId = navigator.geolocation.watchPosition(setMe, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
          resolve(me);
        },
        (err) => {
          el.locate.classList.remove('busy');
          const msg = err.code === 1 ? 'Location permission denied — allow location access in your browser settings'
            : err.code === 2 ? 'Position unavailable' : 'Location request timed out';
          reject(new Error(msg));
        },
        { enableHighAccuracy: true, timeout, maximumAge: 10000 },
      );
    });
  }
  el.locate.addEventListener('click', async () => {
    try {
      const p = await locate();
      map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 15), duration: 700 });
    } catch (e) { toast(e.message); }
  });

  // ---------- Routing ----------
  function nearestWithBikes(from) {
    let best = null, bestD = Infinity;
    for (const s of stations.values()) {
      if (!s.renting || s.bikes < 1) continue;
      const d = haversine(from, s);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
  async function fetchRouteOSRM(a, b) {
    const url = `${OSRM}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&steps=true`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`OSRM ${r.status}`);
    const j = await r.json();
    if (j.code !== 'Ok' || !j.routes?.length) throw new Error('OSRM: no route');
    const rt = j.routes[0];
    const steps = rt.legs.flatMap((l) => l.steps).map((s) => ({
      text: osrmStepText(s), distance: s.distance,
    })).filter((s) => s.text);
    return { coords: rt.geometry.coordinates, distance: rt.distance, duration: rt.duration, steps };
  }
  function osrmStepText(s) {
    const m = s.maneuver, name = s.name || '';
    const mod = m.modifier ? m.modifier.replace('slight ', 'slightly ').replace('sharp ', 'sharply ') : '';
    switch (m.type) {
      case 'depart': return `Head ${cardinal(m.bearing_after)}${name ? ' on ' + name : ''}`;
      case 'arrive': return 'Arrive at the station';
      case 'turn': case 'end of road': case 'fork': case 'continue': case 'new name':
        if (mod === 'straight') return name ? `Continue on ${name}` : 'Continue straight';
        if (mod === 'uturn') return 'Make a U-turn';
        return `Turn ${mod}${name ? ' onto ' + name : ''}`;
      case 'roundabout': case 'rotary': return `Take the roundabout${name ? ' to ' + name : ''}`;
      default: return name ? `Continue on ${name}` : '';
    }
  }
  const cardinal = (b) => ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(((b ?? 0) % 360) / 45) % 8];

  async function fetchRouteValhalla(a, b, mode = 'walk') {
    const q = {
      locations: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }],
      costing: mode === 'bike' ? 'bicycle' : 'pedestrian', units: 'kilometers', language: 'en-US',
      costing_options: mode === 'bike'
        // HSL city bikes are heavy 3-speed city bikes: keep the router off fast roads and realistic on speed.
        ? { bicycle: { bicycle_type: 'City', cycling_speed: 16, use_roads: 0.2, use_hills: 0.3 } }
        : { pedestrian: { walking_speed: 5.0 } },
    };
    const r = await fetch(`${VALHALLA}?json=${encodeURIComponent(JSON.stringify(q))}`);
    if (!r.ok) throw new Error(`Valhalla ${r.status}`);
    const j = await r.json();
    const leg = j.trip?.legs?.[0];
    if (!leg) throw new Error('Valhalla: no route');
    return {
      coords: decodePolyline6(leg.shape), distance: j.trip.summary.length * 1000, duration: j.trip.summary.time,
      steps: leg.maneuvers.map((m) => ({ text: m.instruction, distance: m.length * 1000 })),
    };
  }
  function decodePolyline6(str) {
    let idx = 0, lat = 0, lon = 0; const out = [];
    while (idx < str.length) {
      for (const k of [0, 1]) {
        let shift = 0, result = 0, byte;
        do { byte = str.charCodeAt(idx++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
        const d = (result & 1) ? ~(result >> 1) : (result >> 1);
        if (k === 0) lat += d; else lon += d;
      }
      out.push([lon / 1e6, lat / 1e6]);
    }
    return out;
  }
  async function fetchRoute(a, b, mode = 'walk') {
    // Valhalla has real pedestrian / bicycle profiles; the public OSRM demo only routes cars, so it
    // is a geometry-only fallback with the duration re-estimated at walking or city-bike pace.
    try { return await fetchRouteValhalla(a, b, mode); }
    catch (e) {
      console.warn('Valhalla failed, trying OSRM', e);
      const r = await fetchRouteOSRM(a, b);
      return { ...r, duration: r.distance / (mode === 'bike' ? 4.2 : 1.3) };
    }
  }

  function drawRoute(route, from, to, mode = 'walk') {
    setRoute({ type: 'Feature', properties: { mode }, geometry: { type: 'LineString', coordinates: route.coords } });
    const b = new maplibregl.LngLatBounds([from.lon, from.lat], [from.lon, from.lat]);
    for (const c of route.coords) b.extend(c);
    b.extend([to.lon, to.lat]);
    const wide = matchMedia('(min-width: 720px)').matches;
    const padding = wide
      ? { top: 90, left: 470, right: 80, bottom: 60 }
      : { top: 100, left: 30, right: 30, bottom: Math.round(innerHeight * 0.5) + 30 };
    map.fitBounds(b, { padding, maxZoom: 17, duration: 800 });
  }

  let routing = false;
  async function routeTo(id) {
    if (routing) return;
    routing = true; el.nearest.classList.add('busy');
    try {
      if (!me) await locate();
      const s = stations.get(id);
      const route = await fetchRoute(me, s);
      currentRoute = { toId: id, ...route };
      drawRoute(route, me, s);
      selectedId = id; renderStations();
      renderSheet(s); openSheet();
    } catch (e) { toast(e.message); }
    finally { routing = false; el.nearest.classList.remove('busy'); }
  }
  el.nearest.addEventListener('click', async () => {
    if (routing) return;
    try {
      if (!me) await locate();
      if (haversine(me, { lat: HELSINKI[0], lon: HELSINKI[1] }) > 60_000) {
        toast('You are outside the Helsinki area — showing the nearest station anyway');
      }
      const s = nearestWithBikes(me);
      if (!s) return toast('No station with bikes available right now');
      await routeTo(s.id);
    } catch (e) { toast(e.message); }
  });

  // ---------- Search: stations + addresses / places (Photon) ----------
  const PHOTON = 'https://photon.komoot.io/api/';
  const REGION_BBOX = '24.3,59.95,25.4,60.5'; // Helsinki metropolitan area
  let activeIdx = -1, searchSeq = 0, placeTimer = null, placeMarker = null, place = null;
  const stationHits = (q) => [...stations.values()]
    .filter((s) => s.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ai = a.name.toLowerCase().startsWith(q) ? 0 : 1, bi = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      if (me) return haversine(me, a) - haversine(me, b);
      return a.name.localeCompare(b.name);
    }).slice(0, 5);
  async function placeHits(q) {
    const c = me ?? { lat: map.getCenter().lat, lon: map.getCenter().lng };
    const url = `${PHOTON}?q=${encodeURIComponent(q)}&lat=${c.lat}&lon=${c.lon}&limit=6&lang=en&bbox=${REGION_BBOX}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Photon ${r.status}`);
    const j = await r.json();
    const seen = new Set();
    return j.features.map((f) => {
      const p = f.properties;
      const addr = [p.street && `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}`, p.city || p.county].filter(Boolean).join(', ');
      const name = p.name || addr || p.osm_value;
      return { key: `${name}|${addr}`, name, addr: name === addr ? (p.postcode || '') : addr, kind: (p.osm_value || p.type || '').replace(/_/g, ' '),
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
    }).filter((h) => !seen.has(h.key) && seen.add(h.key));
  }
  const stationLi = (s) => `
      <li role="option" data-id="${s.id}">
        <span class="station-pin ${level(s)}" style="width:28px;height:28px;font-size:11px;flex:none">${s.bikes}</span>
        <span class="name">${esc(s.name)}<div class="sub">${me ? fmtDist(haversine(me, s)) + ' · ' : ''}${s.docks} free docks</div></span>
      </li>`;
  const placeLi = (h, i) => `
      <li role="option" data-place="${i}">
        <span class="place-ic"><svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/></svg></span>
        <span class="name">${esc(h.name)}<div class="sub">${esc([h.kind, h.addr].filter(Boolean).join(' · '))}</div></span>
      </li>`;
  let lastPlaces = [];
  function search(raw) {
    const q = raw.trim().toLowerCase();
    el.clear.hidden = !q;
    clearTimeout(placeTimer);
    if (!q) { setOpen(el.results, false); el.results.innerHTML = ''; return; }
    const seq = ++searchSeq;
    const sts = stationHits(q);
    activeIdx = -1; lastPlaces = [];
    el.results.innerHTML = (sts.length ? `<li class="hdr">Stations</li>${sts.map(stationLi).join('')}` : '')
      + `<li class="hdr" id="places-hdr">Places &amp; addresses <span class="spin"></span></li>`;
    setOpen(el.results, true);
    placeTimer = setTimeout(async () => {
      try {
        const places = await placeHits(raw.trim());
        if (seq !== searchSeq) return;
        lastPlaces = places;
        const hdr = $('places-hdr'); if (!hdr) return;
        hdr.querySelector('.spin')?.remove();
        hdr.insertAdjacentHTML('afterend', places.length ? places.map(placeLi).join('') : '<li class="sub empty">No places match</li>');
        if (!sts.length && !places.length) el.results.innerHTML = '<li class="sub empty">Nothing found</li>';
      } catch (e) {
        if (seq !== searchSeq) return;
        $('places-hdr')?.insertAdjacentHTML('afterend', '<li class="sub empty">Place search unavailable</li>');
        $('places-hdr')?.querySelector('.spin')?.remove();
      }
    }, 250);
  }
  el.search.addEventListener('input', () => search(el.search.value));
  el.search.addEventListener('focus', () => search(el.search.value));
  el.search.addEventListener('keydown', (e) => {
    const items = [...el.results.querySelectorAll('li[data-id], li[data-place]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute('aria-selected', i === activeIdx));
    } else if (e.key === 'Enter') {
      const li = items[activeIdx] || items[0];
      if (li) pickLi(li);
    } else if (e.key === 'Escape') { el.search.blur(); setOpen(el.results, false); }
  });
  el.results.addEventListener('click', (e) => { const li = e.target.closest('li[data-id], li[data-place]'); if (li) pickLi(li); });
  function pickLi(li) {
    if (li.dataset.id) pick(li.dataset.id);
    else pickPlace(lastPlaces[+li.dataset.place]);
  }
  function pick(id) {
    const s = stations.get(id);
    el.search.value = s.name; setOpen(el.results, false); el.search.blur();
    setRoute(EMPTY); currentRoute = null;
    select(id, true);
  }
  function pickPlace(h) {
    if (!h) return;
    place = h;
    el.search.value = h.name; setOpen(el.results, false); el.search.blur();
    setRoute(EMPTY); currentRoute = null;
    if (selectedId) { const s = stations.get(selectedId); selectedId = null; paintPin(s); setSelectedLayer(); }
    if (!placeMarker) {
      const d = document.createElement('div'); d.className = 'place-wrap';
      d.innerHTML = '<div class="place-pin"><svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/></svg></div>';
      placeMarker = new maplibregl.Marker({ element: d, anchor: 'bottom' });
    }
    placeMarker.setLngLat([h.lon, h.lat]).addTo(map);
    const pp = placeMarker.getElement().firstChild; pp.style.animation = 'none'; void pp.offsetWidth; pp.style.animation = '';
    map.flyTo({ center: [h.lon, h.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 800 });
    renderPlaceSheet(h);
    openSheet();
  }
  function clearPlace() { place = null; placeMarker?.remove(); }
  function renderPlaceSheet(h) {
    const near = [...stations.values()].map((s) => ({ s, d: haversine(h, s) })).sort((a, b) => a.d - b.d).slice(0, 4);
    if (!setSheet(`
      <h2>${esc(h.name)}</h2>
      <p class="sub">${esc([h.kind, h.addr].filter(Boolean).join(' · '))}${me ? ' · ' + fmtDist(haversine(me, h)) + ' from you' : ''}</p>
      <div class="actions" style="margin-bottom:14px">
        <button class="btn primary" id="journey-btn">
          <svg viewBox="0 0 24 24"><path d="M5 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7ZM19 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7ZM12 16.5V12h3.5v-1.5H12.4l-2-3.3 2.3-2.2 1.9 2.3H17V5.8h-1.7L13.6 3.7a1.5 1.5 0 0 0-2.2-.2L8.3 6.4a1.5 1.5 0 0 0-.1 2l2.3 3.6v4.5H12Z"/></svg>
          Get there by city bike
        </button>
      </div>
      <div class="lbl">Nearest stations</div>
      <ul class="near">${near.map(({ s, d }) => `
        <li data-id="${s.id}">
          <span class="station-pin ${level(s)}" style="width:30px;height:30px;font-size:12px;flex:none">${s.bikes}</span>
          <span class="name">${esc(s.name)}<div class="sub">${fmtDist(d)} walk · ${s.bikes} bikes · ${s.docks} free docks</div></span>
          <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </li>`).join('')}</ul>`)) return;
    el.sheetBody.querySelectorAll('.near li').forEach((li) => li.addEventListener('click', () => select(li.dataset.id, true)));
    $('journey-btn').addEventListener('click', () => planJourney(h));
  }

  // ---------- Door-to-door journey: walk -> nearest bike -> ride -> nearest dock -> walk ----------
  let journey = null; // { place, a, b, legs: [{mode, from, to, route}] | null, error }
  function nearestWithDocks(to) {
    let best = null, bestD = Infinity;
    for (const s of stations.values()) {
      if (!s.renting || s.docks < 1) continue;
      const d = haversine(to, s);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
  async function planJourney(h) {
    if (routing) return;
    routing = true; el.nearest.classList.add('busy');
    try {
      if (!me) await locate();
      const a = nearestWithBikes(me);
      const b = nearestWithDocks(h);
      if (!a || !b) throw new Error('No usable station found right now');
      journey = { place: h, a, b, legs: null, error: null };
      setRoute(EMPTY);
      renderJourneySheet(); openSheet();
      const seq = journey;
      const legs = a.id === b.id || haversine(me, h) < haversine(me, a) + haversine(b, h)
        // Riding would be a detour: just walk.
        ? [{ mode: 'walk', from: me, to: h, label: 'Walk to destination' }]
        : [
          { mode: 'walk', from: me, to: a, label: `Walk to ${a.name}`, station: a },
          { mode: 'bike', from: a, to: b, label: `Ride to ${b.name}`, station: b },
          { mode: 'walk', from: b, to: h, label: 'Walk to destination' },
        ];
      const routes = await Promise.all(legs.map((l) => fetchRoute(l.from, l.to, l.mode)));
      if (journey !== seq) return;
      legs.forEach((l, i) => { l.route = routes[i]; });
      journey.legs = legs;
      setRoute({ type: 'FeatureCollection', features: legs.map((l) => ({
        type: 'Feature', properties: { mode: l.mode }, geometry: { type: 'LineString', coordinates: l.route.coords } })) });
      const bounds = new maplibregl.LngLatBounds([me.lon, me.lat], [me.lon, me.lat]);
      for (const l of legs) for (const c of l.route.coords) bounds.extend(c);
      bounds.extend([h.lon, h.lat]);
      const wide = matchMedia('(min-width: 720px)').matches;
      map.fitBounds(bounds, { padding: wide ? { top: 90, left: 470, right: 80, bottom: 60 } : { top: 100, left: 30, right: 30, bottom: Math.round(innerHeight * 0.5) + 30 }, maxZoom: 16, duration: 800 });
      renderJourneySheet();
    } catch (e) {
      toast(e.message);
      if (journey) { journey.error = e.message; renderJourneySheet(); }
    } finally { routing = false; el.nearest.classList.remove('busy'); }
  }
  function renderJourneySheet() {
    if (!journey) return;
    const { place: h, legs, error } = journey;
    const total = legs ? legs.reduce((t, l) => t + l.route.duration, 0) : 0;
    const ride = legs?.find((l) => l.mode === 'bike');
    const rideMin = ride ? ride.route.duration / 60 : 0;
    const walkSvg = '<svg viewBox="0 0 24 24"><path d="M13.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM9.8 8.9 7 22h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3a7.2 7.2 0 0 0 5.5 2.5v-2a5.2 5.2 0 0 1-4.5-2.5l-1-1.6a2 2 0 0 0-1.7-.9 2 2 0 0 0-.7.1L6 9.3V14h2v-3.4l1.8-.7Z"/></svg>';
    const bikeSvg = '<svg viewBox="0 0 24 24"><path d="M5 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7ZM19 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7ZM12 16.5V12h3.5v-1.5H12.4l-2-3.3 2.3-2.2 1.9 2.3H17V5.8h-1.7L13.6 3.7a1.5 1.5 0 0 0-2.2-.2L8.3 6.4a1.5 1.5 0 0 0-.1 2l2.3 3.6v4.5H12Z"/></svg>';
    if (!setSheet(`
      <h2>To ${esc(h.name)}</h2>
      <p class="sub">${esc([h.kind, h.addr].filter(Boolean).join(' · '))}</p>
      ${error ? `<p class="err">${esc(error)}</p>` : !legs
        ? '<p class="sub"><span class="spin" style="display:inline-block;vertical-align:middle;margin-right:8px"></span>Planning walk → ride → walk…</p>'
        : `
      <div class="route-summary">
        <span class="big">${fmtDur(total)}</span>
        <span class="dim">${fmtDist(legs.reduce((t, l) => t + l.route.distance, 0))} · door to door</span>
      </div>
      ${ride && rideMin > FREE_RIDE_MIN ? `<p class="note warn">The ride is over ${FREE_RIDE_MIN} min — HSL charges extra beyond the free ${FREE_RIDE_MIN} min.</p>` : ''}
      <ol class="legs">${legs.map((l) => `
        <li class="leg ${l.mode}">
          <span class="leg-ic">${l.mode === 'bike' ? bikeSvg : walkSvg}</span>
          <div class="leg-body">
            <div class="leg-title">${esc(l.label)}</div>
            <div class="sub">${fmtDur(l.route.duration)} · ${fmtDist(l.route.distance)}${l.station ? ` · ${l.mode === 'walk' ? `${l.station.bikes} bikes available` : `${l.station.docks} free docks`}` : ''}</div>
          </div>
        </li>`).join('')}</ol>`}
      <div class="actions">
        ${legs ? '<button class="btn" id="journey-reroute">Re-plan</button>' : ''}
        <button class="btn" id="journey-done">Done</button>
      </div>
    `)) return;
    $('journey-done').addEventListener('click', closeSheet);
    $('journey-reroute')?.addEventListener('click', () => planJourney(h));
    el.sheetBody.querySelectorAll('.leg').forEach((li, i) => {
      const st = legs?.[i]?.station;
      if (st) { li.style.cursor = 'pointer'; li.addEventListener('click', () => select(st.id, true)); }
    });
  }
  el.clear.addEventListener('click', () => { el.search.value = ''; search(''); el.search.focus(); });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#search')) setOpen(el.results, false); });

  // ---------- Misc controls ----------
  el.zoomIn.addEventListener('click', () => map.zoomIn());
  el.zoomOut.addEventListener('click', () => map.zoomOut());
  el.fitAll.addEventListener('click', () => fitAll(true));
  el.menu.addEventListener('click', () => el.about.showModal());
  el.about.addEventListener('click', (e) => { if (e.target === el.about) el.about.close(); });
  map.on('click', () => {
    if (clickedFeature) { clickedFeature = false; return; }
    if (!el.sheet.hidden && !el.sheet.classList.contains('closing') && !currentRoute && !trip) closeSheet();
  });

  let toastTimer;
  function toast(msg) {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 4000);
  }

  // ---------- Boot ----------
  refresh(true);
  setInterval(() => refresh(false), REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  if (location.protocol === 'https:' && navigator.permissions?.query) {
    // Silently show the blue dot if the user already granted location earlier.
    navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') locate().catch(() => {}); }).catch(() => {});
  }
})();
