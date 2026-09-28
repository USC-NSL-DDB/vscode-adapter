import {
	DdbProtocolError,
	type Snapshot,
	type StateEvent,
	type ResourceUpsert,
	type Cursor,
} from "@ddb-debugger/api-client";

const resources = {
	session: ["sessions", "sessionId", "RESOURCE_KIND_SESSION"],
	group: ["groups", "groupId", "RESOURCE_KIND_GROUP"],
	process: ["processes", "processId", "RESOURCE_KIND_PROCESS"],
	thread: ["threads", "threadId", "RESOURCE_KIND_THREAD"],
	selection: ["selection", "selectionId", "RESOURCE_KIND_SELECTION"],
	executionState: [
		"executionStates",
		"executionStateId",
		"RESOURCE_KIND_EXECUTION_STATE",
	],
	breakpoint: ["breakpoints", "breakpointId", "RESOURCE_KIND_BREAKPOINT"],
	operation: ["operations", "operationId", "RESOURCE_KIND_OPERATION"],
	capabilities: [
		"capabilities",
		"capabilitiesId",
		"RESOURCE_KIND_CAPABILITIES",
	],
	extensionState: [
		"extensionStates",
		"extensionStateId",
		"RESOURCE_KIND_EXTENSION_STATE",
	],
	pendingCommand: [
		"pendingCommands",
		"pendingCommandId",
		"RESOURCE_KIND_PENDING_COMMAND",
	],
} as const satisfies Record<keyof ResourceUpsert, readonly string[]>;

type Kind = keyof ResourceUpsert;
type Resource = NonNullable<ResourceUpsert[Kind]>;

function revision(value: string | undefined): bigint {
	if (value === undefined) return 0n; // ProtoJSON omits default-valued uint64 fields.
	if (!/^\d+$/.test(value))
		throw new DdbProtocolError("Missing or invalid state revision");
	return BigInt(value);
}

/** Revision-aware snapshot plus event projection. Tombstones prevent resurrection. */
export class DdbState {
	private readonly items = new Map<Kind, Map<string, Resource>>();
	private readonly versions = new Map<string, bigint>();
	private instance?: string;
	private checkpoint?: Cursor;

	get serverInstanceId(): string | undefined {
		return this.instance;
	}
	get cursor(): Cursor | undefined {
		return this.checkpoint;
	}

	all<K extends Kind>(kind: K): NonNullable<ResourceUpsert[K]>[] {
		return [...(this.items.get(kind)?.values() ?? [])] as NonNullable<
			ResourceUpsert[K]
		>[];
	}

	get<K extends Kind>(kind: K, id: string): ResourceUpsert[K] {
		return this.items.get(kind)?.get(id) as ResourceUpsert[K];
	}

	hydrate(snapshot: Snapshot): void {
		if (
			!snapshot.serverInstanceId ||
			snapshot.stateEventCursor?.serverInstanceId !== snapshot.serverInstanceId
		) {
			throw new DdbProtocolError(
				"Snapshot cursor does not match its server instance",
			);
		}
		revision(snapshot.stateEventCursor.sequence);
		const next = new DdbState();
		next.instance = snapshot.serverInstanceId;
		next.checkpoint = snapshot.stateEventCursor;
		for (const kind of Object.keys(resources) as Kind[]) {
			const [field, idField] = resources[kind];
			const value = snapshot[field];
			const values =
				value === undefined ? [] : Array.isArray(value) ? value : [value];
			for (const resource of values) {
				const id = (resource as Record<string, unknown>)[idField];
				if (typeof id !== "string" || !id)
					throw new DdbProtocolError(`Snapshot ${kind} is missing its ID`);
				next.set(kind, id, revision(resource.revision), resource);
			}
		}
		this.items.clear();
		this.versions.clear();
		for (const [kind, values] of next.items) this.items.set(kind, values);
		for (const [key, rev] of next.versions) this.versions.set(key, rev);
		this.instance = next.instance;
		this.checkpoint = next.checkpoint;
	}

	/** Returns false for duplicate or stale events. Resync must precede more reads. */
	apply(event: StateEvent): boolean {
		if (event.requiredResync) throw new ResyncRequired();
		if (!this.instance || event.cursor?.serverInstanceId !== this.instance)
			throw new ResyncRequired();
		const sequence = revision(event.cursor.sequence);
		if (sequence <= revision(this.checkpoint?.sequence)) return false;
		const kind = (Object.keys(resources) as Kind[]).find(
			(key) => resources[key][2] === event.resourceKind,
		);
		if (!kind) {
			this.checkpoint = event.cursor; // Unknown additive resource kinds do not invalidate known state.
			return false;
		}
		const id = event.resourceId;
		if (!id)
			throw new DdbProtocolError("State event is missing its resource ID");
		const rev = revision(event.resourceRevision);
		const resource = event.upsert?.[kind];
		if (resource) {
			if (
				(resource as Record<string, unknown>)[resources[kind][1]] !== id ||
				revision(resource.revision) !== rev
			) {
				throw new DdbProtocolError(
					"State event resource identity or revision mismatch",
				);
			}
		} else if (
			!event.deleted ||
			event.deleted.resourceId !== id ||
			event.deleted.resourceKind !== event.resourceKind ||
			revision(event.deleted.resourceRevision) !== rev
		) {
			throw new DdbProtocolError(
				"State event is missing a matching upsert or tombstone",
			);
		}
		const changed = this.set(kind, id, rev, resource);
		this.checkpoint = event.cursor;
		return changed;
	}

	private set(kind: Kind, id: string, rev: bigint, value?: Resource): boolean {
		const key = JSON.stringify([kind, id]);
		const previous = this.versions.get(key);
		if (previous !== undefined && rev <= previous) return false;
		this.versions.set(key, rev);
		let collection = this.items.get(kind);
		if (!collection) this.items.set(kind, (collection = new Map()));
		if (value === undefined) collection.delete(id);
		else collection.set(id, value);
		return true;
	}
}

export class ResyncRequired extends Error {
	constructor() {
		super("DDB state requires a fresh snapshot");
	}
}
