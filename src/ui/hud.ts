import { clear, el, formatDistance, formatTime } from "./dom";
import type { Standing } from "../game/race";

/**
 * In-race overlay: clock, live order, and the two controls worth having on a
 * phone — camera mode and a way to skip to the result.
 *
 * The leaderboard is rebuilt from a stable row-per-player pool rather than
 * from scratch each frame, so rows animate between positions instead of
 * flickering, and there is no per-frame allocation churn.
 */

/** Field size at which the board splits into two columns. */
const TWO_COLUMN_FROM = 5;

export interface HudCallbacks {
  onCycleCamera(): string;
  onSkip(): void;
}

interface Row {
  node: HTMLElement;
  place: HTMLElement;
  name: HTMLElement;
  detail: HTMLElement;
  bar: HTMLElement;
}

export class Hud {
  readonly root: HTMLElement;
  private clockNode!: HTMLElement;
  private boardNode!: HTMLElement;
  private countdownNode!: HTMLElement;
  private cameraButton!: HTMLButtonElement;
  private rows = new Map<number, Row>();
  /** Field size the board is currently laid out for. */
  private laidOutFor = -1;

  constructor(
    seed: string,
    private readonly callbacks: HudCallbacks,
  ) {
    this.root = el("div", { class: "screen hud-screen" });
    this.build(seed);
  }

  private build(seed: string): void {
    this.clockNode = el("span", { class: "clock", text: "0.00" });

    const topBar = el("div", { class: "hud-top" }, [
      el("div", { class: "hud-seed" }, [
        el("span", { class: "hud-seed-label", text: "Seed" }),
        el("span", { class: "hud-seed-value", text: seed }),
      ]),
      this.clockNode,
    ]);

    this.boardNode = el("div", { class: "leaderboard" });

    this.cameraButton = el("button", {
      class: "btn btn-hud",
      type: "button",
      text: "Broadcast",
    });
    this.cameraButton.addEventListener("click", () => {
      this.cameraButton.textContent = this.callbacks.onCycleCamera();
    });

    const skipButton = el("button", { class: "btn btn-hud", type: "button", text: "Skip to result" });
    skipButton.addEventListener("click", () => this.callbacks.onSkip());

    this.countdownNode = el("div", { class: "countdown" });

    this.root.append(
      topBar,
      this.boardNode,
      el("div", { class: "hud-controls" }, [this.cameraButton, skipButton]),
      this.countdownNode,
    );
  }

  showCountdown(value: number): void {
    this.countdownNode.textContent = value > 0 ? String(value) : "GO!";
    this.countdownNode.classList.remove("pulse");
    // Restarting the animation requires a reflow between class changes.
    void this.countdownNode.offsetWidth;
    this.countdownNode.classList.add("pulse");
    if (value <= 0) {
      window.setTimeout(() => {
        this.countdownNode.textContent = "";
        this.countdownNode.classList.remove("pulse");
      }, 700);
    }
  }

  setClock(seconds: number): void {
    this.clockNode.textContent = formatTime(Math.max(0, seconds));
  }

  update(standings: Standing[]): void {
    this.layoutFor(standings.length);

    for (const standing of standings) {
      const { marble } = standing;
      let row = this.rows.get(marble.player.id);

      if (!row) {
        const place = el("span", { class: "row-place" });
        const swatch = el("span", { class: "row-swatch" });
        swatch.style.background = marble.player.color;
        const name = el("span", { class: "row-name", text: marble.player.name });
        const detail = el("span", { class: "row-detail" });
        const bar = el("span", { class: "row-bar-fill" });
        bar.style.background = marble.player.color;

        const node = el("div", { class: "board-row" }, [
          place,
          swatch,
          el("span", { class: "row-body" }, [
            name,
            el("span", { class: "row-bar" }, [bar]),
          ]),
          detail,
        ]);
        row = { node, place, name, detail, bar };
        this.rows.set(marble.player.id, row);
        this.boardNode.append(node);
      }

      row.place.textContent = String(standing.place);
      row.bar.style.width = `${Math.round(standing.progress * 100)}%`;
      row.node.classList.toggle("finished", marble.finished);
      row.detail.textContent = marble.finished
        ? formatTime(marble.finishTime)
        : standing.place === 1
          ? "leader"
          : `−${formatDistance(standing.gapToLeader)}`;

      // Ordering rows by CSS `order` avoids re-parenting nodes every frame,
      // which is what lets the position swaps animate smoothly.
      row.node.style.order = String(standing.place);
    }
  }

  /**
   * Splits the board into two columns once the field is big enough.
   *
   * A single column of eight rows runs most of the way down a phone screen and
   * covers the race it is reporting on. Two columns of four take the same
   * information and give back half the height, which on the shot that matters —
   * a marble mid-corner, filling the frame — is the difference between seeing
   * it and not. Below five racers a single column is already short, and
   * splitting it just makes the board wider for no gain.
   */
  private layoutFor(count: number): void {
    if (count === this.laidOutFor) return;
    this.laidOutFor = count;
    const twoColumns = count >= TWO_COLUMN_FROM;
    this.boardNode.classList.toggle("leaderboard-split", twoColumns);
    // Columns are filled top to bottom, so 1st sits above 2nd rather than
    // beside it and the ranking still reads down the page.
    this.boardNode.style.setProperty(
      "--board-rows",
      String(twoColumns ? Math.ceil(count / 2) : count),
    );
  }

  reset(): void {
    this.laidOutFor = -1;
    clear(this.boardNode);
    this.rows.clear();
  }

  dispose(): void {
    this.root.remove();
  }
}
