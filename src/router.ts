import path from "node:path";
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
  private readonly inFlight = new Map<string, Promise<LiveSandbox>>();
  private warnedFree = new Set<string>();

  constructor(
    private readonly config: BoxRouterConfig,
    private readonly store: JsonStore,
    drivers: ProviderDriver[],
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!config.keys?.length) throw new ConfigError("config.keys must be a non-empty list");
    const markup = config.organization === undefined ? undefined : config.organization.markup;
    if (markup != null && (!Number.isFinite(Number(markup)) || Number(markup) < 0)) {
      throw new ConfigError(`organization.markup must be a finite non-negative number, got ${markup}`);
    }
    const seen = new Set<string>();
    for (const key of config.keys) {
      if (!key.id || !key.provider) throw new ConfigError("each key needs id and provider");
      if (seen.has(key.id)) throw new ConfigError(`duplicate key id ${key.id}`);
      seen.add(key.id);
      key.credentials ??= {};
      key.limits ??= {};
      for (const [limit, value] of Object.entries(key.limits ?? {})) {
        if (value == null) continue;
        if (!Number.isFinite(Number(value)) || Number(value) < 0) {
          throw new ConfigError(`key ${key.id} limit ${limit} must be a finite non-negative number, got ${value}`);
        }
      }
    }
    for (const driver of drivers) this.drivers.set(driver.name, driver);
  }

  static async fromFile(file: string, drivers: ProviderDriver[], stateFile?: string): Promise<Router> {
    const { readFile } = await import("node:fs/promises");
    const config = JSON.parse(await readFile(file, "utf8")) as BoxRouterConfig;
    return new Router(config, new JsonStore(stateFile ?? path.join(path.dirname(file), "usage.json")), drivers);
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

  /** Clear the invalid flag and any block on a key, e.g. after fixing credentials. */
  async resetKey(keyId: string): Promise<void> {
    await this.store.update((state) => {
      const usage = state.keys[keyId];
      if (!usage) return;
      usage.invalid = false;
      usage.blocked_until = null;
      usage.blocked_reason = null;
    });
  }

  async status() {
    const now = this.now();
    return this.store.read((state) =>
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
    const existing = await this.store.read((state) => state.names[name]);
    if (!existing?.provider_resource_id) throw new Error(`Sandbox ${name} not found`);
    return this.attach(existing);
  }

  /** Names already recorded, optionally filtered by the labels stored at create. */
  async list(labels?: Record<string, string>): Promise<Array<{ name: string; metadata: { name: string } }>> {
    const names = await this.store.read((state) => Object.values(state.names));
    return names
      .filter((record) => !labels || Object.entries(labels).every(([key, value]) => record.labels?.[key] === value))
      .map((record) => ({ name: record.name, metadata: { name: record.name } }));
  }

  /** Open a new sandbox, or return the one already stored under `name`. Concurrent open() calls
   * for the same name share a single in-flight create so the provider is never double-provisioned. */
  async open(request: CreateRequest & { backend?: string }): Promise<LiveSandbox> {
    const pending = this.inFlight.get(request.name);
    if (pending) return pending;
    const create = this.doOpen(request);
    this.inFlight.set(request.name, create);
    void create.catch(() => undefined).finally(() => {
      if (this.inFlight.get(request.name) === create) this.inFlight.delete(request.name);
    });
    return create;
  }

  private async attachExisting(request: CreateRequest & { backend?: string }, existing: NamedSandbox): Promise<LiveSandbox> {
    try {
      return await this.retryAttach(existing);
    } catch (error) {
      if (!isGone(error)) throw error;
      await this.rollback(request.name);
    }
    return this.provision(request, new Set());
  }

  private async retryAttach(record: NamedSandbox, attempts = 3): Promise<LiveSandbox> {
    let delay = 300;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attach(record);
      } catch (error) {
        if (attempt >= attempts || !isTransient(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 3;
      }
    }
  }

  private async doOpen(request: CreateRequest & { backend?: string }): Promise<LiveSandbox> {
    const existing = await this.store.read((state) => state.names[request.name]);
    if (existing?.provider_resource_id) {
      return this.attachExisting(request, existing);
    } else if (existing) {
      await this.rollback(request.name);
    }
    return this.provision(request, new Set());
  }

  async destroy(name: string): Promise<void> {
    const record = await this.store.read((state) => state.names[name]);
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
        instanceId: instanceId(at, request.name),
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
    this.warnIfUnknownPrice(key.provider);
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
        await this.mark(key.id, { invalid: true, reason: redact(message(error)) });
        return this.provision(request, skip);
      }
      if (isQuota(error)) {
        await this.mark(key.id, { until: endOfDay(this.now()), reason: redact(message(error)) });
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
    if (usage.spend.some((entry) => entry.instance === record.instanceId)) return;
    const seconds = Math.max(0, (this.now().getTime() - parseTime(record.createdAt).getTime()) / 1000);
    const amounts = estimateCost(record.provider, seconds, record.cpu, record.memoryMb, this.markup());
    usage.spend.push({
      at: this.now().toISOString(),
      sandbox: record.name,
      instance: record.instanceId ?? `${record.name}:${record.createdAt}`,
      provider_usd: amounts.provider_usd,
      customer_usd: amounts.customer_usd,
      seconds,
    });
    usage.lifetime = {
      provider_usd: (usage.lifetime?.provider_usd ?? 0) + amounts.provider_usd,
      customer_usd: (usage.lifetime?.customer_usd ?? 0) + amounts.customer_usd,
      seconds: (usage.lifetime?.seconds ?? 0) + seconds,
    };
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

  private warnIfUnknownPrice(provider: string): void {
    if (this.warnedFree.has(provider) || getBackendPricing(provider)) return;
    this.warnedFree.add(provider);
    console.warn(`BoxRouter: no pricing entry for provider ${provider}; usage will be billed as $0`);
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
      const lifetime = this.lifetime(state, key.id);
      let keyMonth = 0;
      for (const entry of usage.spend) {
        if (parseTime(entry.at) >= startOfMonth(now)) keyMonth += entry.provider_usd;
      }
      providerUsd += lifetime.provider_usd;
      customerUsd += lifetime.customer_usd;
      month += keyMonth;
      return { id: key.id, provider: key.provider, provider_usd: lifetime.provider_usd, customer_usd: lifetime.customer_usd, provider_usd_this_month: keyMonth };
    });
    return { provider_usd: providerUsd, customer_usd: customerUsd, provider_usd_this_month: month, keys };
  }

  /** All-time spend; spend entries are pruned monthly, so totals are accumulated here instead. */
  private lifetime(state: UsageState, keyId: string): { provider_usd: number; customer_usd: number; seconds: number } {
    const usage = this.usage(state, keyId);
    usage.lifetime ??= usage.spend.reduce(
      (totals, entry) => ({
        provider_usd: totals.provider_usd + entry.provider_usd,
        customer_usd: totals.customer_usd + entry.customer_usd,
        seconds: totals.seconds + entry.seconds,
      }),
      { provider_usd: 0, customer_usd: 0, seconds: 0 },
    );
    return usage.lifetime;
  }
}

