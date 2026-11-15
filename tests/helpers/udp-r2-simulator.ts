import {
  createSocket,
  type RemoteInfo,
  type Socket
} from 'node:dgram';

export interface SimulatedUdpCommand {
  id: number;
  method: string;
  params: unknown[];
  token?: string;
}

export class UdpR2Simulator {
  readonly commands: SimulatedUdpCommand[] = [];
  sessionRequests = 0;
  heartbeatRequests = 0;
  respondToSessions = true;
  respondToHeartbeats = true;
  malformedSessionToken = false;
  sessionResponseIdOffset = 0;
  private socket?: Socket;
  private port?: number;

  async start(): Promise<number> {
    if (this.socket && this.port) {
      return this.port;
    }
    const socket = createSocket('udp4');
    this.socket = socket;
    socket.on('message', (message, info) => {
      this.handleMessage(message, info);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, '127.0.0.1', () => {
        socket.off('error', reject);
        resolve();
      });
    });
    const address = socket.address();
    if (typeof address === 'string') {
      throw new Error('Expected an IPv4 UDP simulator address');
    }
    this.port = address.port;
    return address.port;
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.port = undefined;
    if (!socket) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.close(() => resolve());
    });
  }

  private handleMessage(message: Buffer, info: RemoteInfo): void {
    let packet: unknown;
    try {
      packet = JSON.parse(message.toString('utf8'));
    } catch {
      return;
    }
    if (
      typeof packet !== 'object' ||
      packet === null ||
      Array.isArray(packet)
    ) {
      return;
    }
    const record = packet as Record<string, unknown>;
    const id = record.id;
    const method = record.method;
    if (
      typeof id !== 'number' ||
      !Number.isInteger(id) ||
      typeof method !== 'string'
    ) {
      return;
    }

    if (method === 'udp_sess_new') {
      this.sessionRequests += 1;
      if (this.respondToSessions) {
        const token = this.malformedSessionToken
          ? 'not-a-token'
          : this.currentToken();
        void this.reply(
          {
            id: id + this.sessionResponseIdOffset,
            method: 'udp_sess_token',
            params: {
              token
            }
          },
          info
        ).catch(() => undefined);
      }
      return;
    }

    if (method === 'udp_sess_keep_alive') {
      this.heartbeatRequests += 1;
      if (this.respondToHeartbeats && typeof record.token === 'string') {
        void this.reply(
          {
            id,
            result: ['ok'],
            token: record.token
          },
          info
        ).catch(() => undefined);
      }
      return;
    }

    this.commands.push({
      id,
      method,
      params: Array.isArray(record.params) ? record.params : [],
      token:
        typeof record.token === 'string' ? record.token : undefined
    });
  }

  private currentToken(): string {
    return this.sessionRequests.toString(16).padStart(32, '0');
  }

  private reply(packet: object, info: RemoteInfo): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      socket.send(
        Buffer.from(JSON.stringify(packet), 'utf8'),
        info.port,
        info.address,
        (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
  }
}
