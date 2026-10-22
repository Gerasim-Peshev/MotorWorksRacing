# MotorWorks Racing

Design it, then drive it. A standalone 3D browser game built on the engine and car design ideas of **MotorWorks Tycoon**: an installable PWA that works offline, where you design engines and cars with the same parts, technology years and formulas as the tycoon, then race them on real circuits:

| Circuit | Length | Elevation change |
|---|---|---|
| Nürburgring Nordschleife | 20.832 km | 286 m |
| Circuit de Spa-Francorchamps | 7.004 km | 103 m |
| Suzuka Circuit (with the figure-eight bridge) | 5.807 km | 44 m |
| Circuit de Barcelona-Catalunya | 4.657 km | 31 m |
| Red Bull Ring | 4.318 km | 61 m |
| Nürburgring GP-Strecke | 5.148 km | 54 m |
| A1 Motor Park, Samokov (Bulgaria) | 3.910 km | ≈ 14 m (estimated) |

Layouts come from OpenStreetMap, elevation from real terrain data, so Eau Rouge climbs, the Nordschleife drops 280 m to Breidscheid and Turn 1 at the Red Bull Ring is uphill. A1 Motor Park is the exception: it isn't in the open map databases, so its 15-turn layout is traced from the official circuit map and its gentle elevation and the Rila/Plana hills around it are an estimate.

## Free roam: Sofia and Veliko Tarnovo

Two Bulgarian cities are drivable, built from OpenStreetMap. Both are laid out flat, so every street drives the same; only overpasses rise over the roads they cross.

- **Sofia**: everything inside the Ring Road plus Gorna Banya (298 km², 2,200 km of streets, about 91,000 buildings): boulevards with their lanes, trams and zebra crossings, bridges and overpasses, parks, rivers, traffic lights and the airport runway, with Vitosha on the horizon from real elevation data. 11 challenges.
- **Veliko Tarnovo**: the old capital on the bends of the Yantra (38 km², 193 km of streets, about 5,300 buildings), from the Mall to Tsarevets and Varusha. The hills around it are decorative. 7 challenges.

Building heights and colours come from the map where they are tagged and are estimated elsewhere.

