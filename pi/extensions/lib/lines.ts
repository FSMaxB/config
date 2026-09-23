export interface LineSplitter {
  push(chunk: string): void;
  flush(): void;
}

export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let pending = "";

  return {
    push(chunk: string): void {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line);
      }
    },
    flush(): void {
      if (pending) onLine(pending);
      pending = "";
    },
  };
}

// Offset is 1-based like the read tool's; a missing limit runs to the end.
export function pageLines<T>(items: T[], offset: number | undefined, limit: number | undefined): LinePage<T> {
  const start = Math.max((offset ?? 1) - 1, 0);
  if (start >= items.length) {
    return { kind: "past-end", message: `(no lines: offset ${start + 1} starts past the end of this ${items.length}-line file)` };
  }
  const page = items.slice(start, limit === undefined ? undefined : start + Math.max(limit, 0));
  return { kind: "page", items: page, header: `[lines ${start + 1}-${start + page.length} of ${items.length}]` };
}

export type LinePage<T> =
  | { kind: "page"; items: T[]; header: string }
  | { kind: "past-end"; message: string };
