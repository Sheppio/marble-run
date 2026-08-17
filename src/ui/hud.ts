import { clear, el, formatDistance, formatTime } from "./dom";
import { accentFor, loadBoardLayout, saveBoardLayout, type BoardLayout } from "./players";
import type { Standing } from "../game/race";

/**
 * In-race overlay: clock, live order, and the two controls worth having on a
 * phone — camera mode and a way to skip to the result.
 *
 * The leaderboard is rebuilt from a stable row-per-player pool rather than
 * from scratch each frame, so rows animate between positions instead of
 * flickering, and there is no per-frame allocation churn.
 */

/** Field sizes at which the board gains another column. */
const TWO_COLUMN_FROM = 5;
const THREE_COLUMN_FROM = 9;

export interface HudCallbacks {
  onCycleCamera(): string;
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
  private dockNode!: HTMLElement;
  private layoutButton!: HTMLButtonElement;
  private layout: BoardLayout = loadBoardLayout();
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

    this.boardNode = el("div", { class: "leaderboard" });

    // Swaps the board between a wide strip along the bottom and a single
    // column down the left. The column suits a big screen in landscape, where
    // there is height going spare and the bottom strip would run most of the
    // way across the picture.
    this.layoutButton = el("button", {
      class: "btn btn-board-toggle",
      type: "button",
      title: "Move the scoreboard",
    });
    this.layoutButton.addEventListener("click", () => {
      this.layout = this.layout === "bottom" ? "side" : "bottom";
      saveBoardLayout(this.layout);
      this.applyLayout();
      // The column count depends on the layout, so it has to be recomputed.
      this.laidOutFor = -1;
    });

    this.dockNode = el("div", { class: "board-dock" }, [this.layoutButton, this.boardNode]);

    this.cameraButton = el("button", {
      class: "btn btn-hud",
      type: "button",
      text: "Broadcast",
    });
    this.cameraButton.addEventListener("click", () => {
      this.cameraButton.textContent = this.callbacks.onCycleCamera();
    });

    // Seed, camera, clock across the top. The camera button used to sit at the
    // bottom, which held the scoreboard a button's height clear of the edge for
    // no reason — up here it costs nothing, since the top bar was already
    // there, and the board drops to the very bottom of the screen.
    const topBar = el("div", { class: "hud-top" }, [
      el("div", { class: "hud-seed" }, [
        el("span", { class: "hud-seed-label", text: "Seed" }),
        el("span", { class: "hud-seed-value", text: seed }),
      ]),
      this.cameraButton,
      this.clockNode,
    ]);

    this.countdownNode = el("div", { class: "countdown" });

    this.root.append(topBar, this.dockNode, this.countdownNode);
    this.applyLayout();
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
    this.markScrollable();

    for (const standing of standings) {
      const { marble } = standing;
      let row = this.rows.get(marble.player.id);

      if (!row) {
        const place = el("span", { class: "row-place" });
        // Carries the pattern as well as the colour. With a big field the
        // colours alone are close, and a swatch that only showed hue would be
        // no more tellable apart than the marbles it is meant to identify.
        const swatch = el("span", { class: `row-swatch swatch-p${marble.player.pattern}` });
        swatch.style.background = marble.player.color;
        swatch.style.setProperty("--swatch-accent", accentFor(marble.player.color));
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
   * covers the race it is reporting on. Splitting it gives that height back:
   * two columns from five racers, three from nine, so a full field of twelve
   * is four rows rather than twelve. Below five a single column is already
   * short, and splitting it would only cost width for no gain.
   */
  /**
   * Flags the side column when it has more rows than fit, which is what turns
   * the fade at its bottom edge on.
   */
  private markScrollable(): void {
    if (this.layout !== "side") return;
    const scrollable = this.boardNode.scrollHeight > this.boardNode.clientHeight + 1;
    this.boardNode.classList.toggle("is-scrollable", scrollable);
  }

  private applyLayout(): void {
    const side = this.layout === "side";
    this.dockNode.classList.toggle("board-dock-side", side);
    this.boardNode.classList.toggle("leaderboard-column", side);
    // The arrow points where pressing it will send the board.
    this.layoutButton.textContent = side ? "▤" : "▥";
    this.layoutButton.setAttribute(
      "aria-label",
      side ? "Move the scoreboard to the bottom" : "Move the scoreboard to the side",
    );
    if (!side) this.boardNode.classList.remove("is-scrollable");
  }

  private layoutFor(count: number): void {
    if (count === this.laidOutFor) return;
    this.laidOutFor = count;

    // Down the side it is always one column, however big the field.
    const columns =
      this.layout === "side" ? 1 : count >= THREE_COLUMN_FROM ? 3 : count >= TWO_COLUMN_FROM ? 2 : 1;
    this.boardNode.classList.toggle("leaderboard-split", columns > 1);
    this.boardNode.style.setProperty("--board-columns", String(columns));
    // Columns are filled top to bottom, so 1st sits above 2nd rather than
    // beside it and the ranking still reads down the page.
    this.boardNode.style.setProperty("--board-rows", String(Math.ceil(count / columns)));
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