- **Free roam**: drive anywhere. The minimap shows the real street network and the street name you are on.
- **Drive to…**: pick a landmark from the pause menu. Cars fitted with navigation (the tycoon's *Navigation* option) get a route on the minimap; others follow the arrow.
- **Challenges**: timed runs between landmarks, any route allowed. Best times are saved per car under **Records**.

The cities stream in 1 km tiles as you drive (cached for offline play once visited). On phones they use a shorter view distance and fewer trees.

## Put it online (GitHub Pages)

This is its own app, separate from MotorWorks Tycoon.

1. Create a new GitHub repository, for example `motorworks-racing`, and put the contents of this folder at its root (`index.html` at the top level).
2. Commit and push, then turn on **Settings → Pages → Deploy from a branch → main / (root)**. The game appears at `https://<you>.github.io/motorworks-racing/`.
3. Open it and install it: Chrome/Edge → Install app, Safari → Share → Add to Home Screen.

**Bringing designs over from the tycoon**: export a save code in MotorWorks Tycoon and paste it in **Settings → Your garage**. If both games are on the same `github.io` account, the racing game also finds the tycoon save on that device by itself and offers to import its engines and cars (browser storage is shared per address, not per repository).

Test locally: `python3 -m http.server` in this folder, then open `http://localhost:8000`.

## Controls

**Xbox / PlayStation controller** (USB or Bluetooth; the triggers are fully analog)

| Action | Xbox | PlayStation |
|---|---|---|
| Throttle / brake | RT / LT | R2 / L2 |
| Steer | Left stick | Left stick |
| Shift up / down | RB, B / LB, X | R1, ○ / L1, □ |
| Handbrake | A | ✕ |
| Camera | Y | △ |
| Look back | Right stick click | R3 |
| Reset car to track | View | Create |
| Pause | Menu | Options |
| Autopilot (cars with Self-driving L3) | D-pad down | D-pad down |

Menus work with the D-pad or stick: A/✕ selects, B/○ goes back, LB/RB switch tabs. The pause menu has a volume slider (left/right on the D-pad), and B/○ there resumes the session. Every action can be remapped in Settings, which also shows live trigger and stick values, dead zones, steering linearity and vibration. Rumble includes trigger rumble for ABS and traction control on Xbox controllers in Chrome and Edge.

**Keyboard**: arrows or WASD, E/Q shift, Space handbrake, C camera, R reset, B look back, L autopilot, Esc pause.
**Phones and tablets**: steering pad, analog gas and brake pedals (press higher for more), gear buttons.

## How a design becomes a car

The garage starts empty: design an engine, build a car around it, then pick a circuit. Or bring your designs over from the tycoon.

- **Engine**: the tycoon's power, torque, redline and weight formulas build a torque curve (peaky DOHC, flat turbo plateau, low-revving diesel, high-revving rotary, constant-torque EV). Turbos have real lag that grows with boost and turbo count.
- **Gearbox**: ratios are calculated from the engine's power band and the car's top speed. Manuals cut drive while shifting, automatics kick down, dual-clutch boxes shift in 50–80 ms, CVTs hold the power peak.
- **Chassis**: body size, weight and weight distribution come from the tycoon's body shapes. The suspension sets roll stiffness and grip, and FWD, RWD and AWD change how power reaches the road.
- **New parts for driving**: tyres (eco to racing slicks) and brakes (drums to carbon-ceramics).
- **Tyres and drivetrain**: every wheel spins on its own with real inertia, and the engine's inertia is felt through the gearbox. Tyres use a combined-slip model: a wheel that spins or locks loses side grip, so power oversteer, lift-off oversteer and locked-wheel slides all come out of the physics. The differential matters:
  - an open diff spins the unloaded inside wheel;
  - a limited-slip diff shares the drive;
  - a welded diff locks both wheels together.
- **Drifting**: hold the handbrake to lock the rear wheels with the clutch in. The engine revs freely, and letting go dumps the clutch for a kick. Steer the slide with the throttle.
  - With **Steering assist** on, the helper lines the front wheels up with the direction of travel during a slide. That catches it for you.
  - With the assist off, the stick's range grows by the slide angle, so you can countersteer yourself.
  - Turn **Stability control** off in the pause menu to drift; it is built to stop slides.
  - Sliding tyres leave skid marks and smoke, or dust off the road.
- **Drift parts**: welded diff, quick steering rack, a drift angle kit (about 55° of lock) and drift coilovers that shift load transfer to the rear.
- **ABS and stability control** only work if the car has them fitted. Self-driving L3 unlocks the autopilot.
- **3D cars**: each body is lofted from the tycoon's side profile through real cross-sections: tumblehome, rounded shoulders, crowned hood and roof, rounded corners in plan view, and wheel arches with dark wells. On top of that come flush glass with pillars, clear-coated paint (metallic on newer cars), lamps, grilles, plates and trim that follow the body surface, mirrors, door seams and handles, exhausts, and lathed tyres on alloy or steel rims with brake discs and calipers. Calipers are red on sporty cars and gold with carbon-ceramics. The model year sets the style: older cars get chrome bumpers and round lamps, newer ones get swept lamps with LED strips.
- **Engine sound**: a physical model runs in an AudioWorklet. Every cylinder fires an exhaust pulse at its real crank angle in the firing order, into its own exhaust bank. The pulses pass through the headers, tailpipes and a muffler. That is why a cross-plane V8 burbles (each bank fires unevenly), a flat-4 rumbles (unequal-length headers), an inline-5 warbles, a V12 screams, a rotary braps and a diesel clatters. V and W engines get a tailpipe on each side, in stereo. The model also covers turbo muffling, overrun pops, ignition cuts on hard upshifts and the fuel cut on the rev limiter. Press **▶ Listen** on an engine to hear idle, two blips and a full-throttle pull.

## Data and credits

- Track geometry © OpenStreetMap contributors, ODbL 1.0, via [Open Racetrack DB](https://github.com/markthebault/open-racetrack-db).
- Terrain: Mapzen Terrain Tiles (USGS, NOAA, Copernicus EU-DEM) as gridded by Open Racetrack DB.
- Sofia: map data © OpenStreetMap contributors (ODbL 1.0); elevation from [Viewfinder Panoramas](http://viewfinderpanoramas.org) 3″ DEM by Jonathan de Ferranti (based on SRTM). Built with `tools/city/` (see below).
- A1 Motor Park: layout traced from the official circuit map (`tools/trace_a1.py`, `tools/build_a1.py`) and scaled to the official 3.910 km; elevation and surrounding terrain are estimated.
- Track widths and start/finish lines: [TUMFTM racetrack-database](https://github.com/TUMFTM/racetrack-database), LGPL-3.0.
- Racing lines: minimum-curvature optimisation done offline (`tools/build_tracks.py`).
- 3D engine: [three.js](https://threejs.org) r170, MIT (`js/vendor/three-LICENSE.txt`).
- Fonts: Oswald and Fira Sans, SIL Open Font License (`fonts/`).

## Adding a circuit

`tools/build_tracks.py` turns an OpenStreetMap trace and a terrain grid into a track file (smoothing, widths, start line, elevation, bridges, racing line). Clone the two data repositories next to it, run it, then `node tools/index_tracks.mjs`, and add the new file to `sw.js`. `cd tools && node test_laps.mjs spa pc1,pc4` drives autopilot laps with the sample cars in `tools/sample_cars.mjs` to check a track.

## Rebuilding the cities

`tools/city/` turns an OpenStreetMap extract into the files in `city/<id>/`, driven by a config per city (`sofia.json`, `veliko-tarnovo.json`: map area, flat level, landmarks, challenges):

1. `python3 extract.py bulgaria-latest.osm.pbf sofia_raw.pkl` (Sofia) or `python3 extract.py bulgaria-latest.osm.pbf vt_raw.pkl 25.53,25.74,43.03,43.13` (a bounding box: west,east,south,north). The extract comes from [Geofabrik](https://download.geofabrik.de/europe/bulgaria.html); needs `pip install osmium shapely scipy matplotlib`.
2. `python3 build_city.py sofia.json sofia_raw.pkl <folder with N42E022.hgt and N42E023.hgt> ../../city/sofia` (elevation tiles from Viewfinder Panoramas, area K34; a city without tiles gets decorative hills).
3. `python3 make_info.py ../../city/sofia` for the menu summary and preview map, and list the city in `city/index.json`.
