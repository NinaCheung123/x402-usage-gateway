/**
 * Durable channel records, so a restart can't strand locked funds or lose what
 * a seller has earned. x402 ships in-memory stores; these keep the same
 * behaviour and write a JSON snapshot after each change. One process per file:
 * this suits a single gateway, and a larger deployment should use a database.
 */
import type { ChannelState, ChannelStore } from "@x402/svm/batch-settlement/server";
import { MemoryChannelStore } from "@x402/svm/batch-settlement/server";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
