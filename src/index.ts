import { blaxelDriver } from "./providers/blaxel.js";
import { cloudflareDriver } from "./providers/cloudflare.js";
import { daytonaDriver } from "./providers/daytona.js";
import { dockerDriver } from "./providers/docker.js";
import { e2bDriver } from "./providers/e2b.js";
import { isorunDriver } from "./providers/isorun.js";
import { modalDriver } from "./providers/modal.js";
import { namespaceDriver } from "./providers/namespace.js";
import { tensorlakeDriver } from "./providers/tensorlake.js";
import { vercelDriver } from "./providers/vercel.js";
import { Router } from "./router.js";
import { SandboxInstance, useRouter, type BlaxelCreateOptions } from "./blaxel.js";
import type { ProviderDriver } from "./types.js";

export { Router, NoEligibleKey, ConfigError } from "./router.js";
export { SandboxInstance, useRouter } from "./blaxel.js";
export { settings } from "./settings.js";
export { estimateCost, getBackendPricing, getPricing } from "./pricing.js";
export type { BlaxelCreateOptions, BlaxelExecOptions } from "./blaxel.js";
export type { TerminalTarget, ExecHandlers, ExecResult } from "./types.js";
export {
  blaxelDriver,
  cloudflareDriver,
  daytonaDriver,
  dockerDriver,
  e2bDriver,
  isorunDriver,
  modalDriver,
  namespaceDriver,
  tensorlakeDriver,
  vercelDriver,
};
export { readSse } from "./providers/isorun.js";
export { readCloudflareSse } from "./providers/cloudflare.js";

const builtin: ProviderDriver[] = [
  dockerDriver,
  e2bDriver,
  daytonaDriver,
  blaxelDriver,
  isorunDriver,
  tensorlakeDriver,
  modalDriver,
  vercelDriver,
  cloudflareDriver,
  namespaceDriver,
];

/** Load keys and start routing. Pass extra drivers (usually a test double) in front of the builtins. */
export async function createRouter(configFile: string, extra: ProviderDriver[] = []): Promise<Router> {
  const router = await Router.fromFile(configFile, [...extra, ...builtin]);
  useRouter(router);
  return router;
}

/**
 * Blaxel-compatible entry points.
 * `SandboxInstance.createIfNotExists` is the replacement for `@blaxel/core`.
 */
export async function createIfNotExists(opts: BlaxelCreateOptions, router: Router): Promise<SandboxInstance> {
  return SandboxInstance.createIfNotExists(opts, router);
}
