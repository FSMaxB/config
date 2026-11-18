import { isRecord } from "./untyped.ts";

export function isExploreAlwaysOn(settings: object): boolean {
  const exploreMode: unknown = Reflect.get(settings, "exploreMode");
  return isRecord(exploreMode) && exploreMode.alwaysOn === true;
}
