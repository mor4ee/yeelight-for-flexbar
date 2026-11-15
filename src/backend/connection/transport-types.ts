import type { PersistedYeelightDevice } from '../catalog/device-catalog';
import type { YeelightCommand } from '../protocol';

export type YeelightControlTransportKind =
  | 'station-daemon'
  | 'udp-r2'
  | 'tcp-session';

export interface UdpR2CommandTransport {
  start(): Promise<void>;
  send(command: YeelightCommand): Promise<void>;
  stop(): void;
}

export interface TcpQueryTransport {
  query(properties: readonly string[]): Promise<Record<string, string>>;
  stop(): void;
}

export interface TcpSessionTransport {
  start(): void;
  updateDevice(device: PersistedYeelightDevice): void;
  reconnectNow(): void;
  send(command: YeelightCommand): Promise<unknown[]>;
  stop(): void;
}
