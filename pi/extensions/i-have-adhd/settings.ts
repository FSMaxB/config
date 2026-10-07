type AdhdSettings = {
  iHaveAdhd?: { alwaysOn?: unknown };
};

export function isAlwaysOn(settings: object): boolean {
  const { iHaveAdhd } = settings as AdhdSettings;
  return iHaveAdhd?.alwaysOn === true;
}
