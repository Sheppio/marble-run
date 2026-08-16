import { el, formatTime, ordinal } from "./dom";
import { accentFor } from "./players";
import type { Standing } from "../game/race";

/**
 * Post-race results: podium, full order, and where to go next.
 */

export interface ResultsCallbacks {
  onRematch(): void;
  onNewTrack(): void;
  onChangeRacers(): void;
  onShare(): Promise<string> | string;
}

export class ResultsScreen {
  readonly root: HTMLElement;

  constructor(
    standings: Standing[],
    seed: string,
    private readonly callbacks: ResultsCallbacks,
  ) {
    this.root = el("div", { class: "screen results-screen" });
    this.build(standings, seed);
  }

  private build(standings: Standing[], seed: string): void {
    const winner = standings[0];

    const header = el("header", { class: "results-header" }, [
      el("p", { class: "results-eyebrow", text: "Winner" }),
      el("h1", { class: "results-winner", text: winner?.marble.player.name ?? "Nobody" }),
      el("p", {
        class: "results-time",
        text: winner?.marble.finishTime !== null && winner?.marble.finishTime !== undefined
          ? `${formatTime(winner.marble.finishTime)} on seed ${seed}`
          : `Seed ${seed}`,
      }),
    ]);

    // Podium, in visual order: second, first, third.
    const podiumOrder = [standings[1], standings[0], standings[2]].filter(Boolean);
    const podium = el(
      "div",
      { class: "podium" },
      podiumOrder.map((standing) => {
        const marble = standing.marble;
        const ball = el("span", { class: "podium-ball" });
        ball.style.background = marble.player.color;
        ball.style.boxShadow = `0 0 24px ${marble.player.color}66`;
        return el("div", { class: `podium-slot place-${standing.place}` }, [
          ball,
          el("span", { class: "podium-name", text: marble.player.name }),
          el("span", { class: "podium-place", text: ordinal(standing.place) }),
          el("span", { class: "podium-block" }),
        ]);
      }),
    );

    const leaderStanding = standings[0];
    const rows = standings.map((standing) => {
      const marble = standing.marble;
      const swatch = el("span", { class: `row-swatch swatch-p${marble.player.pattern}` });
      swatch.style.background = marble.player.color;
      swatch.style.setProperty("--swatch-accent", accentFor(marble.player.color));

      const gap =
        marble.finishTime !== null && leaderStanding.marble.finishTime !== null && standing.place > 1
          ? `+${(marble.finishTime - leaderStanding.marble.finishTime).toFixed(2)}s`
          : marble.finished
            ? ""
            : `${Math.round(standing.progress * 100)}% — did not finish`;

      return el("div", { class: "result-row" }, [
        el("span", { class: "row-place", text: String(standing.place) }),
        swatch,
        el("span", { class: "row-name", text: marble.player.name }),
        el("span", { class: "row-detail" }, [
          el("span", { class: "result-time", text: formatTime(marble.finishTime) }),
          el("span", { class: "result-gap", text: gap }),
        ]),
      ]);
    });

    // A fresh track is the primary action, not a rematch. Once a race has been
    // watched its track holds no surprises — the interesting thing is what the
    // next seed builds — so the button most likely to be pressed is the one
    // that generates a new one. Re-running the same track is still there for
    // settling an argument about a close finish.
    const newTrack = el("button", { class: "btn btn-primary", type: "button", text: "Next track" });
    newTrack.addEventListener("click", () => this.callbacks.onNewTrack());

    const rematch = el("button", { class: "btn btn-ghost", type: "button", text: "Same track" });
    rematch.addEventListener("click", () => this.callbacks.onRematch());

    const changeRacers = el("button", { class: "btn btn-ghost", type: "button", text: "Racers" });
    changeRacers.addEventListener("click", () => this.callbacks.onChangeRacers());

    const share = el("button", { class: "btn btn-ghost", type: "button", text: "Share result" });
    share.addEventListener("click", async () => {
      const original = share.textContent;
      share.textContent = await this.callbacks.onShare();
      window.setTimeout(() => {
        share.textContent = original;
      }, 2200);
    });

    this.root.append(
      header,
      podium,
      el("div", { class: "result-list" }, rows),
      el("div", { class: "action-row results-actions" }, [newTrack, rematch, changeRacers, share]),
    );
  }

  dispose(): void {
    this.root.remove();
  }
}
