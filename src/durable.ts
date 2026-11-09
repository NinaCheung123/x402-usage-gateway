/**
 * Durable channel records, so a restart can't strand locked funds or lose what
 * a seller has earned. x402 ships in-memory stores; these keep the same
 * behaviour and write a JSON snapshot after each change. One process per file:
 * this suits a single gateway, and a larger deployment should use a database.
 */
import type {
  BatchOperation,
  BatchOperationStore,
  ChannelState,
  ChannelStore,
} from "@x402/svm/batch-settlement/server";
import { MemoryChannelStore } from "@x402/svm/batch-settlement/server";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

// JSON has no bigint, and channel amounts are bigints.
const encode = (_k: string, v: unknown) => (typeof v === "bigint" ? { $bigint: v.toString() } : v);
const decode = (_k: string, v: unknown) =>
  v && typeof v === "object" && "$bigint" in v ? BigInt((v as { $bigint: string }).$bigint) : v;

function save(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, encode));
  renameSync(tmp, path); // Atomic: a crash leaves the previous snapshot intact.
}

const load = <T>(path: string): T | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8"), decode) as T) : undefined;

/**
 * Wraps a facilitator's in-memory channel storage. x402 exposes no snapshot
 * method, so this reads its `channels` map. Pinned to the installed version's
 * shape; `tests/durable.test.ts` fails if that shape changes.
 */
export function durableStorage<T extends object>(store: T, path: string): T {
  const internal = store as unknown as { channels: Map<string, unknown> };
  if (!(internal.channels instanceof Map)) throw new Error("channel storage shape changed: no channels map");
  for (const [k, v] of load<[string, unknown][]>(path) ?? []) internal.channels.set(k, v);
  const readOnly = new Set(["get", "list"]);
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!readOnly.has(String(prop))) save(path, [...internal.channels]);
        return result;
      };
    },
  });
}

/**
 * The seller's unclaimed vouchers. These are money: losing them means losing
 * what metered calls earned, so every change is written before it returns.
 */
export class DurableChannelStore implements ChannelStore {
  private inner = new MemoryChannelStore();
  private ready: Promise<void>;

  constructor(private path: string) {
    this.ready = (async () => {
      for (const s of load<ChannelState[]>(path) ?? []) await this.inner.put(s);
    })();
  }

  private async persist() {
    save(this.path, await this.inner.list());
  }

  async get(id: string) {
    await this.ready;
    return this.inner.get(id);
  }

  async list() {
    await this.ready;
    return this.inner.list();
  }

  async put(state: ChannelState) {
    await this.ready;
    await this.inner.put(state);
    await this.persist();
  }

  /** The same store, listing only channels that pay this wallet. */
  forReceiver(receiver: string): ChannelStore {
    return {
      get: (id) => this.get(id),
      put: (state) => this.put(state),
      update: (id, updater) => this.update(id, updater),
      list: async () => (await this.list()).filter((c) => c.receiver === receiver),
    };
  }

  async update(id: string, updater: (c: ChannelState | undefined) => ChannelState | Promise<ChannelState>) {
    await this.ready;
    const result = await this.inner.update(id, updater);
    await this.persist();
    return result;
  }
}

/**
 * Every batch request ID the gateway has accepted. This is what stops a used
 * payment proof from being charged again, so it has to outlive a restart.
 *
 * A reservation reaches the disk before the model runs. A crash at any later
 * point therefore leaves the request refused, not repeatable, so an agent can't
 * pay twice. `src/interrupted.ts` then settles what's left of that call. Entries
 * are kept for good, because a proof stays valid while its channel does.
 */
export class DurableOperationStore implements BatchOperationStore {
  private operations = new Map<string, BatchOperation>();
  private fd: number;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    let endsCleanly = true;
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      endsCleanly = !text || text.endsWith("\n");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const op = JSON.parse(line, decode) as BatchOperation;
          this.operations.set(this.key(op.channelId, op.requestId), op);
        } catch {
          console.warn(`[operations] skipped an unreadable line in ${path}`);
        }
      }
    }
    this.fd = openSync(path, "a");
    if (!endsCleanly) writeSync(this.fd, "\n");
  }

  private key = (channelId: string, requestId: string) => `${channelId}\0${requestId}`;

  /** Writes to disk first: if this fails, the request fails before any work runs. */
  private record(op: BatchOperation) {
    writeSync(this.fd, JSON.stringify(op, encode) + "\n");
    fsyncSync(this.fd);
    this.operations.set(this.key(op.channelId, op.requestId), op);
  }

  async get(channelId: string, requestId: string) {
    return this.operations.get(this.key(channelId, requestId));
  }

  async reserve(channelId: string, requestId: string, ceiling: bigint) {
    const existing = this.operations.get(this.key(channelId, requestId));
    if (existing) return { created: false, operation: existing };
    const operation: BatchOperation = { status: "reserved", channelId, requestId, ceiling };
    this.record(operation);
    return { created: true, operation };
  }

  async complete(operation: Extract<BatchOperation, { status: "completed" }>) {
    const existing = this.operations.get(this.key(operation.channelId, operation.requestId));
    if (!existing || existing.status !== "reserved" || existing.ceiling !== operation.ceiling)
      throw new Error("batch operation reservation changed");
    this.record(operation);
  }

  /** A failed request stays recorded, so its proof can't be used again. */
  async release(_channelId: string, _requestId: string) {}

  close() {
    closeSync(this.fd);
  }
}

/** On-chain batch claims per wallet, which feed the network fee estimate. */
export class TransactionCounter {
  private counts: Record<string, number>;

  constructor(private path: string) {
    this.counts = load<Record<string, number>>(path) ?? {};
  }

  add(key: string) {
    this.counts[key] = (this.counts[key] ?? 0) + 1;
    save(this.path, this.counts);
  }

  get = (key: string) => this.counts[key] ?? 0;
  total = () => Object.values(this.counts).reduce((a, b) => a + b, 0);
}
