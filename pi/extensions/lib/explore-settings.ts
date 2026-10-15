type ExploreSettings = {
  exploreMode?: { alwaysOn?: unknown };
};

export function isExploreAlwaysOn(settings: object): boolean {
  const { exploreMode } = settings as ExploreSettings;
  return exploreMode?.alwaysOn === true;
}
