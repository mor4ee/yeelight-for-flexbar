import { isIP } from 'node:net';
import { YeelightProtocolError } from './errors';
import type { YeelightDiscoveryPacket, YeelightLocation } from './types';

export const YEELIGHT_DISCOVERY_ADDRESS = '239.255.255.250';
export const YEELIGHT_DISCOVERY_PORT = 1982;
export const DEFAULT_MAX_DISCOVERY_PACKET_BYTES = 32 * 1024;

export const YEELIGHT_DISCOVERY_REQUEST = [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${YEELIGHT_DISCOVERY_ADDRESS}:${YEELIGHT_DISCOVERY_PORT}`,
  'MAN: "ssdp:discover"',
  'ST: wifi_bulb',
  '',
  ''
].join('\r\n');

const METADATA_HEADERS = new Set([
  'location',
  'id',
  'model',
  'fw_ver',
  'support',
  'cache-control',
  'date',
  'ext',
  'server',
  'host',
  'nts',
  'nt',
  'usn'
]);

function decodePacket(
  packet: Buffer | string,
  maxPacketBytes: number
): string {
  const byteLength = Buffer.isBuffer(packet)
    ? packet.byteLength
    : Buffer.byteLength(packet, 'utf8');

  if (byteLength > maxPacketBytes) {
    throw new YeelightProtocolError(
      'DISCOVERY_PACKET_TOO_LARGE',
      `Discovery packet exceeds ${maxPacketBytes} bytes`
    );
  }

  return Buffer.isBuffer(packet) ? packet.toString('utf8') : packet;
}

function parseHeaders(lines: readonly string[]): Record<string, string[]> {
  const headers: Record<string, string[]> = {};

  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }

    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new YeelightProtocolError(
        'INVALID_DISCOVERY_PACKET',
        `Malformed discovery header: ${line}`
      );
    }

    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name.length === 0) {
      throw new YeelightProtocolError(
        'INVALID_DISCOVERY_PACKET',
        'Discovery header name is empty'
      );
    }

    (headers[name] ??= []).push(value);
  }

  return headers;
}

function readSingleHeader(
  headers: Readonly<Record<string, readonly string[]>>,
  name: string,
  required: boolean
): string | undefined {
  const values = headers[name];
  if (!values || values.length === 0) {
    if (required) {
      throw new YeelightProtocolError(
        'INVALID_DISCOVERY_PACKET',
        `Missing discovery header: ${name}`
      );
    }
    return undefined;
  }

  if (new Set(values).size > 1) {
    throw new YeelightProtocolError(
      'CONFLICTING_HEADER',
      `Conflicting values for discovery header: ${name}`
    );
  }

  return values[0];
}

export function parseYeelightLocation(value: string): YeelightLocation {
  const match = /^yeelight:\/\/([^:/]+):(\d{1,5})$/i.exec(value);
  if (!match || isIP(match[1]) !== 4) {
    throw new YeelightProtocolError(
      'INVALID_LOCATION',
      `Invalid Yeelight IPv4 location: ${value}`
    );
  }

  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new YeelightProtocolError(
      'INVALID_LOCATION',
      `Invalid Yeelight port: ${match[2]}`
    );
  }

  return {
    host: match[1],
    port
  };
}

function parseDeviceId(value: string): string {
  if (!/^0x[0-9a-f]{1,16}$/i.test(value)) {
    throw new YeelightProtocolError(
      'INVALID_DEVICE_ID',
      `Invalid Yeelight device id: ${value}`
    );
  }
  return value.toLowerCase();
}

export function parseDiscoveryPacket(
  packet: Buffer | string,
  maxPacketBytes = DEFAULT_MAX_DISCOVERY_PACKET_BYTES
): YeelightDiscoveryPacket {
  const text = decodePacket(packet, maxPacketBytes).replace(/\0+$/g, '');
  const lines = text.split(/\r?\n/);
  const startLine = lines.shift()?.trim() ?? '';

  let kind: YeelightDiscoveryPacket['kind'];
  if (/^HTTP\/1\.1 200 OK$/i.test(startLine)) {
    kind = 'response';
  } else if (/^NOTIFY \* HTTP\/1\.1$/i.test(startLine)) {
    kind = 'notification';
  } else {
    throw new YeelightProtocolError(
      'INVALID_DISCOVERY_PACKET',
      `Unsupported discovery start line: ${startLine}`
    );
  }

  const headers = parseHeaders(lines);
  const location = parseYeelightLocation(
    readSingleHeader(headers, 'location', true)!
  );
  const deviceId = parseDeviceId(readSingleHeader(headers, 'id', true)!);
  const support = new Set(
    (readSingleHeader(headers, 'support', false) ?? '')
      .split(/\s+/)
      .map((method) => method.trim())
      .filter(Boolean)
  );

  const properties: Record<string, string> = {};
  for (const [name, values] of Object.entries(headers)) {
    if (!METADATA_HEADERS.has(name)) {
      properties[name] = values[values.length - 1] ?? '';
    }
  }

  return {
    kind,
    location,
    deviceId,
    model: readSingleHeader(headers, 'model', false),
    firmwareVersion: readSingleHeader(headers, 'fw_ver', false),
    support,
    properties,
    headers
  };
}
