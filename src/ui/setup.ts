import { clear, el } from "./dom";
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  buildShareLink,
  colorFor,
  loadRoster,
  saveRoster,
} from "./players";
import { dailySeed, normaliseSeed, randomSeed } from "../core/seed";
import { generateTrack } from "../track/generator";
import { UNITS_PER_METRE } from "../track/plan";

/**
 * The setup screen: who is racing, and on which track.
 *
 * The track preview is generated for real — the same deterministic generator
 * the race uses — so the stats shown here are exactly the track you get.
 * Generation is pure maths with no rendering, so it costs a few milliseconds.
 */

export interface SetupResult {
  names: string[];
  seed: string;
}

export class SetupScreen {
  readonly root: HTMLElement;
  private names: string[];
  private seed: string;
  private listNode!: HTMLElement;
  private previewNode!: HTMLElement;
  private addButton!: HTMLButtonElement;
  private seedInput!: HTMLInputElement;
  private previewTimer: number | null = null;

  constructor(
    initial: { names?: string[]; seed?: string },
    private readonly onStart: (result: SetupResult) => void,
  ) {
    this.names = initial.names ?? loadRoster();
    this.seed = normaliseSeed(initial.seed ?? dailySeed());
    this.root = el("div", { class: "screen setup-screen" });
    this.build();
  }

  private build(): void {
    const title = el("header", { class: "title-block" }, [
      el("h1", { class: "title", text: "Marble Run" }),
      el("p", {
        class: "tagline",
        text: "Same seed, same track, same result. Pick your racers and let physics decide.",
      }),
    ]);

    this.listNode = el("div", { class: "racer-list" });
    this.addButton = el("button", {
      class: "btn btn-ghost btn-add",
      type: "button",
      text: "+ Add racer",
    });
    this.addButton.addEventListener("click", () => {
      if (this.names.length >= MAX_PLAYERS) return;
      this.names.push("");
      this.persist();
      this.renderRacers();
      // Focus the row we just added so a name can be typed straight away.
      const inputs = this.listNode.querySelectorAll<HTMLInputElement>("input");
      inputs[inputs.length - 1]?.focus();
    });

    const racersSection = el("section", { class: "panel" }, [
      el("h2", { class: "panel-title", text: "Racers" }),
      this.listNode,
      this.addButton,
    ]);

    this.seedInput = el("input", {
      class: "seed-input",
      type: "text",
      value: this.seed,
      maxlength: 32,
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: false,
      "aria-label": "Track seed",
    });
    this.seedInput.addEventListener("input", () => {
      this.seed = normaliseSeed(this.seedInput.value);
      this.schedulePreview();
    });

    const dailyButton = el("button", { class: "btn btn-chip", type: "button", text: "Today's track" });
    dailyButton.addEventListener("click", () => this.setSeed(dailySeed()));

    const randomButton = el("button", { class: "btn btn-chip", type: "button", text: "Surprise me" });
    randomButton.addEventListener("click", () => this.setSeed(randomSeed()));

    this.previewNode = el("div", { class: "track-preview" });

    const seedSection = el("section", { class: "panel" }, [
      el("h2", { class: "panel-title", text: "Track seed" }),
      el("div", { class: "seed-row" }, [this.seedInput]),
      el("div", { class: "chip-row" }, [dailyButton, randomButton]),
      this.previewNode,
    ]);

    const startButton = el("button", {
      class: "btn btn-primary btn-start",
      type: "button",
      text: "Start race",
    });
    startButton.addEventListener("click", () => {
      const names = this.collectNames();
      if (names.length < MIN_PLAYERS) return;
      saveRoster(names);
      this.onStart({ names, seed: this.seed || dailySeed() });
    });

    const shareButton = el("button", {
      class: "btn btn-ghost btn-share",
      type: "button",
      text: "Copy invite link",
    });
    shareButton.addEventListener("click", async () => {
      const link = buildShareLink(this.seed, this.collectNames());
      const original = shareButton.textContent;
      try {
        await navigator.clipboard.writeText(link);
        shareButton.textContent = "Link copied";
      } catch {
        // Clipboard access can be refused; showing the link still lets them copy it.
        shareButton.textContent = link;
      }
      window.setTimeout(() => {
        shareButton.textContent = original;
      }, 2200);
    });

    this.root.append(
      title,
      racersSection,
      seedSection,
      el("div", { class: "action-row" }, [startButton, shareButton]),
      el("p", {
        class: "footnote",
        text: "Everyone races on one screen. Share the seed to run the identical track elsewhere.",
      }),
    );

    this.renderRacers();
    this.renderPreview();
  }

  private setSeed(seed: string): void {
    this.seed = normaliseSeed(seed);
    this.seedInput.value = this.seed;
    this.renderPreview();
  }

  private collectNames(): string[] {
    return this.names
      .map((name, i) => name.trim() || `Racer ${i + 1}`)
      .slice(0, MAX_PLAYERS);
  }

  private renderRacers(): void {
    clear(this.listNode);

    this.names.forEach((name, index) => {
      const swatch = el("span", { class: "swatch" });
      swatch.style.background = colorFor(index);

      const input = el("input", {
        class: "racer-input",
        type: "text",
        value: name,
        maxlength: 16,
        placeholder: `Racer ${index + 1}`,
        autocomplete: "off",
        "aria-label": `Name of racer ${index + 1}`,
      });
      input.addEventListener("input", () => {
        this.names[index] = input.value;
        // Persist as they type. Saving only on "Start race" lost the roster
        // to any reload, which is exactly when you most want it back.
        this.persist();
      });

      const remove = el("button", {
        class: "btn btn-remove",
        type: "button",
        "aria-label": `Remove racer ${index + 1}`,
        text: "×",
      });
      remove.disabled = this.names.length <= MIN_PLAYERS;
      remove.addEventListener("click", () => {
        this.names.splice(index, 1);
        this.persist();
        this.renderRacers();
      });

      this.listNode.append(el("div", { class: "racer-row" }, [swatch, input, remove]));
    });

    this.addButton.disabled = this.names.length >= MAX_PLAYERS;
    this.addButton.textContent =
      this.names.length >= MAX_PLAYERS ? `Maximum ${MAX_PLAYERS} racers` : "+ Add racer";
  }

  /** Remembers the roster for next time, blanks and all. */
  private persist(): void {
    saveRoster(this.names);
  }

  /** Debounced so typing a seed doesn't regenerate a track on every keystroke. */
  private schedulePreview(): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.renderPreview();
    }, 220);
  }

  private renderPreview(): void {
    clear(this.previewNode);
    const seed = this.seed || dailySeed();

    let plan;
    try {
      plan = generateTrack(seed);
    } catch {
      this.previewNode.append(el("p", { class: "preview-error", text: "Could not build that track — try another seed." }));
      return;
    }

    const stats = el("div", { class: "stat-row" }, [
      stat(`${(plan.totalLength / UNITS_PER_METRE).toFixed(1)} m`, "Length"),
      stat(`${Math.round((plan.totalDrop / UNITS_PER_METRE) * 100)} cm`, "Drop"),
      stat(String(plan.obstacles.length), "Obstacles"),
    ]);

    const tags = el(
      "div",
      { class: "tag-row" },
      plan.highlights.map((h) => el("span", { class: "tag", text: h })),
    );

    this.previewNode.append(stats, tags);
  }

  dispose(): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.root.remove();
  }
}

function stat(value: string, label: string): HTMLElement {
  return el("div", { class: "stat" }, [
    el("span", { class: "stat-value", text: value }),
    el("span", { class: "stat-label", text: label }),
  ]);
}
