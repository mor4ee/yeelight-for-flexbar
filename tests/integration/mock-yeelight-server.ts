import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket
} from 'node:net';
import type { YeelightWireCommand } from '../../src/backend/protocol';

export interface MockYeelightServerOptions {
  properties?: Record<string, string>;
}

export class MockYeelightServer {
  readonly receivedMethods: string[] = [];
  readonly properties: Record<string, string>;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly buffers = new Map<Socket, string>();

  constructor(options: MockYeelightServerOptions = {}) {
    this.properties = {
      power: 'off',
      bright: '25',
      color_mode: '2',
      ct: '4000',
      rgb: '16711680',
      hue: '0',
      sat: '70',
      name: 'Mock Yeelight',
      ...options.properties
    };
    this.server = createServer((socket) => this.accept(socket));
  }

  async start(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(0, '127.0.0.1');
    });
    const address = this.server.address() as AddressInfo;
    return {
      host: address.address,
      port: address.port
    };
  }

  notify(patch: Record<string, string>): void {
    Object.assign(this.properties, patch);
    this.broadcast({
      method: 'props',
      params: patch
    });
  }

  dropConnections(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    this.buffers.set(socket, '');
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.receive(socket, chunk.toString('utf8')));
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.buffers.delete(socket);
    });
  }

  private receive(socket: Socket, chunk: string): void {
    let buffer = (this.buffers.get(socket) ?? '') + chunk;
    while (true) {
      const delimiter = buffer.indexOf('\r\n');
      if (delimiter < 0) {
        break;
      }
      const line = buffer.slice(0, delimiter);
      buffer = buffer.slice(delimiter + 2);
      if (!line) {
        continue;
      }
      let command: YeelightWireCommand;
      try {
        command = JSON.parse(line) as YeelightWireCommand;
      } catch {
        continue;
      }
      this.handleCommand(socket, command);
    }
    this.buffers.set(socket, buffer);
  }

  private handleCommand(
    socket: Socket,
    command: YeelightWireCommand
  ): void {
    this.receivedMethods.push(command.method);
    if (command.method === 'get_prop') {
      this.send(socket, {
        id: command.id,
        result: command.params.map((name) =>
          typeof name === 'string' ? (this.properties[name] ?? '') : ''
        )
      });
      return;
    }

    const background = command.method.startsWith('bg_');
    const method = background
      ? command.method.slice(3)
      : command.method;
    const prefix = background ? 'bg_' : '';
    let patch: Record<string, string> | undefined;

    switch (method) {
      case 'set_power':
        patch = {
          [`${prefix}power`]: String(command.params[0])
        };
        break;
      case 'toggle':
        patch = {
          [`${prefix}power`]:
            this.properties[`${prefix}power`] === 'on' ? 'off' : 'on'
        };
        break;
      case 'set_bright':
        patch = {
          [`${prefix}bright`]: String(command.params[0])
        };
        break;
      case 'set_ct_abx':
        patch = {
          [`${prefix}ct`]: String(command.params[0])
        };
        break;
      case 'set_rgb':
        patch = {
          [`${prefix}rgb`]: String(command.params[0])
        };
        break;
      case 'set_hsv':
        patch = {
          [`${prefix}hue`]: String(command.params[0]),
          [`${prefix}sat`]: String(command.params[1])
        };
        break;
      default:
        this.send(socket, {
          id: command.id,
          error: {
            code: -1,
            message: `unsupported mock method: ${command.method}`
          }
        });
        return;
    }

    Object.assign(this.properties, patch);
    this.send(socket, {
      id: command.id,
      result: ['ok']
    });
    this.broadcast({
      method: 'props',
      params: patch
    });
  }

  private send(socket: Socket, message: object): void {
    if (!socket.destroyed) {
      socket.write(`${JSON.stringify(message)}\r\n`);
    }
  }

  private broadcast(message: object): void {
    for (const socket of this.sockets) {
      this.send(socket, message);
    }
  }
}
