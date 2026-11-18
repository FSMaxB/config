import type { Api, Model } from "@earendil-works/pi-ai";

export type GetModels = (provider: string) => readonly Model<Api>[];

// pi-ai/compat only exists in pi-ai versions that moved getModels out of the package root, so the
// specifier goes through a variable that TypeScript does not resolve at compile time.
function dynamicImport(specifier: string): Promise<unknown> {
	return import(specifier);
}

export async function resolveGetModels(
	root: object,
	loadCompat: () => Promise<unknown> = () => dynamicImport("@earendil-works/pi-ai/compat"),
): Promise<GetModels> {
	const fromRoot = getModelsExport(root);
	if (fromRoot) return fromRoot;
	const compat = await loadCompat();
	const fromCompat = typeof compat === "object" && compat !== null ? getModelsExport(compat) : undefined;
	if (!fromCompat) throw new Error("pi-ai getModels API is unavailable");
	return fromCompat;
}

// Which module exports getModels differs between pi-ai versions; its signature does not.
function getModelsExport(module: object): GetModels | undefined {
	const value: unknown = Reflect.get(module, "getModels");
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- getModels has the same signature in every pi-ai version
	return typeof value === "function" ? (value as GetModels) : undefined;
}
