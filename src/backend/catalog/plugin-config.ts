import { normalizeManualAddress } from '../discovery/network';
import type { PersistedYeelightDevice } from './device-catalog';

export interface YeelightPluginConfig {
  schemaVersion: 1;
  manualAddresses: string[];
  catalog: PersistedYeelightDevice[];
}

export const DEFAULT_YEELIGHT_CONFIG: YeelightPluginConfig = {
  schemaVersion: 1,
  manualAddresses: [],
  catalog: []
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizePluginConfig(value: unknown): YeelightPluginConfig {
  if (!isRecord(value)) {
    return structuredClone(DEFAULT_YEELIGHT_CONFIG);
  }

  const manualAddresses = new Set<string>();
  if (Array.isArray(value.manualAddresses)) {
    for (const address of value.manualAddresses) {
      if (typeof address !== 'string') {
        continue;
      }
      try {
        manualAddresses.add(normalizeManualAddress(address));
      } catch {
        // Invalid persisted addresses are ignored instead of reaching the network.
      }
    }
  }

  return {
    schemaVersion: 1,
    manualAddresses: [...manualAddresses].sort(),
    catalog: Array.isArray(value.catalog)
      ? (value.catalog as PersistedYeelightDevice[])
      : []
  };
}
