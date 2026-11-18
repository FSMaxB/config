// srt and the path rules read a path that contains any of these characters as a glob pattern.
export function hasGlobCharacters(path: string): boolean {
  return /[*?[\]]/.test(path);
}
