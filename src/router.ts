import type { BoxRouterConfig, CreateRequest, ProviderDriver, ProviderKey, ProviderSession } from "./types.js";
import { estimateCost, getBackendPricing, getPricing } from "./pricing.js";
import { blankKey, JsonStore, type KeyUsage, type NamedSandbox, type UsageState } from "./store.js";
import { endOfDay, parseTime, startOfDay, startOfMonth, startOfNextMonth } from "./time.js";

export class NoEligibleKey extends Error {}
export class ConfigError extends Error {}

export interface LiveSandbox {
  name: string;
  keyId: string;
  provider: string;
  resourceId: string;
  terminal: boolean;
  session: ProviderSession;
  createdAt: string;
  cpu: number;
  memoryMb: number;
}

export class Router {
  private readonly drivers = new Map<string, ProviderDriver>();

  constructor(
    private readonly config: BoxRouterConfig,
    private readonly store: JsonStore,
    drivers: ProviderDriver[],
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!config.keys?.length) throw new ConfigError("config.keys must be a non-empty list");
    const seen = new Set<string>();
    for (const key of config.keys) {
      if (!key.id || !key.provider) throw new ConfigError("each key needs id and provider");
      if (seen.has(key.id)) throw new ConfigError(`duplicate key id ${key.id}`);
      seen.add(key.id);
      key.credentials ??= {};
      key.limits ??= {};
    }
    for (const driver of drivers) this.drivers.set(driver.name, driver);
  }

  static async fromFile(file: string, drivers: ProviderDriver[], stateFile?: string): Promise<Router> {
    const { readFile } = await import("node:fs/promises");
    const config = JSON.parse(await readFile(file, "utf8")) as BoxRouterConfig;
    return new Router(config, new JsonStore(stateFile ?? file.replace(/[^/]+$/, "usage.json")), drivers);
  }

  markup(): number {
    const raw = this.config.organization?.markup ?? 1;
    return Number.isFinite(Number(raw)) ? Number(raw) : 1;
  }

  pricing(provider?: string) {
    return provider ? getBackendPricing(provider) ?? {} : getPricing();
  }

  estimate(provider: string, elapsedSecs: number, cpu = 1, memoryMb = 1024) {
    return estimateCost(provider, elapsedSecs, cpu, memoryMb, this.markup());
  }

  async organization() {
    const totals = await this.costs();
    return {
      name: this.config.organization?.name || "default",
      markup: this.markup(),
      provider_spend_usd: totals.provider_usd,
      customer_spend_usd: totals.customer_usd,
    };
  }

  async costs() {
    return this.store.update((state) => this.summarize(state));
  }

  async status() {
    const now = this.now();
    return this.store.update((state) =>
      this.config.keys.map((key) => {
        const usage = this.usage(state, key.id);
        const creates = usage.creates.map((item) => parseTime(item.at));
        return {
          id: key.id,
          provider: key.provider,
          active: usage.active.length,
          creates_today: creates.filter((item) => item >= startOfDay(now)).length,
          creates_this_month: creates.filter((item) => item >= startOfMonth(now)).length,
          invalid: usage.invalid,
          blocked_until: usage.blocked_until,
          blocked_reason: usage.blocked_reason,
          spend_usd_this_month: this.spendThisMonth(usage, now),
          limits: key.limits ?? {},
        };
      }),
    );
  }

  /** Reattach a sandbox stored under `name`. Throws when the name is unknown. */
  async resume(name: string): Promise<LiveSandbox> {
    const existing = await this.store.update((state) => state.names[name]);
    if (!existing?.provider_resource_id) throw new Error(`Sandbox ${name} not found`);
    return this.attach(existing);
  }

  /** Names already recorded, optionally filtered by the labels stored at create. */
  async list(labels?: Record<string, string>): Promise<Array<{ name: string; metadata: { name: string } }>> {
    const names = await this.store.update((state) => Object.values(state.names));
    return names
      .filter((record) => !labels || Object.entries(labels).every(([key, value]) => record.labels?.[key] === value))
      .map((record) => ({ name: record.name, metadata: { name: record.name } }));
  }

  /** Open a new sandbox, or return the one already stored under `name`. */
  async open(request: CreateRequest & { backend?: string }): Promise<LiveSandbox> {
    const existing = await this.store.update((state) => state.names[request.name]);
    if (existing?.provider_resource_id) {
      try {
        return await this.attach(existing);
      } catch {
        await this.rollback(request.name);
      }
    } else if (existing) {
      await this.rollback(request.name);
    }
    return this.provision(request, new Set());
  }

  async destroy(name: string): Promise<void> {
    const record = await this.store.update((state) => state.names[name]);
    if (!record) return;
    const driver = this.drivers.get(record.provider);
    const key = this.config.keys.find((item) => item.id === record.keyId);
    if (driver && key) {
      try {
        const session = await driver.resume(key, record.provider_resource_id);
        await session.destroy();
      } catch {
        // The provider sandbox is already gone. Still free the local slot.
      }
    }
    await this.store.update((state) => this.release(state, name, true));
  }

  private async attach(record: NamedSandbox): Promise<LiveSandbox> {
    const key = this.config.keys.find((item) => item.id === record.keyId);
    if (!key) throw new Error(`Unknown key ${record.keyId}`);
    const driver = this.driverFor(key);
    const session = await driver.resume(key, record.provider_resource_id);
    return {
      name: record.name,
      keyId: record.keyId,
      provider: record.provider,
      resourceId: session.resourceId,
      terminal: driver.terminal,
      session,
      createdAt: record.createdAt,
      cpu: record.cpu,
      memoryMb: record.memoryMb,
    };
  }

  private async provision(request: CreateRequest & { backend?: string }, skip: Set<string>): Promise<LiveSandbox> {
    const key = await this.store.update((state) => {
      const chosen = this.pick(state, request.backend, skip);
      const at = this.now().toISOString();
      const usage = this.usage(state, chosen.id);
      usage.creates.push({ at, sandbox: request.name });
      usage.active.push(request.name);
      state.names[request.name] = {
        name: request.name,
        keyId: chosen.id,
        provider: chosen.provider,
        provider_resource_id: "",
        image: request.image,
        cpu: request.cpu ?? 1,
        memoryMb: request.memoryMb ?? 1024,
        createdAt: at,
        labels: request.labels,
        externalId: request.externalId,
        region: request.region,
      };
      return chosen;
    });
    const driver = this.driverFor(key);
    try {
      const session = await driver.create(key, request);
      await this.store.update((state) => {
        const record = state.names[request.name];
        if (record) record.provider_resource_id = session.resourceId;
      });
      return this.live(request.name, key, session, request);
    } catch (error) {
      await this.rollback(request.name);
      skip.add(key.id);
      if (isAuth(error)) {
        await this.mark(key.id, { invalid: true, reason: message(error) });
        return this.provision(request, skip);
      }
      if (isQuota(error)) {
        await this.mark(key.id, { until: endOfDay(this.now()), reason: message(error) });
        return this.provision(request, skip);
      }
      throw error;
    }
  }

  private pick(state: UsageState, backend: string | undefined, skip: Set<string>): ProviderKey {
    const keys = this.config.keys;
    const cursor = (state.cursor || 0) % keys.length;
    let considered = 0;
    for (let offset = 0; offset < keys.length; offset += 1) {
      const index = (cursor + offset) % keys.length;
      const key = keys[index]!;
      if (backend && key.provider !== backend) continue;
      if (skip.has(key.id)) continue;
      considered += 1;
      if (this.localBlock(state, key)) continue;
      state.cursor = (index + 1) % keys.length;
      return key;
    }
    if (considered === 0) throw new NoEligibleKey(backend ? `no keys configured for backend ${backend}` : "no keys configured");
    throw new NoEligibleKey("every provider key is exhausted or invalid");
  }

  async create(request: CreateRequest & { backend?: string }): Promise<LiveSandbox> {
    return this.open(request);
  }

  private localBlock(state: UsageState, key: ProviderKey): string | null {
    const usage = this.usage(state, key.id);
    const now = this.now();
    if (usage.invalid) return "invalid";
    if (usage.blocked_until) {
      if (parseTime(usage.blocked_until) > now) return usage.blocked_reason || "blocked";
      usage.blocked_until = null;
      usage.blocked_reason = null;
    }
    const monthStart = startOfMonth(now);
    usage.creates = usage.creates.filter((item) => parseTime(item.at) >= monthStart);
    usage.spend = usage.spend.filter((item) => parseTime(item.at) >= monthStart);
    const limits = key.limits ?? {};
    if (limits.concurrent_sandboxes != null && usage.active.length >= limits.concurrent_sandboxes) return "concurrent_sandboxes";
    if (limits.creates_per_day != null) {
      const today = usage.creates.filter((item) => parseTime(item.at) >= startOfDay(now));
      if (today.length >= limits.creates_per_day) {
        usage.blocked_until = endOfDay(now).toISOString();
        usage.blocked_reason = "creates_per_day";
        return "creates_per_day";
      }
    }
    if (limits.creates_per_month != null && usage.creates.length >= limits.creates_per_month) {
      usage.blocked_until = startOfNextMonth(now).toISOString();
      usage.blocked_reason = "creates_per_month";
      return "creates_per_month";
    }
    const cap = limits.spend_usd_per_month ?? limits.monthly_spend_usd;
    if (cap != null && this.spendThisMonth(usage, now) >= cap) {
      usage.blocked_until = startOfNextMonth(now).toISOString();
      usage.blocked_reason = "spend_usd_per_month";
      return "spend_usd_per_month";
    }
    return null;
  }

  private live(name: string, key: ProviderKey, session: ProviderSession, request: CreateRequest): LiveSandbox {
    return {
      name,
      keyId: key.id,
      provider: key.provider,
      resourceId: session.resourceId,
      terminal: this.driverFor(key).terminal,
      session,
      createdAt: this.now().toISOString(),
      cpu: request.cpu ?? 1,
      memoryMb: request.memoryMb ?? 1024,
    };
  }

  private async rollback(name: string) {
    await this.store.update((state) => this.release(state, name, false));
  }

  private release(state: UsageState, name: string, bill: boolean) {
    const record = state.names[name];
    if (!record) return;
    const usage = state.keys[record.keyId];
    if (usage) {
      usage.active = usage.active.filter((item) => item !== name);
      if (!bill) usage.creates = usage.creates.filter((item) => item.sandbox !== name);
      if (bill) this.accrue(usage, record);
    }
    delete state.names[name];
  }

  private accrue(usage: KeyUsage, record: NamedSandbox) {
    if (usage.spend.some((entry) => entry.sandbox === record.name)) return;
    const seconds = Math.max(0, (this.now().getTime() - parseTime(record.createdAt).getTime()) / 1000);
    const amounts = estimateCost(record.provider, seconds, record.cpu, record.memoryMb, this.markup());
    usage.spend.push({
      at: this.now().toISOString(),
      sandbox: record.name,
      provider_usd: amounts.provider_usd,
      customer_usd: amounts.customer_usd,
      seconds,
    });
  }

  private async mark(keyId: string, change: { invalid?: boolean; until?: Date; reason?: string }) {
    await this.store.update((state) => {
      const usage = this.usage(state, keyId);
      if (change.invalid) usage.invalid = true;
      if (change.until) usage.blocked_until = change.until.toISOString();
      if (change.reason) usage.blocked_reason = change.reason.slice(0, 300);
    });
  }

  /** Record the name inside the same selection that picked the key. */
  private driverFor(key: ProviderKey): ProviderDriver {
    const driver = this.drivers.get(key.provider);
    if (!driver) throw new Error(`No driver for provider ${key.provider}`);
    return driver;
  }

  private usage(state: UsageState, keyId: string): KeyUsage {
    return (state.keys[keyId] ??= blankKey());
  }

  private spendThisMonth(usage: KeyUsage, now: Date): number {
    return usage.spend
      .filter((entry) => parseTime(entry.at) >= startOfMonth(now))
      .reduce((sum, entry) => sum + entry.provider_usd, 0);
  }

  private summarize(state: UsageState) {
    const now = this.now();
    let providerUsd = 0;
    let customerUsd = 0;
    let month = 0;
    const keys = this.config.keys.map((key) => {
      const usage = this.usage(state, key.id);
      let keyProvider = 0;
      let keyCustomer = 0;
      let keyMonth = 0;
      for (const entry of usage.spend) {
        keyProvider += entry.provider_usd;
        keyCustomer += entry.customer_usd;
        if (parseTime(entry.at) >= startOfMonth(now)) keyMonth += entry.provider_usd;
      }
      providerUsd += keyProvider;
      customerUsd += keyCustomer;
      month += keyMonth;
      return { id: key.id, provider: key.provider, provider_usd: keyProvider, customer_usd: keyCustomer, provider_usd_this_month: keyMonth };
    });
    return { provider_usd: providerUsd, customer_usd: customerUsd, provider_usd_this_month: month, keys };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isQuota(error: unknown): boolean {
  const text = message(error).toLowerCase();
  return ["quota", "rate limit", "too many requests", "429", "insufficient", "credit", "billing", "limit exceeded"].some((hint) => text.includes(hint));
}

function isAuth(error: unknown): boolean {
  const text = message(error).toLowerCase();
  return ["401", "403", "unauthenticated", "unauthorized", "invalid api key", "authentication failed"].some((hint) => text.includes(hint));
}
