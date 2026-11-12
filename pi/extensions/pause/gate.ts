export type PauseState = "running" | "pausing" | "paused";

export type HoldOptions = {
  signal: AbortSignal | undefined;
  hasPendingMessages: () => boolean;
  pollIntervalMs: number;
};

export class PauseGate {
  #state: PauseState = "running";
  #release: (() => void) | undefined;

  get state(): PauseState {
    return this.#state;
  }

  toggle(): void {
    if (this.#state === "running") {
      this.#state = "pausing";
      return;
    }
    this.reset();
  }

  /** Holds a turn boundary until toggled, reset, a user message is queued, or the run is aborted. */
  hold({ signal, hasPendingMessages, pollIntervalMs }: HoldOptions): Promise<void> {
    if (signal?.aborted) {
      this.#state = "running";
      return Promise.resolve();
    }
    this.#state = "paused";
    return new Promise((resolve) => {
      const release = () => {
        clearInterval(poll);
        signal?.removeEventListener("abort", release);
        this.#release = undefined;
        this.#state = "running";
        resolve();
      };
      const poll = setInterval(() => {
        if (hasPendingMessages()) release();
      }, pollIntervalMs);
      signal?.addEventListener("abort", release, { once: true });
      this.#release = release;
    });
  }

  reset(): void {
    this.#state = "running";
    this.#release?.();
  }
}