function instanceId(at: string, name: string): string {
  return `${name}@${at}@${Math.random().toString(36).slice(2, 10)}`;
}

function redact(text: string): string {
  return text
    .replace(/(Authorization(-Header)?\s*[=:]\s*)\S+/gi, "$1***")
    .replace(/Bearer\s+[^\s'",;]+/gi, "Bearer ***")
    .replace(/([?&](?:token|api_key|apikey|key|access_token|secret)=)[^&'"\s]+/gi, "$1***")
    .replace(/((?:api.?key|token|secret|password)["']?\s*[=:]\s*["']?)([A-Za-z0-9_-]{8,})/gi, "$1***");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
      if (typeof value === "number" && value >= 100 && value < 600) return value;
    }
  }
  const match = message(error).match(/\b(?:failed|error|status)(?:\s+\w+)*?:\s*(\d{3})\b/i);
  return match ? Number(match[1]) : undefined;
}

/** Classify by HTTP status first so 400s that merely mention "limit" are not mistaken for quota. */
function classify(error: unknown): "auth" | "quota" | null {
  const status = errorStatus(error);
  if (status != null) {
    if (status === 401 || status === 403) return "auth";
    if (status === 402 || status === 429) return "quota";
    return null;
  }
  const text = message(error).toLowerCase();
  if (["unauthenticated", "unauthorized", "invalid api key", "authentication failed", "api key invalid"].some((hint) => text.includes(hint))) return "auth";
  if (["quota", "rate limit", "too many requests", "insufficient", "credit", "billing", "limit exceeded"].some((hint) => text.includes(hint))) return "quota";
  return null;
}

function isQuota(error: unknown): boolean {
  return classify(error) === "quota";
}

function isAuth(error: unknown): boolean {
  return classify(error) === "auth";
}

const GONE = /\b(404|410)\b|not\s+found|does\s+not\s+exist|no\s+such\s+(sandbox|container|run)|is\s+not\s+running|terminated|been\s+(deleted|destroyed|reaped)/i;
const TRANSIENT = /econnrefused|econnreset|econnaborted|etimedout|enotfound|ehostunreach|enetunreach|eai_again|fetch\s+failed|network|socket\s+hang\s+up|aborted|\b(500|502|503|504)\b|temporarily|overloaded|too\s+many\s+requests/i;

/** True when the provider says the recorded sandbox no longer exists, so a local rollback is safe. */
function isGone(error: unknown): boolean {
  if (GONE.test(message(error))) return true;
  return errorStatus(error) === 404 || errorStatus(error) === 410;
}

/** True when a retry can plausibly succeed (network blips, provider 5xx). */
function isTransient(error: unknown): boolean {
  return TRANSIENT.test(message(error));
}
