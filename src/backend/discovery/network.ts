import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export interface IPv4NetworkInterface {
  name: string;
  address: string;
  netmask: string;
}

function ipv4ToInteger(address: string): number | undefined {
  if (isIP(address) !== 4) {
    return undefined;
  }

  return address
    .split('.')
    .map(Number)
    .reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

export function listActiveIPv4Interfaces(): IPv4NetworkInterface[] {
  const result: IPv4NetworkInterface[] = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      const family = String(address.family);
      if (
        family !== 'IPv4' &&
        family !== '4'
      ) {
        continue;
      }
      if (
        address.internal ||
        isIP(address.address) !== 4 ||
        isIP(address.netmask) !== 4
      ) {
        continue;
      }

      result.push({
        name,
        address: address.address,
        netmask: address.netmask
      });
    }
  }

  return result.sort((left, right) =>
    `${left.name}:${left.address}`.localeCompare(`${right.name}:${right.address}`)
  );
}

export function isAddressInNetwork(
  address: string,
  networkAddress: string,
  netmask: string
): boolean {
  const addressValue = ipv4ToInteger(address);
  const networkValue = ipv4ToInteger(networkAddress);
  const maskValue = ipv4ToInteger(netmask);
  if (
    addressValue === undefined ||
    networkValue === undefined ||
    maskValue === undefined
  ) {
    return false;
  }

  return (addressValue & maskValue) === (networkValue & maskValue);
}

export function isAddressOnTrustedNetwork(
  address: string,
  interfaces: readonly IPv4NetworkInterface[]
): boolean {
  return interfaces.some((networkInterface) =>
    isAddressInNetwork(
      address,
      networkInterface.address,
      networkInterface.netmask
    )
  );
}

export function isPrivateOrLocalIPv4(address: string): boolean {
  const value = ipv4ToInteger(address);
  if (value === undefined) {
    return false;
  }

  return (
    isAddressInNetwork(address, '10.0.0.0', '255.0.0.0') ||
    isAddressInNetwork(address, '172.16.0.0', '255.240.0.0') ||
    isAddressInNetwork(address, '192.168.0.0', '255.255.0.0') ||
    isAddressInNetwork(address, '169.254.0.0', '255.255.0.0') ||
    isAddressInNetwork(address, '100.64.0.0', '255.192.0.0')
  );
}

export function normalizeManualAddress(address: string): string {
  const normalized = address.trim();
  if (!isPrivateOrLocalIPv4(normalized)) {
    throw new Error(
      'Manual Yeelight address must be a private or link-local IPv4 address'
    );
  }
  return normalized;
}
