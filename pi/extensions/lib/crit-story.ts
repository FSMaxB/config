// Hunk headers in a crit story prep file look like `--- (path/to/file.ts, 42) [modified]`;
// the `(file_path, old_start)` pair is the id a story must reference the hunk by.
export function hunkIdsFromPrep(prep: string): string[] {
  return prep
    .split("\n")
    .map((line) => /^--- (\(.*, \d+\)) \[[^\]]+\]$/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

// crit prints this placeholder in the guide because `--guide` has no prep path of its own.
// Replacing it is best effort: an unknown crit version simply keeps its wording.
export function fillPrepPath(guide: string, prepPath: string): string {
  return guide.replaceAll("<run `crit story --prep <path>` first, then pass that path here>", prepPath);
}
