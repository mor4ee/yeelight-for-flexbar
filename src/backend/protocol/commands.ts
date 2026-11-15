import { YeelightProtocolError } from './errors';
import type {
  YeelightCommand,
  YeelightDomain,
  YeelightTransition,
  YeelightWireCommand
} from './types';

export const SUDDEN_TRANSITION: YeelightTransition = {
  effect: 'sudden',
  durationMs: 0
};

export const DEFAULT_SMOOTH_TRANSITION: YeelightTransition = {
  effect: 'smooth',
  durationMs: 500
};

const DOMAIN_METHODS = {
  main: {
    power: 'set_power',
    toggle: 'toggle',
    brightness: 'set_bright',
    colorTemperature: 'set_ct_abx',
    rgb: 'set_rgb',
    hsv: 'set_hsv',
    scene: 'set_scene'
  },
  background: {
    power: 'bg_set_power',
    toggle: 'bg_toggle',
    brightness: 'bg_set_bright',
    colorTemperature: 'bg_set_ct_abx',
    rgb: 'bg_set_rgb',
    hsv: 'bg_set_hsv',
    scene: 'bg_set_scene'
  }
} as const;

const ALLOWED_OUTBOUND_METHODS = new Set([
  'get_prop',
  'set_power',
  'toggle',
  'set_bright',
  'set_ct_abx',
  'set_rgb',
  'set_hsv',
  'set_scene',
  'bg_set_power',
  'bg_toggle',
  'bg_set_bright',
  'bg_set_ct_abx',
  'bg_set_rgb',
  'bg_set_hsv',
  'bg_set_scene'
]);

function assertIntegerInRange(
  name: string,
  value: number,
  minimum: number,
  maximum: number
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new YeelightProtocolError(
      'INVALID_COMMAND',
      `${name} must be an integer from ${minimum} to ${maximum}`
    );
  }
}

function transitionParams(
  transition: YeelightTransition
): readonly [string, number] {
  if (transition.effect === 'sudden') {
    if (transition.durationMs !== 0) {
      throw new YeelightProtocolError(
        'INVALID_COMMAND',
        'Sudden transition duration must be 0'
      );
    }
  } else if (
    !Number.isInteger(transition.durationMs) ||
    transition.durationMs < 30
  ) {
    throw new YeelightProtocolError(
      'INVALID_COMMAND',
      'Smooth transition duration must be at least 30 ms'
    );
  }

  return [transition.effect, transition.durationMs];
}

function methodFor(
  domain: YeelightDomain,
  control: keyof (typeof DOMAIN_METHODS)['main']
): string {
  return DOMAIN_METHODS[domain][control];
}

export function getProperties(properties: readonly string[]): YeelightCommand {
  if (
    properties.length === 0 ||
    properties.some((property) => !/^[a-z][a-z0-9_]*$/i.test(property))
  ) {
    throw new YeelightProtocolError(
      'INVALID_COMMAND',
      'get_prop requires at least one valid property name'
    );
  }

  return {
    method: 'get_prop',
    params: [...properties]
  };
}

export function setPower(
  enabled: boolean,
  domain: YeelightDomain = 'main',
  transition: YeelightTransition = DEFAULT_SMOOTH_TRANSITION
): YeelightCommand {
  return {
    method: methodFor(domain, 'power'),
    params: [
      enabled ? 'on' : 'off',
      ...transitionParams(transition)
    ]
  };
}

export function togglePower(
  domain: YeelightDomain = 'main'
): YeelightCommand {
  return {
    method: methodFor(domain, 'toggle'),
    params: []
  };
}

export function setBrightness(
  brightness: number,
  domain: YeelightDomain = 'main',
  transition: YeelightTransition = DEFAULT_SMOOTH_TRANSITION
): YeelightCommand {
  assertIntegerInRange('brightness', brightness, 1, 100);
  return {
    method: methodFor(domain, 'brightness'),
    params: [brightness, ...transitionParams(transition)]
  };
}

export function setColorTemperature(
  kelvin: number,
  domain: YeelightDomain = 'main',
  transition: YeelightTransition = DEFAULT_SMOOTH_TRANSITION
): YeelightCommand {
  assertIntegerInRange('color temperature', kelvin, 1_700, 6_500);
  return {
    method: methodFor(domain, 'colorTemperature'),
    params: [kelvin, ...transitionParams(transition)]
  };
}

export function setRgb(
  rgb: number,
  domain: YeelightDomain = 'main',
  transition: YeelightTransition = DEFAULT_SMOOTH_TRANSITION
): YeelightCommand {
  assertIntegerInRange('rgb', rgb, 0, 0xff_ff_ff);
  return {
    method: methodFor(domain, 'rgb'),
    params: [rgb, ...transitionParams(transition)]
  };
}

export function setHsv(
  hue: number,
  saturation: number,
  domain: YeelightDomain = 'main',
  transition: YeelightTransition = DEFAULT_SMOOTH_TRANSITION
): YeelightCommand {
  assertIntegerInRange('hue', hue, 0, 359);
  assertIntegerInRange('saturation', saturation, 0, 100);
  return {
    method: methodFor(domain, 'hsv'),
    params: [hue, saturation, ...transitionParams(transition)]
  };
}

export function setHsvScene(
  hue: number,
  saturation: number,
  brightness: number,
  domain: YeelightDomain = 'main'
): YeelightCommand {
  assertIntegerInRange('hue', hue, 0, 359);
  assertIntegerInRange('saturation', saturation, 0, 100);
  assertIntegerInRange('brightness', brightness, 1, 100);
  return {
    method: methodFor(domain, 'scene'),
    params: ['hsv', hue, saturation, brightness]
  };
}

export function setRgbScene(
  rgb: number,
  brightness: number,
  domain: YeelightDomain = 'main'
): YeelightCommand {
  assertIntegerInRange('rgb', rgb, 0, 0xff_ff_ff);
  assertIntegerInRange('brightness', brightness, 1, 100);
  return {
    method: methodFor(domain, 'scene'),
    params: ['color', rgb, brightness]
  };
}

export function setColorTemperatureScene(
  kelvin: number,
  brightness: number,
  domain: YeelightDomain = 'main'
): YeelightCommand {
  assertIntegerInRange('color temperature', kelvin, 1_700, 6_500);
  assertIntegerInRange('brightness', brightness, 1, 100);
  return {
    method: methodFor(domain, 'scene'),
    params: ['ct', kelvin, brightness]
  };
}

export function assertCommandSupported(
  command: YeelightCommand,
  supportedMethods: ReadonlySet<string>
): void {
  if (!supportedMethods.has(command.method)) {
    throw new YeelightProtocolError(
      'UNSUPPORTED_CAPABILITY',
      `Device does not advertise Yeelight method: ${command.method}`
    );
  }
}

export function createWireCommand(
  requestId: number,
  command: YeelightCommand
): YeelightWireCommand {
  assertIntegerInRange('request id', requestId, 1, 0x7f_ff_ff_ff);
  if (!ALLOWED_OUTBOUND_METHODS.has(command.method)) {
    throw new YeelightProtocolError(
      'INVALID_COMMAND',
      `Outbound Yeelight method is not allowed: ${command.method}`
    );
  }
  return {
    id: requestId,
    method: command.method,
    params: command.params
  };
}

export function encodeCommand(
  requestId: number,
  command: YeelightCommand
): Buffer {
  const wireCommand = createWireCommand(requestId, command);
  return Buffer.from(`${JSON.stringify(wireCommand)}\r\n`, 'utf8');
}
