/** DAP integers are local handles. Canonical DDB IDs must never be decoded. */
export class Handles<T> {
	private next = 1;
	private readonly values = new Map<number, T>();
	private readonly keys = new Map<string, number>();

	get(id: number): T {
		const value = this.values.get(id);
		if (value === undefined) throw new Error(`Unknown or expired debugger handle ${id}`);
		return value;
	}

	put(value: T, key?: string): number {
		const existing = key === undefined ? undefined : this.keys.get(key);
		if (existing !== undefined) {
			this.values.set(existing, value);
			return existing;
		}
		if (this.next > 0x7fffffff) throw new Error("Debugger handle capacity exhausted");
		const id = this.next++;
		this.values.set(id, value);
		if (key !== undefined) this.keys.set(key, id);
		return id;
	}

	/** Never reuse an expired handle, even after a server restart. */
	clear(): void {
		this.values.clear();
		this.keys.clear();
	}
}
