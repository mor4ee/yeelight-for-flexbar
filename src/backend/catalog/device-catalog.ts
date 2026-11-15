import { isIP } from 'node:net';
import { isPrivateOrLocalIPv4 } from '../discovery/network';
import type { YeelightDiscoveryPacket } from '../protocol';

export type CatalogDiscoverySource =
  | 'active'
  | 'passive'
  | 'manual'
  | 'station';
export type YeelightTargetDomain = 'main' | 'background';
export type YeelightControlCapability =
  | 'power'
  | 'brightness'
  | 'colorTemperature'
  | 'color'
  | 'saturation';

export interface PersistedYeelightDevice {
  deviceId: string;
  host: string;
  port: number;
  model?: string;
  firmwareVersion?: string;
  support: string[];
  properties: Record<string, string>;
  source: CatalogDiscoverySource;
  lastSeenAt: number;
}

export interface StationCatalogDevice {
  deviceId: string;
  host: string;
  model?: string;
  support: readonly string[];
  properties: Readonly<Record<string, string>>;
}

export interface YeelightPhysicalDevice extends PersistedYeelightDevice {
  online: boolean;
  connection?: YeelightConnectionSummary;
}

export interface YeelightConnectionSummary {
  phase: 'disconnected' | 'connecting' | 'hydrating' | 'connected';
  stale: boolean;
  staleProperties?: string[];
  activeTransport?:
    | 'station-daemon'
    | 'udp-r2'
    | 'tcp-session'
    | 'unavailable';
  pendingCommandCount?: number;
  generation: number;
  revision: number;
  lastError?: string;
}

export interface YeelightLogicalTarget {
  targetId: string;
  deviceId: string;
  domain: YeelightTargetDomain;
  name: string;
  host: string;
  port: number;
  model?: string;
  firmwareVersion?: string;
  capabilities: YeelightControlCapability[];
  properties: Record<string, string>;
  online: boolean;
  connection?: YeelightConnectionSummary;
  lastSeenAt: number;
}

export interface YeelightCatalogSnapshot {
  revision: number;
  devices: YeelightPhysicalDevice[];
  targets: YeelightLogicalTarget[];
}

const DEVICE_ID_PATTERN = /^0x[0-9a-f]{1,16}$/i;
const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/i;
const METHOD_NAME_PATTERN = /^[a-z][a-z0-9_]*$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PROPERTY_NAME_PATTERN.test(key) && typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
}

function parsePersistedDevice(value: unknown): PersistedYeelightDevice | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const {
    deviceId,
    host,
    port,
    model,
    firmwareVersion,
    support,
    properties,
    source,
    lastSeenAt
  } = value;

  if (
    typeof deviceId !== 'string' ||
    !DEVICE_ID_PATTERN.test(deviceId) ||
    typeof host !== 'string' ||
    isIP(host) !== 4 ||
    !isPrivateOrLocalIPv4(host) ||
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65_535 ||
    !Array.isArray(support) ||
    !support.every(
      (method) => typeof method === 'string' && METHOD_NAME_PATTERN.test(method)
    ) ||
    !['active', 'passive', 'manual', 'station'].includes(
      String(source)
    ) ||
    !Number.isFinite(lastSeenAt) ||
    (lastSeenAt as number) < 0
  ) {
    return undefined;
  }

  return {
    deviceId: deviceId.toLowerCase(),
    host,
    port: port as number,
    model: typeof model === 'string' ? model : undefined,
    firmwareVersion:
      typeof firmwareVersion === 'string' ? firmwareVersion : undefined,
    support: [...new Set(support as string[])].sort(),
    properties: normalizeStringRecord(properties),
    source: source as CatalogDiscoverySource,
    lastSeenAt: lastSeenAt as number
  };
}

function supportsBackground(device: PersistedYeelightDevice): boolean {
  return (
    device.support.some((method) => method.startsWith('bg_')) ||
    Object.keys(device.properties).some((property) => property.startsWith('bg_'))
  );
}

function methodName(
  domain: YeelightTargetDomain,
  method: string
): string {
  return domain === 'background' ? `bg_${method}` : method;
}

function deriveCapabilities(
  device: PersistedYeelightDevice,
  domain: YeelightTargetDomain
): YeelightControlCapability[] {
  const support = new Set(device.support);
  const capabilities: YeelightControlCapability[] = [];

  if (
    support.has(methodName(domain, 'set_power')) ||
    support.has(methodName(domain, 'toggle'))
  ) {
    capabilities.push('power');
  }
  if (support.has(methodName(domain, 'set_bright'))) {
    capabilities.push('brightness');
  }
  if (support.has(methodName(domain, 'set_ct_abx'))) {
    capabilities.push('colorTemperature');
  }
  // The Color Unit edits Hue and therefore requires set_hsv specifically.
  // A target advertising only set_rgb cannot preserve confirmed saturation.
  if (support.has(methodName(domain, 'set_hsv'))) {
    capabilities.push('color');
  }
  if (support.has(methodName(domain, 'set_hsv'))) {
    capabilities.push('saturation');
  }

  return capabilities;
}

