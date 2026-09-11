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
  const styleUrl = (isDark) => `https://tiles.openfreemap.org/styles/${isDark ? 'dark' : 'positron'}`;
  const map = new maplibregl.Map({
    container: el.map, style: styleUrl(dark.matches),
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
  let routeGeo = EMPTY, accGeo = EMPTY;
  function addOverlays() {
    if (map.getSource('route')) return;
    map.addSource('route', { type: 'geojson', data: routeGeo });
    map.addSource('me-acc', { type: 'geojson', data: accGeo });
    map.addLayer({ id: 'me-acc', type: 'fill', source: 'me-acc', paint: { 'fill-color': '#0a84ff', 'fill-opacity': 0.1 } });
    map.addLayer({ id: 'me-acc-line', type: 'line', source: 'me-acc', paint: { 'line-color': '#0a84ff', 'line-opacity': 0.35, 'line-width': 1 } });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': dark.matches ? '#111318' : '#ffffff', 'line-width': 10, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0a84ff', 'line-width': 6 } });
  }
  map.on('style.load', addOverlays);
  dark.addEventListener('change', (e) => map.setStyle(styleUrl(e.matches)));
  const setRoute = (geo) => { routeGeo = geo; map.getSource('route')?.setData(geo); };
  const setAcc = (geo) => { accGeo = geo; map.getSource('me-acc')?.setData(geo); };

  let meMarker = null, me = null; // me = {lat, lon, acc}

  const zoomClass = () => {
    const z = map.getZoom();
    el.map.classList.toggle('zoom-vfar', z < 11);
    el.map.classList.toggle('zoom-far', z >= 11 && z < 12.5);
    el.map.classList.toggle('zoom-mid', z >= 12.5 && z < 14.5);
  };
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
    for (const s of stations.values()) {
      if (!s.marker) {
        const wrap = document.createElement('div');
        wrap.className = 'pin-wrap';
        s.el = document.createElement('div');
        wrap.appendChild(s.el);
        wrap.addEventListener('click', (e) => { e.stopPropagation(); select(s.id, false); });
        s.marker = new maplibregl.Marker({ element: wrap, anchor: 'bottom' }).setLngLat([s.lon, s.lat]).addTo(map);
      }
      paintPin(s);
    }
  }
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
      el.statusText.textContent = `${n} stations · ${bikes.toLocaleString('en')} bikes · ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      el.liveDot.classList.remove('dot-err'); el.liveDot.classList.add('dot-live');
      if (selectedId) renderSheet(stations.get(selectedId));
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
    const prev = selectedId ? stations.get(selectedId) : null;
    selectedId = id;
    const s = stations.get(id);
    if (prev?.marker) paintPin(prev);
    if (s?.marker) paintPin(s);
    if (fly && s) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 16), duration: 700 });
    renderSheet(s);
    openSheet();
  }
  function openSheet() { el.sheet.hidden = false; el.sheet.classList.remove('collapsed'); el.chip.classList.add('pushed'); }
  function closeSheet() {
    el.sheet.hidden = true; el.chip.classList.remove('pushed');
    const s = selectedId ? stations.get(selectedId) : null;
    selectedId = null;
    if (s?.marker) paintPin(s);
    setRoute(EMPTY);
    currentRoute = null;
  }
  el.sheetClose.addEventListener('click', closeSheet);
  // Bottom sheet: tap or swipe the grabber to collapse / expand (mobile layout).
  const grabber = $('grabber');
  let dragY = null;
  grabber.addEventListener('click', () => el.sheet.classList.toggle('collapsed'));
  grabber.addEventListener('touchstart', (e) => { dragY = e.touches[0].clientY; }, { passive: true });
  grabber.addEventListener('touchmove', (e) => {
    if (dragY == null) return;
    const dy = e.touches[0].clientY - dragY;
    if (dy > 40) { el.sheet.classList.add('collapsed'); dragY = null; }
    else if (dy < -40) { el.sheet.classList.remove('collapsed'); dragY = null; }
  }, { passive: true });
  grabber.addEventListener('touchend', () => { dragY = null; });

  const fmtDist = (m) => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  const fmtDur = (s) => { const m = Math.max(1, Math.round(s / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const haversine = (a, b) => {
    const R = 6371e3, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  let currentRoute = null; // {toId, distance, duration, steps}
  function renderSheet(s) {
    if (!s) return;
    const lv = level(s);
    const pct = s.capacity ? Math.min(100, Math.round(100 * s.bikes / s.capacity)) : 0;
    const dist = me ? fmtDist(haversine(me, s)) + ' away' : '';
    const status = !s.renting ? 'Station closed' : s.bikes === 0 ? 'No bikes right now' : s.bikes <= 3 ? 'Only a few bikes left' : 'Bikes available';
    const route = currentRoute && currentRoute.toId === s.id ? currentRoute : null;
    const appleUrl = `https://maps.apple.com/?daddr=${s.lat},${s.lon}&dirflg=w`;
    const gUrl = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=walking`;
    el.sheetBody.innerHTML = `
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
        <a class="btn" href="${/iPhone|iPad|Macintosh/.test(navigator.userAgent) ? appleUrl : gUrl}" target="_blank" rel="noopener">Open in Maps</a>
      </div>
      ${route && route.steps.length ? `<ol class="steps">${route.steps.map((st) =>
        `<li><span>${esc(st.text)}</span><span class="d">${st.distance ? fmtDist(st.distance) : ''}</span></li>`).join('')}</ol>` : ''}
    `;
    $('dir-btn').addEventListener('click', () => routeTo(s.id));
  }

  // ---------- Geolocation ----------
  let watchId = null;
  function setMe(pos) {
    me = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
    const ll = [me.lon, me.lat];
    if (!meMarker) {
      const d = document.createElement('div'); d.className = 'me-dot';
      meMarker = new maplibregl.Marker({ element: d, anchor: 'center' }).setLngLat(ll).addTo(map);
      meMarker.getElement().style.zIndex = 2000;
    } else meMarker.setLngLat(ll);
    setAcc(me.acc > 25 ? circlePolygon(me.lat, me.lon, me.acc) : EMPTY);
    el.locate.classList.add('active');
    if (selectedId) renderSheet(stations.get(selectedId));
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

  async function fetchRouteValhalla(a, b) {
    const q = {
      locations: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }],
      costing: 'pedestrian', units: 'kilometers', language: 'en-US',
      costing_options: { pedestrian: { walking_speed: 5.0 } },
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
  async function fetchRoute(a, b) {
    // Valhalla has a real pedestrian profile; the public OSRM demo only routes cars, so it is a
    // geometry-only fallback with the duration re-estimated at walking pace.
    try { return await fetchRouteValhalla(a, b); }
    catch (e) {
      console.warn('Valhalla failed, trying OSRM', e);
      const r = await fetchRouteOSRM(a, b);
      return { ...r, duration: r.distance / 1.3 };
    }
  }

  function drawRoute(route, from, to) {
    setRoute({ type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords } });
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

  // ---------- Search ----------
  let activeIdx = -1;
  function search(q) {
    q = q.trim().toLowerCase();
    el.clear.hidden = !q;
    if (!q) { el.results.hidden = true; el.results.innerHTML = ''; return; }
    const hits = [...stations.values()]
      .filter((s) => s.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const ai = a.name.toLowerCase().startsWith(q) ? 0 : 1, bi = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (ai !== bi) return ai - bi;
        if (me) return haversine(me, a) - haversine(me, b);
        return a.name.localeCompare(b.name);
      }).slice(0, 8);
    activeIdx = -1;
    el.results.innerHTML = hits.length ? hits.map((s) => `
      <li role="option" data-id="${s.id}">
        <span class="station-pin ${level(s)}" style="width:28px;height:28px;font-size:11px;flex:none">${s.bikes}</span>
        <span class="name">${esc(s.name)}<div class="sub">${me ? fmtDist(haversine(me, s)) + ' · ' : ''}${s.docks} free docks</div></span>
      </li>`).join('') : '<li class="sub" style="cursor:default">No stations match</li>';
    el.results.hidden = false;
  }
  el.search.addEventListener('input', () => search(el.search.value));
  el.search.addEventListener('focus', () => search(el.search.value));
  el.search.addEventListener('keydown', (e) => {
    const items = [...el.results.querySelectorAll('li[data-id]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute('aria-selected', i === activeIdx));
    } else if (e.key === 'Enter') {
      const li = items[activeIdx] || items[0];
      if (li) pick(li.dataset.id);
    } else if (e.key === 'Escape') { el.search.blur(); el.results.hidden = true; }
  });
  el.results.addEventListener('click', (e) => { const li = e.target.closest('li[data-id]'); if (li) pick(li.dataset.id); });
  function pick(id) {
    const s = stations.get(id);
    el.search.value = s.name; el.results.hidden = true; el.search.blur();
    setRoute(EMPTY); currentRoute = null;
    select(id, true);
  }
  el.clear.addEventListener('click', () => { el.search.value = ''; search(''); el.search.focus(); });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#search')) el.results.hidden = true; });

  // ---------- Misc controls ----------
  el.zoomIn.addEventListener('click', () => map.zoomIn());
  el.zoomOut.addEventListener('click', () => map.zoomOut());
  el.fitAll.addEventListener('click', () => fitAll(true));
  el.menu.addEventListener('click', () => el.about.showModal());
  el.about.addEventListener('click', (e) => { if (e.target === el.about) el.about.close(); });
  map.on('click', () => { if (!el.sheet.hidden && !currentRoute) closeSheet(); });

  let toastTimer;
  function toast(msg) {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 4000);
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
