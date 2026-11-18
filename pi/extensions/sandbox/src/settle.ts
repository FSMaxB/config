import { setTimeout as sleep } from "node:timers/promises";

// Violation reports (macOS `log stream`, the Linux monitor socket) land a moment after the child
// exits, sometimes later than any single fixed wait, so polling goes on until the count stops
// changing. Short enough that a report does not visibly lag; six polls give late reports 1.5 s.
export const SETTLE_POLL_MILLISECONDS = 250;
const SETTLE_MAX_POLLS = 6;

export async function waitUntilCountSettles(count: () => number): Promise<void> {
  let previous: number | undefined;
  for (let poll = 0; poll < SETTLE_MAX_POLLS; poll += 1) {
    await sleep(SETTLE_POLL_MILLISECONDS);
    const current = count();
    if (current === previous) return;
    previous = current;
  }
}
