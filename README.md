# Marble Run

A 3D marble race for a phone. Enter everyone's names, pick a seed, and watch
real physics decide who wins. The same seed always builds the same track and
produces the same result, so a race can be shared, re-run and argued about.

Built with [Babylon.js](https://www.babylonjs.com/) for rendering and
[Havok](https://www.havok.com/) for physics.

## Running it

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # typecheck + production build into dist/
```

## How a race works

**Enter racers.** Two to twelve, each gets a colour. Names are remembered
between visits.

**Pick a track.** Any text is a valid seed. `Today's track` is the daily seed
everyone in the world gets; `Surprise me` rolls a fresh one. The setup screen
generates the real track as you type, so the length, drop and obstacle count
shown are exactly what you will race on.

**Race.** All the marbles are released together and the broadcast camera
follows the leader. Tap the camera button to switch between following the
leader, chasing a marble, and a wide shot.

**Share.** `Copy invite link` puts the seed and the roster in a URL, so friends
can run the identical track on their own phones.

## The physical model

The run is modelled as an actual marble run, at the size one would really be:
16mm glass marbles in a channel about 7cm wide, seven to fifteen metres of
track, dropping half a metre or so overall.

That scale is not decoration — it is what sets the speed. A rolling sphere that
has descended a height `h` is travelling at `v = √(2·g·h·5/7)`, so a run's top
speed follows from its total drop and nothing else. Marbles here flow at around
**0.5 m/s** and touch about **1.1 m/s** on the steeper drops, which is what a
marble on a wooden run actually does. Building the same track at fairground
scale would have them doing 60km/h whether that was wanted or not.

Two properties are guaranteed rather than hoped for:

- **The track runs downhill everywhere.** A marble set down at rest anywhere on
  it will start rolling towards the finish. This is enforced structurally after
  the centreline is generated, and verified by simulation (`npm run test:rest`).
- **The same seed gives the same race.** The simulation runs on a fixed
  timestep with catch-up, so the result does not depend on the device's frame
  rate.

Rolling resistance is modelled explicitly, because Havok has none of its own
and a marble that never loses energy accelerates forever. It is that
coefficient which sets the shallowest gradient the track is allowed to have:
a marble only moves off where `tanθ > (7/5)·Crr`.

## How tracks are generated

A cursor walks downhill from the start gate. Each segment steers it — turns
bend the heading, spirals wind it down, drops steepen it — and a spatial hash
rejects any segment that would run into track already laid down. The walk is
then resampled to an even spacing, smoothed, and forced to descend everywhere.

Several parts of the generator size themselves from the physics rather than
from a constant, because a number that works at one speed does not work at
another:

| Feature | Sized from |
| --- | --- |
| Corner radius | Speed there, capped at 1.15g of cornering |
| Banking, wall height | Cornering force the corner will actually produce |
| Wave amplitude | Speed and wavelength, so marbles never leave the crest |
| Jump gap length | Ballistic range at the speed marbles arrive with |
| Obstacle lane widths | Marble diameter, so nothing can wedge a marble |

Obstacles are spinners, wrecking balls, pachinko fields, bumpers, timed gates,
boost pads, lane dividers, rolling drums and crosswind zones. Moving ones are
kinematic and driven from simulated time, so they are in the same place at the
same moment on every device.

## Tuning and diagnostics

The interesting failures in a physics race are statistical — one race looking
fine says very little. `diagnostic.html` runs races headlessly with no
rendering, and the scripts below drive it:

```bash
npm run test:smoke     # end-to-end: renders, races, and reproduces a seed
npm run test:rest      # the "downhill everywhere" invariant
npm run tune           # finish rates, rescue causes, flow speeds
npm run tune:flow      # sweeps gradient against rolling resistance
npm run tune:channel   # sweeps channel width against rim geometry
npm run tune:escapes   # classifies how marbles leave the channel
```

`npm run tune` is the main one. It reports what fraction of marbles finish, how
often the recovery system had to intervene and why, and which obstacle was
nearest when it did — which is how every tuning decision in this repository was
actually made.

## Recovery

Marbles that fall out of the channel, wedge themselves, or spend too long
getting nowhere are put back on the track. This is a safety net, not a
simulation shortcut: a race that cannot finish is worse than one with a
blemish. Roughly 95% of marbles finish cleanly, and the harness reports the
rate so that regressions are visible.

## Deployment

Pushing to the development branch builds the site and publishes it to GitHub
Pages via `.github/workflows/deploy.yml`. The build sets Vite's `base` from the
repository name so it works under a project path.

## Layout

```
src/
  core/        seeded RNG, seed handling
  track/       generation, geometry, mesh building, obstacles
  game/        marbles, race simulation, camera, world assembly
  render/      procedural sky, lighting
  ui/          setup, HUD and results screens
  diagnostic.ts  headless harness used by the tuning scripts
scripts/       node drivers for the harness
```
