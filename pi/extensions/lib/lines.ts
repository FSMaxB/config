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
