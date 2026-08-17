import "./style.css";

import { el } from "./ui/dom";
import { SetupScreen } from "./ui/setup";
import { Hud } from "./ui/hud";
import { ResultsScreen } from "./ui/results";
import {
  buildShareLink,
  loadThemeId,
  makePlayers,
  loadCameraMode,
  paletteFor,
  patternFor,
  readShareLink,
  saveCameraMode,
} from "./ui/players";
import { normaliseSeed, randomSeed } from "./core/seed";
import { World, initPhysics } from "./game/world";
import { isCameraMode, type CameraMode } from "./game/camera";
import type { Standing } from "./game/race";

/**
 * App shell: owns the screen the player is looking at and the world behind it.
 *
 * Only one `World` exists at a time. Starting a race builds one; leaving the
 * results tears it down. That keeps GPU and physics resources bounded no
 * matter how many races get run in a sitting.
 */

const canvas = document.getElementById("render-canvas") as HTMLCanvasElement;
const uiRoot = document.getElementById("ui-root") as HTMLElement;

type Screen = { root: HTMLElement; dispose(): void };

let currentScreen: Screen | null = null;
let world: World | null = null;
let roster: string[] = [];
let seed = "";
let themeId = "";
// Carried between races, so a camera picked mid-race is still there for the
// next one and for the next visit.
let cameraMode: CameraMode = "broadcast";

function showScreen(screen: Screen | null): void {
  currentScreen?.dispose();
  currentScreen = screen;
  if (screen) uiRoot.append(screen.root);
}

function showLoader(message: string): void {
  showScreen({
    root: el("div", { class: "screen loader" }, [
      el("div", { class: "loader-inner" }, [
        el("div", { class: "loader-marble" }),
        el("p", { class: "loader-text", text: message }),
      ]),
    ]),
    dispose() {
      this.root.remove();
    },
  });
}

function showFatal(message: string, detail: string): void {
  disposeWorld();
  showScreen({
    root: el("div", { class: "screen" }, [
      el("div", { class: "fatal" }, [
        el("h2", { text: message }),
        el("p", { text: detail }),
      ]),
    ]),
    dispose() {
      this.root.remove();
    },
  });
}

function disposeWorld(): void {
  world?.dispose();
  world = null;
}

function showSetup(): void {
  disposeWorld();
  showScreen(
    // An empty roster must be passed as undefined, not as an empty array, or
    // the setup screen treats "no names supplied" as "the user wants no
    // racers" and never falls back to the saved roster.
    new SetupScreen({ names: roster.length > 0 ? roster : undefined, seed }, (result) => {
      roster = result.names;
      seed = result.seed;
      themeId = result.themeId;
      void startRace();
    }),
  );
}

/**
 * Whether the current race is already a retry after a scene that could not
 * draw. One automatic attempt, then the player is told rather than left in a
 * loop of rebuilds.
 */
let retriedStuck = false;

async function startRace(isRetry = false): Promise<void> {
  retriedStuck = isRetry;
  showLoader("Building the track…");
  disposeWorld();

  // Yield a frame so the loader actually paints before the heavy build starts.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  let hud: Hud | null = null;

  try {
    const onRaceComplete = (standings: Standing[]) => {
      window.setTimeout(() => showResults(standings), 1400);
    };

    world = new World({
      canvas,
      seed,
      players: makePlayers(roster),
      themeId,
      cameraMode,
      onStuck: () => {
        // The scene is running but cannot draw. Rebuilding gets a fresh engine
        // and a fresh set of shaders, which is what a page reload would do and
        // saves the player doing it by hand.
        console.warn("Scene failed to render; rebuilding.");
        if (retriedStuck) {
          showFatal(
            "Graphics did not start",
            "The scene could not be drawn on this device. Reloading the page usually clears it.",
          );
          return;
        }
        void startRace(true);
      },
      events: {
        onCountdownTick: (value) => hud?.showCountdown(value),
        onRaceComplete,
      },
    });
  } catch (error) {
    console.error(error);
    showFatal(
      "Could not start the race",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return;
  }

  const activeWorld = world;
  // Handle for the measurement scripts, which need to read the camera's actual
  // per-frame motion. Harmless in production and the alternative is threading a
  // instrumentation seam through the render loop.
  (window as unknown as { __world?: World }).__world = activeWorld;

  hud = new Hud(seed, activeWorld.camera.modeLabel, {
    onCycleCamera: () => {
      // The label, not the mode id. `cycleMode` returns the internal name, so
      // the button had been relabelling itself "chase" and "wide" in lower
      // case after the first press.
      cameraMode = activeWorld.camera.cycleMode();
      saveCameraMode(cameraMode);
      return activeWorld.camera.modeLabel;
    },
  });
  showScreen(hud);

  const boundHud = hud;
  activeWorld.run(() => {
    boundHud.setClock(Math.max(0, activeWorld.race.simTime));
    boundHud.update(activeWorld.race.getStandings());
  });

  activeWorld.startCountdown(3);
}

function showResults(standings: Standing[]): void {
  const finishedSeed = seed;
  showScreen(
    new ResultsScreen(standings, finishedSeed, {
      onRematch: () => void startRace(),
      onNewTrack: () => {
        seed = randomSeed();
        void startRace();
      },
      onChangeRacers: () => showSetup(),
      onShare: async () => {
        const winner = standings[0]?.marble.player.name ?? "Nobody";
        const link = buildShareLink(finishedSeed, roster);
        const text = `${winner} won on seed ${finishedSeed} — try it: ${link}`;
        const shareable = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
        try {
          if (shareable.share) {
            await shareable.share({ title: "Marble Run", text, url: link });
            return "Shared";
          }
          await navigator.clipboard.writeText(text);
          return "Copied";
        } catch {
          return "Share unavailable";
        }
      },
    }),
  );
}

async function boot(): Promise<void> {
  showLoader("Warming up the physics engine…");

  const shared = readShareLink();
  seed = normaliseSeed(shared.seed ?? "");
  roster = shared.names ?? [];
  themeId = loadThemeId() ?? "";
  const savedCamera = loadCameraMode();
  if (isCameraMode(savedCamera)) cameraMode = savedCamera;

  try {
    await initPhysics();
  } catch (error) {
    console.error(error);
    showFatal(
      "Physics engine failed to load",
      "This needs WebAssembly and WebGL. Try a different browser, or check that nothing is blocking the download.",
    );
    return;
  }

  showSetup();
}

// A lost WebGL context (backgrounding a phone for a while will do it) leaves a
// dead canvas behind, so surface it rather than showing a frozen picture.
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  showFatal("Graphics context lost", "Reload the page to start a new race.");
});

// Handle for the palette analysis script, which measures how far apart the
// marble colours actually are in a perceptual colour space.
(window as unknown as { __palette?: typeof paletteFor }).__palette = paletteFor;
(window as unknown as { __pattern?: typeof patternFor }).__pattern = patternFor;

void boot();
