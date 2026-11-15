import { createWireCommand } from './commands';
import { YeelightProtocolError } from './errors';
import type { YeelightCommand } from './types';

export const YEELIGHT_UDP_R2_PORT = 55_444;
export const YEELIGHT_UDP_R2_HEARTBEAT_SECONDS = 10;
export const YEELIGHT_UDP_R2_MAX_PACKET_BYTES = 16 * 1_024;

const MAX_REQUEST_ID = 0x7f_ff_ff_ff;
const UDP_TOKEN_PATTERN = /^[0-9a-f]{32}$/i;

export interface YeelightUdpSessionTokenPacket {
  kind: 'session-token';
  id: number;
  token: string;
}

export interface YeelightUdpResultPacket {
  kind: 'result';
  id: number;
  result: unknown[];
  token: string;
}

export type YeelightUdpInboundPacket =
  | YeelightUdpSessionTokenPacket
  | YeelightUdpResultPacket;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRequestId(requestId: number): void {
  if (
    !Number.isInteger(requestId) ||
    requestId < 1 ||
    requestId > MAX_REQUEST_ID
  ) {
    throw new YeelightProtocolError(
      'INVALID_UDP_PACKET',
      'UDP request id is outside the supported range'
    );
  }
}

export function normalizeUdpToken(token: unknown): string {
  if (typeof token !== 'string' || !UDP_TOKEN_PATTERN.test(token)) {
    throw new YeelightProtocolError(
      'INVALID_UDP_TOKEN',
      'Yeelight UDP token must contain 32 hexadecimal characters'
    );
  }
  return token.toLowerCase();
}

function encodePacket(packet: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(packet), 'utf8');
}

export function encodeUdpSessionNew(requestId: number): Buffer {
  assertRequestId(requestId);
  return encodePacket({
    id: requestId,
    method: 'udp_sess_new',
    params: []
  });
}

export function encodeUdpHeartbeat(
  requestId: number,
  token: string,
  intervalSeconds = YEELIGHT_UDP_R2_HEARTBEAT_SECONDS
): Buffer {
  assertRequestId(requestId);
  const normalizedToken = normalizeUdpToken(token);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new YeelightProtocolError(
      'INVALID_UDP_PACKET',
      'UDP heartbeat interval must be a positive integer'
    );
  }
  return encodePacket({
    id: requestId,
    method: 'udp_sess_keep_alive',
    params: ['keeplive_interval', String(intervalSeconds)],
    token: normalizedToken
  });
}

export function encodeUdpCommand(
  requestId: number,
  command: YeelightCommand,
  token: string
): Buffer {
  const wireCommand = createWireCommand(requestId, command);
  return encodePacket({
    ...wireCommand,
    token: normalizeUdpToken(token)
  });
}

export function decodeUdpR2Packet(
  packet: Buffer | Uint8Array | string
): YeelightUdpInboundPacket {
  const byteLength =
    typeof packet === 'string'
      ? Buffer.byteLength(packet, 'utf8')
      : packet.byteLength;
  if (byteLength > YEELIGHT_UDP_R2_MAX_PACKET_BYTES) {
    throw new YeelightProtocolError(
      'UDP_PACKET_TOO_LARGE',
      'Yeelight UDP packet exceeds the maximum size'
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(
      typeof packet === 'string'
        ? packet
        : Buffer.from(packet).toString('utf8')
    );
  } catch {
    throw new YeelightProtocolError(
      'INVALID_UDP_PACKET',
      'Yeelight UDP packet is not valid JSON'
    );
  }

  if (!isRecord(value)) {
    throw new YeelightProtocolError(
      'INVALID_UDP_PACKET',
      'Yeelight UDP packet must be an object'
    );
  }

  const id = value.id;
  if (
    typeof id !== 'number' ||
    !Number.isInteger(id) ||
    id < 1 ||
    id > MAX_REQUEST_ID
  ) {
    throw new YeelightProtocolError(
      'INVALID_UDP_PACKET',
      'Yeelight UDP response has an invalid request id'
    );
  }

  if (value.method === 'udp_sess_token') {
    const params = value.params;
    if (!isRecord(params)) {
      throw new YeelightProtocolError(
        'INVALID_UDP_PACKET',
        'Yeelight UDP session response has invalid params'
      );
    }
    return {
      kind: 'session-token',
      id,
      token: normalizeUdpToken(params.token)
    };
  }

  if (Array.isArray(value.result)) {
    return {
      kind: 'result',
      id,
      result: value.result,
      token: normalizeUdpToken(value.token)
    };
  }

  throw new YeelightProtocolError(
    'INVALID_UDP_PACKET',
    'Unsupported Yeelight UDP response'
  );
}
