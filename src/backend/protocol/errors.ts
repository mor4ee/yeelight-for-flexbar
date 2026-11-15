export type YeelightProtocolErrorCode =
  | 'INVALID_DISCOVERY_PACKET'
  | 'DISCOVERY_PACKET_TOO_LARGE'
  | 'INVALID_LOCATION'
  | 'INVALID_DEVICE_ID'
  | 'CONFLICTING_HEADER'
  | 'INVALID_JSON'
  | 'INVALID_MESSAGE'
  | 'FRAME_TOO_LARGE'
  | 'INVALID_UDP_PACKET'
  | 'UDP_PACKET_TOO_LARGE'
  | 'INVALID_UDP_TOKEN'
  | 'INVALID_COMMAND'
  | 'UNSUPPORTED_CAPABILITY'
  | 'PENDING_LIMIT_REACHED';

export class YeelightProtocolError extends Error {
  constructor(
    public readonly code: YeelightProtocolErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'YeelightProtocolError';
  }
}

export class YeelightCommandError extends Error {
  constructor(
    public readonly commandCode: number,
    message: string,
    public readonly requestId: number
  ) {
    super(message);
    this.name = 'YeelightCommandError';
  }
}

export class YeelightRequestTimeoutError extends Error {
  constructor(
    public readonly requestId: number,
    public readonly method: string
  ) {
    super(`Yeelight request ${requestId} (${method}) timed out`);
    this.name = 'YeelightRequestTimeoutError';
  }
}

export class YeelightConnectionClosedError extends Error {
  constructor(message = 'Yeelight connection closed') {
    super(message);
    this.name = 'YeelightConnectionClosedError';
  }
}
