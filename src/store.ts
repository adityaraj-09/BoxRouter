import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface NamedSandbox {
  name: string;
  keyId: string;
  provider: string;
  /** Provider sandbox id. Reconnect uses this; it is not a BoxRouter name. */
  provider_resource_id: string;
  /** Unique per create; destroy→recreate under the same name bills as separate instances. */
  instanceId?: string;
  image?: string;
  cpu: number;
  memoryMb: number;
  createdAt: string;
  labels?: Record<string, string>;
  externalId?: string;
  region?: string;
}

export interface SpendEntry {
  at: string;
  sandbox: string;
  instance?: string;
  provider_usd: number;
  customer_usd: number;
  seconds: number;
}

export interface Lifetime {
  provider_usd: number;
  customer_usd: number;
  seconds: number;
}

export interface KeyUsage {
  creates: { at: string; sandbox: string }[];
  active: string[];
  invalid: boolean;
  blocked_until: string | null;
  blocked_reason: string | null;
  spend: SpendEntry[];
  /** Accumulated all-time totals; survives the monthly pruning of `spend`. */
  lifetime?: Lifetime;
}

export interface UsageState {
  version: 1;
  cursor: number;
  keys: Record<string, KeyUsage>;
  names: Record<string, NamedSandbox>;
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;

let chain: Promise<unknown> = Promise.resolve();

export function emptyState(): UsageState {
  return { version: 1, cursor: 0, keys: {}, names: {} };
}

export class JsonStore {
  constructor(readonly file: string) {}

  /** Read-only pass over the state without rewriting the file. */
  async read<T>(fn: (state: UsageState) => Promise<T> | T): Promise<T> {
    const run = chain.then(async () => fn(await this.snapshot()));
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async update<T>(fn: (state: UsageState) => Promise<T> | T): Promise<T> {
    const run = chain.then(async () => {
      const release = await this.lock();
      try {
        const state = await this.snapshot();
        const result = await fn(state);
        const next = `${this.file}.${process.pid}.tmp`;
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(next, `${JSON.stringify(state, null, 2)}\n`);
        await rename(next, this.file);
        return result;
      } finally {
        await release();
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async snapshot(): Promise<UsageState> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
    if (!raw.trim()) {
      const backup = `${this.file}.corrupt`;
      await rename(this.file, backup).catch(() => undefined);
      throw new Error(
        `BoxRouter state file ${this.file} is empty or truncated; the previous copy was moved to ${backup}`,
      );
    }
    try {
      return { ...emptyState(), ...JSON.parse(raw) };
    } catch (error) {
      const backup = `${this.file}.${Date.now()}.corrupt`;
      await rename(this.file, backup).catch(() => undefined);
      throw new Error(
        `BoxRouter state file ${this.file} is corrupt (${(error as Error).message}); the previous copy was moved to ${backup}`,
      );
    }
  }

  /** Cross-process advisory lock; holders older than LOCK_STALE_MS are treated as crashed. */
  private async lock(): Promise<() => Promise<void>> {
    const lockFile = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await open(lockFile, "wx");
        await handle.write(`${process.pid}\n`);
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await stat(lockFile).catch(() => undefined);
        if (info == null || Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockFile).catch(() => undefined);
        } else if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        } else {
          throw new Error(`BoxRouter state lock ${lockFile} is still held after ${LOCK_TIMEOUT_MS}ms`);
        }
      }
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await unlink(lockFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    };
  }
}

export function blankKey(): KeyUsage {
  return {
    creates: [],
    active: [],
    invalid: false,
    blocked_until: null,
    blocked_reason: null,
    spend: [],
    lifetime: { provider_usd: 0, customer_usd: 0, seconds: 0 },
  };
}