function projectProperties(
  properties: Readonly<Record<string, string>>,
  domain: YeelightTargetDomain
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(properties)) {
    if (domain === 'main') {
      if (!name.startsWith('bg_')) {
        result[name] = value;
      }
    } else if (name.startsWith('bg_')) {
      result[name.slice(3)] = value;
      if (name === 'bg_lmode') {
        result.color_mode = value;
      }
    }
  }

  return result;
}

function displayName(device: PersistedYeelightDevice): string {
  const configuredName = device.properties.name?.trim();
  if (configuredName) {
    return configuredName;
  }
  if (device.model) {
    return `Yeelight ${device.model}`;
  }
  return `Yeelight ${device.host}`;
}

function compareDevices(
  left: PersistedYeelightDevice,
  right: PersistedYeelightDevice
): number {
  return (
    displayName(left).localeCompare(displayName(right)) ||
    left.deviceId.localeCompare(right.deviceId)
  );
}

export class DeviceCatalog {
  private readonly devices = new Map<string, PersistedYeelightDevice>();
  private catalogRevision = 0;

  constructor(
    persistedDevices: readonly unknown[] = [],
    private readonly now: () => number = Date.now
  ) {
    for (const persistedDevice of persistedDevices) {
      const parsed = parsePersistedDevice(persistedDevice);
      if (parsed) {
        this.devices.set(parsed.deviceId, parsed);
      }
    }
  }

  upsert(
    packet: YeelightDiscoveryPacket,
    source: CatalogDiscoverySource
  ): PersistedYeelightDevice {
    if (!isPrivateOrLocalIPv4(packet.location.host)) {
      throw new Error('Yeelight discovery endpoint must be on a local network');
    }

    const previous = this.devices.get(packet.deviceId);
    const next: PersistedYeelightDevice = {
      deviceId: packet.deviceId,
      host: packet.location.host,
      port: packet.location.port,
      model: packet.model ?? previous?.model,
      firmwareVersion: packet.firmwareVersion ?? previous?.firmwareVersion,
      support:
        packet.support.size > 0
          ? [...packet.support].sort()
          : previous?.support ?? [],
      properties: {
        ...(previous?.properties ?? {}),
        ...packet.properties
      },
      source,
      lastSeenAt: this.now()
    };

    this.devices.set(next.deviceId, next);
    this.catalogRevision += 1;
    return structuredClone(next);
  }

  upsertStation(
    stationDevice: StationCatalogDevice
  ): PersistedYeelightDevice {
    const previous = this.devices.get(stationDevice.deviceId);
    const next: PersistedYeelightDevice = {
      deviceId: stationDevice.deviceId.toLowerCase(),
      host: stationDevice.host,
      port: previous?.port ?? 55_443,
      model: stationDevice.model ?? previous?.model,
      firmwareVersion: previous?.firmwareVersion,
      support:
        stationDevice.support.length > 0
          ? [...new Set(stationDevice.support)].sort()
          : previous?.support ?? [],
      properties: {
        ...(previous?.properties ?? {}),
        ...stationDevice.properties
      },
      source: 'station',
      lastSeenAt: this.now()
    };
    const parsed = parsePersistedDevice(next);
    if (!parsed) {
      throw new Error('Invalid Yeelight Station catalog device');
    }
    this.devices.set(parsed.deviceId, parsed);
    this.catalogRevision += 1;
    return structuredClone(parsed);
  }

  snapshot(): YeelightCatalogSnapshot {
    const devices = [...this.devices.values()].sort(compareDevices);
    const targets: YeelightLogicalTarget[] = [];

    for (const device of devices) {
      targets.push(this.createTarget(device, 'main'));
      if (supportsBackground(device)) {
        targets.push(this.createTarget(device, 'background'));
      }
    }

    return {
      revision: this.catalogRevision,
      devices: devices.map((device) => ({
        ...structuredClone(device),
        online: false
      })),
      targets
    };
  }

  serialize(): PersistedYeelightDevice[] {
    return [...this.devices.values()]
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
      .map((device) => structuredClone(device));
  }

  get size(): number {
    return this.devices.size;
  }

  private createTarget(
    device: PersistedYeelightDevice,
    domain: YeelightTargetDomain
  ): YeelightLogicalTarget {
    return {
      targetId: `${device.deviceId}:${domain}`,
      deviceId: device.deviceId,
      domain,
      name: displayName(device),
      host: device.host,
      port: device.port,
      model: device.model,
      firmwareVersion: device.firmwareVersion,
      capabilities: deriveCapabilities(device, domain),
      properties: projectProperties(device.properties, domain),
      online: false,
      lastSeenAt: device.lastSeenAt
    };
  }
}
