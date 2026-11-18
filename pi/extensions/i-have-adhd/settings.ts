import { isRecord } from "../lib/untyped.ts";

export function isAlwaysOn(settings: object): boolean {
  const adhdSettings: unknown = Reflect.get(settings, "iHaveAdhd");
  return isRecord(adhdSettings) && adhdSettings.alwaysOn === true;
}
