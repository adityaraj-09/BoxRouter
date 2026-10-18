import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BackendPrice {
  vcpu_per_hour_usd: number;
  ram_gib_per_hour_usd: number;
  free_tier?: string | null;
  pricing_url?: string | null;
  notes?: string;
}

export interface PricingTable {
  last_updated: string;
  note: string;
  backends: Record<string, BackendPrice>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

let cached: PricingTable | undefined;

export function getPricing(): PricingTable {
  if (!cached) {
    const file = path.join(here, "pricing.json");
    cached = JSON.parse(readFileSync(file, "utf8")) as PricingTable;
  }
  return cached;
}

export function getBackendPricing(provider: string): BackendPrice | undefined {
  return getPricing().backends[provider];
}

export function costPerSecond(provider: string, vcpu = 1, ramGib = 1): number {
  const info = getBackendPricing(provider);
  if (!info) return 0;
  return (info.vcpu_per_hour_usd / 3600) * vcpu + (info.ram_gib_per_hour_usd / 3600) * ramGib;
}

export function estimateCost(
  provider: string,
  elapsedSecs: number,
  cpu = 1,
  memoryMb = 1024,
  markup = 1,
): { provider_usd: number; customer_usd: number } {
  const providerUsd = costPerSecond(provider, cpu, memoryMb / 1024) * Math.max(0, elapsedSecs);
  return { provider_usd: providerUsd, customer_usd: providerUsd * markup };
}
