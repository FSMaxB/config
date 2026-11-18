export type GetModels = (provider: string) => any[];
// pi-ai/compat only exists in pi-ai versions that moved getModels out of the package root, so the
// specifier goes through a variable that TypeScript does not resolve at compile time.
function dynamicImport(specifier: string): Promise<unknown> {
	return import(specifier);
}

export async function resolveGetModels(
	root: any,
	loadCompat: () => Promise<any> = () => dynamicImport("@earendil-works/pi-ai/compat"),
): Promise<GetModels> {
	if (typeof root?.getModels === "function") return root.getModels;
	const compat = await loadCompat();
	if (typeof compat?.getModels !== "function") throw new Error("pi-ai getModels API is unavailable");
	return compat.getModels;
}