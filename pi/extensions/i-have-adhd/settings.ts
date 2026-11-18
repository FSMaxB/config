import { isRecord } from "../lib/untyped.ts";

export function isAlwaysOn(settings: object): boolean {
  const iHaveAdhd: unknown = Reflect.get(settings, "iHaveAdhd");
  return isRecord(iHaveAdhd) && iHaveAdhd.alwaysOn === true;
}
