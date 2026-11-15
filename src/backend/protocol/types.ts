export type YeelightDomain = 'main' | 'background';
export type YeelightTransitionEffect = 'sudden' | 'smooth';

export interface YeelightTransition {
  effect: YeelightTransitionEffect;
  durationMs: number;
}

export interface YeelightCommand {
  method: string;
  params: readonly (string | number)[];
}

export interface YeelightWireCommand {
  id: number;
  method: string;
  params: readonly (string | number)[];
}

export interface YeelightResultResponse {
  kind: 'result';
  id: number;
  result: unknown[];
}

export interface YeelightErrorResponse {
  kind: 'error';
  id: number;
  error: {
    code: number;
    message: string;
  };
}

export interface YeelightPropsNotification {
  kind: 'props';
  method: 'props';
  params: Record<string, string>;
}

export interface YeelightUnknownNotification {
  kind: 'notification';
  method: string;
  params: unknown;
}

export type YeelightInboundMessage =
  | YeelightResultResponse
  | YeelightErrorResponse
  | YeelightPropsNotification
  | YeelightUnknownNotification;

export type FrameDecodeResult =
  | {
      kind: 'message';
      message: YeelightInboundMessage;
    }
  | {
      kind: 'error';
      error: Error;
    };

export interface YeelightLocation {
  host: string;
  port: number;
}

export interface YeelightDiscoveryPacket {
  kind: 'response' | 'notification';
  location: YeelightLocation;
  deviceId: string;
  model?: string;
  firmwareVersion?: string;
  support: ReadonlySet<string>;
  properties: Readonly<Record<string, string>>;
  headers: Readonly<Record<string, readonly string[]>>;
}

export type YeelightProperties = Readonly<Record<string, string>>;
