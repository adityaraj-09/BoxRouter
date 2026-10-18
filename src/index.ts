import { dockerDriver } from "./providers/docker.js";
import { e2bDriver } from "./providers/e2b.js";
import { daytonaDriver } from "./providers/daytona.js";
import { Router } from "./router.js";
import { SandboxInstance, type BlaxelCreateOptions } from "./blaxel.js";
import type { ProviderDriver } from "./types.js";

export { Router, NoEligibleKey, ConfigError } from "./router.js";
export { SandboxInstance } from "./blaxel.js";
export { estimateCost, getBackendPricing, getPricing } from "./pricing.js";
export type { BlaxelCreateOptions, BlaxelExecOptions } from "./blaxel.js";
export type { TerminalTarget } from "./types.js";

const builtin: ProviderDriver[] = [dockerDriver, e2bDriver, daytonaDriver];

/** Load keys and start routing. Pass extra drivers (usually a test double) in front of the builtins. */
export async function createRouter(configFile: string, extra: ProviderDriver[] = []): Promise<Router> {
  return Router.fromFile(configFile, [...extra, ...builtin]);
}

/**
 * Blaxel-compatible entry points.
 * `SandboxInstance.createIfNotExists` is the replacement for `@blaxel/core`.
 */
export async function createIfNotExists(opts: BlaxelCreateOptions, router: Router): Promise<SandboxInstance> {
  return SandboxInstance.createIfNotExists(opts, router);
}
