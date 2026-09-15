/** Trace SDK requests without exposing authentication or debugger payloads. */
export function diagnosticFetch(log: (message: string) => void, fetch: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
	let sequence = 0;
	return async (input, init) => {
		const id = ++sequence;
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		const label = `${id} ${method} ${url.pathname}`;
		log(`[DDB API] ${label}\n`);
		try {
			const response = await fetch(input, init);
			log(`[DDB API] ${label} -> ${response.status}\n`);
			return response;
		} catch (error) {
			log(`[DDB API] ${label} -> transport failed\n`);
			throw error;
		}
	};
}
