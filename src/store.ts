import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface NamedSandbox {
  name: string;
  keyId: string;
  provider: string;
  resourceId: string;
  image?: string;
  cpu: number;
  memoryMb: number;
  createdAt: string;
}

export interface SpendEntry {
  at: string;
  sandbox: string;
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
}

export interface UsageState {
  version: 1;
  cursor: number;
  keys: Record<string, KeyUsage>;
  names: Record<string, NamedSandbox>;
}

let chain: Promise<unknown> = Promise.resolve();

export function emptyState(): UsageState {
  return { version: 1, cursor: 0, keys: {}, names: {} };
}

export class JsonStore {
  constructor(readonly file: string) {}

  async update<T>(fn: (state: UsageState) => Promise<T> | T): Promise<T> {
    const run = chain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      let state = emptyState();
      try {
        const raw = await readFile(this.file, "utf8");
        if (raw.trim()) state = { ...emptyState(), ...JSON.parse(raw) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const result = await fn(state);
      const next = `${this.file}.${process.pid}.tmp`;
      await writeFile(next, `${JSON.stringify(state, null, 2)}\n`);
      await rename(next, this.file);
      return result;
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
  };
}
