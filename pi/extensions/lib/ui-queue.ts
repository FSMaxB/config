// ui.select() and ui.input() own the terminal, and pi dispatches tool batches through
// executeToolCallsParallel, so prompts raised from different extensions in the same batch
// would fight over it. Everything that prompts goes through this one chain.
let chain: Promise<void> = Promise.resolve();

export function serialize<T>(task: () => Promise<T>): Promise<T> {
	const result = chain.then(task, task);
	chain = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}
