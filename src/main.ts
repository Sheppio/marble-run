import "./style.css";

import { el } from "./ui/dom";
import { SetupScreen } from "./ui/setup";
import { Hud } from "./ui/hud";
import { ResultsScreen } from "./ui/results";
import { buildShareLink, loadThemeId, makePlayers, readShareLink } from "./ui/players";
import { normaliseSeed, randomSeed } from "./core/seed";
import { World, initPhysics } from "./game/world";
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

async function startRace(): Promise<void> {
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

  hud = new Hud(seed, {
    onCycleCamera: () => activeWorld.camera.cycleMode(),
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

void boot();
