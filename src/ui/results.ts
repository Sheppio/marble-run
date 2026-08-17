import { el, formatTime, ordinal } from "./dom";
import { accentFor, loadAutoNext, saveAutoNext } from "./players";
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

/**
 * How long the results stay up before auto-advance moves on, in seconds.
 *
 * Long enough to read the podium and hear who won, short enough that nobody has
 * to reach for the phone between races.
 */
const AUTO_NEXT_SECONDS = 10;

export class ResultsScreen {
  readonly root: HTMLElement;

  private autoNext = loadAutoNext();
  private autoRemaining = AUTO_NEXT_SECONDS;
  private autoTimer: number | null = null;
  private autoButton: HTMLButtonElement | null = null;
  private newTrackButton: HTMLButtonElement | null = null;

  constructor(
    standings: Standing[],
    seed: string,
    private readonly callbacks: ResultsCallbacks,
  ) {
    this.root = el("div", { class: "screen results-screen" });
    this.build(standings, seed);
    if (this.autoNext) this.startAutoNext();
    else this.render();
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
        // Wears the pattern too. Without it a plain yellow marble and a
        // banded yellow one are the same disc up here, which is exactly the
        // pair the patterns exist to separate — and the list directly below
        // shows them correctly, so the podium contradicted it.
        const ball = el("span", {
          class: `podium-ball row-swatch swatch-p${marble.player.pattern}`,
        });
        ball.style.background = marble.player.color;
        ball.style.setProperty("--swatch-accent", accentFor(marble.player.color));
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
    this.newTrackButton = newTrack;

    const rematch = el("button", { class: "btn btn-ghost", type: "button", text: "Same track" });
    rematch.addEventListener("click", () => this.callbacks.onRematch());

    const changeRacers = el("button", { class: "btn btn-ghost", type: "button", text: "Racers" });
    changeRacers.addEventListener("click", () => this.callbacks.onChangeRacers());

    const share = el("button", { class: "btn btn-ghost", type: "button", text: "Share result" });
    share.addEventListener("click", async () => {
      // Sharing takes a moment and often leaves the app entirely, so it is not
      // something to be interrupted by the next race starting.
      this.stopAutoNext();
      const original = share.textContent;
      share.textContent = await this.callbacks.onShare();
      window.setTimeout(() => {
        share.textContent = original;
      }, 2200);
    });

    // Keeps a session rolling without anyone touching the phone. The countdown
    // is shown on the button that is about to be pressed rather than as a
    // separate ticker, so there is only one thing to read and it says what will
    // happen as well as when.
    const auto = el("button", {
      class: "btn btn-ghost btn-auto-next",
      type: "button",
      title: `Start a new track ${AUTO_NEXT_SECONDS} seconds after each race`,
    });
    auto.addEventListener("click", () => {
      this.autoNext = !this.autoNext;
      saveAutoNext(this.autoNext);
      if (this.autoNext) this.startAutoNext();
      else this.stopAutoNext();
    });
    this.autoButton = auto;

    this.root.append(
      header,
      podium,
      el("div", { class: "result-list" }, rows),
      el("div", { class: "action-row results-actions" }, [
        newTrack,
        rematch,
        changeRacers,
        share,
        auto,
      ]),
    );
  }

  private startAutoNext(): void {
    this.stopAutoNext();
    this.autoNext = true;
    this.autoRemaining = AUTO_NEXT_SECONDS;
    this.render();
    this.autoTimer = window.setInterval(() => {
      this.autoRemaining -= 1;
      if (this.autoRemaining <= 0) {
        this.stopAutoNext();
        this.callbacks.onNewTrack();
        return;
      }
      this.render();
    }, 1000);
  }

  /** Cancels the countdown without changing the saved preference. */
  private stopAutoNext(): void {
    if (this.autoTimer !== null) window.clearInterval(this.autoTimer);
    this.autoTimer = null;
    this.render();
  }

  private render(): void {
    if (this.autoButton) {
      this.autoButton.textContent = this.autoNext ? "Auto: on" : "Auto: off";
      this.autoButton.classList.toggle("btn-chip-active", this.autoNext);
      this.autoButton.setAttribute("aria-pressed", this.autoNext ? "true" : "false");
    }
    if (this.newTrackButton) {
      this.newTrackButton.textContent =
        this.autoTimer !== null ? `Next track (${this.autoRemaining})` : "Next track";
    }
  }

  dispose(): void {
    this.stopAutoNext();
    this.root.remove();
  }
}
