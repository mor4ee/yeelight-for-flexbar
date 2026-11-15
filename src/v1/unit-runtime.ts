import type {
  KeyData,
  PluginDataPayload
} from '@eniac/flexdesigner/dist/types.js';
import {
  COLOR_TEMPERATURE_MAXIMUM,
  COLOR_TEMPERATURE_MINIMUM,
  colorTemperatureRange,
  createPowerControlPlan,
  createSliderControlPlan,
  targetIdFromUnitData,
  type ConfirmedTargetContext
} from '../backend/units/control-plan';
import {
  BRIGHTNESS_UNIT_ID,
  COLOR_TEMPERATURE_UNIT_ID,
  COLOR_UNIT_ID,
  POWER_UNIT_ID,
  SATURATION_UNIT_ID,
  type YeelightUnitId
} from '../backend/units/contracts';
import {
  parseUnitData,
  type BrightnessUnitData
} from '../backend/units/data';
import type { YeelightCommand } from '../backend/protocol';

export const V1_CONTROL_CIDS = {
  [POWER_UNIT_ID]: 'com.mor4ee.yeelight.power',
  [BRIGHTNESS_UNIT_ID]: 'com.mor4ee.yeelight.brightness',
  [COLOR_TEMPERATURE_UNIT_ID]:
    'com.mor4ee.yeelight.color-temperature',
  [COLOR_UNIT_ID]: 'com.mor4ee.yeelight.hue',
  [SATURATION_UNIT_ID]: 'com.mor4ee.yeelight.saturation'
} as const satisfies Record<YeelightUnitId, string>;

const UNIT_ID_BY_CID = new Map<string, YeelightUnitId>(
  Object.entries(V1_CONTROL_CIDS).map(([unitId, cid]) => [
    cid,
    unitId as YeelightUnitId
  ])
);

export interface V1UnitRuntimeSource {
  getControlContext(
    unitId: YeelightUnitId,
    data: unknown
  ): ConfirmedTargetContext | undefined;
  sendCommand(
    deviceId: string,
    command: YeelightCommand
  ): Promise<unknown[]>;
  subscribeState(listener: () => void): () => void;
}

export interface V1UnitRuntimeHost {
  setMultiState(
    serialNumber: string,
    key: KeyData,
    state: number
  ): Promise<unknown>;
  setSlider(
    serialNumber: string,
    key: KeyData,
    value: number
  ): Promise<unknown>;
  showError(serialNumber: string, message: string): Promise<unknown>;
}

export interface V1UnitRuntimeLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

interface LiveKey {
  identity: string;
  serialNumber: string;
  key: KeyData;
  unitId: YeelightUnitId;
}

interface SliderLane {
  lastStartedAt?: number;
  pending?: () => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
}

interface SliderCoalescerOptions {
  intervalMs: number;
  now?: () => number;
}

export class V1SliderCoalescer {
  private readonly lanes = new Map<string, SliderLane>();
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly options: SliderCoalescerOptions) {
    this.now = options.now ?? Date.now;
  }

  schedule(laneKey: string, task: () => Promise<void>): void {
    if (this.stopped) {
      return;
    }
    const lane = this.lanes.get(laneKey) ?? {
      running: false
    };
    lane.pending = task;
    this.lanes.set(laneKey, lane);
    this.pump(laneKey, lane);
  }

  stop(): void {
    this.stopped = true;
    for (const lane of this.lanes.values()) {
      if (lane.timer) {
        clearTimeout(lane.timer);
      }
    }
    this.lanes.clear();
  }

  private pump(laneKey: string, lane: SliderLane): void {
    if (
      this.stopped ||
      lane.running ||
      lane.timer ||
      !lane.pending
    ) {
      return;
    }

    const elapsed = lane.lastStartedAt === undefined
      ? Number.POSITIVE_INFINITY
      : this.now() - lane.lastStartedAt;
    const delay = Math.max(0, this.options.intervalMs - elapsed);
    if (delay > 0) {
      lane.timer = setTimeout(() => {
        lane.timer = undefined;
        this.pump(laneKey, lane);
      }, delay);
      return;
    }

    const task = lane.pending;
    lane.pending = undefined;
    lane.running = true;
    lane.lastStartedAt = this.now();
    void task()
      .catch(() => undefined)
      .finally(() => {
        lane.running = false;
        if (lane.pending) {
          this.pump(laneKey, lane);
        }
      });
  }
}

function liveKeyIdentity(serialNumber: string, key: KeyData): string {
  return `${serialNumber}\u0000${key.uid}`;
}

function unitIdForKey(key: KeyData): YeelightUnitId | undefined {
  return UNIT_ID_BY_CID.get(key.cid);
}

function numericProperty(
  context: ConfirmedTargetContext,
  name: string,
  minimum: number,
  maximum: number
): number | undefined {
  const value = Number(context.properties[name]);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function isAmbiguousStationConfirmationFailure(
  error: unknown
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message ===
    'Yeelight Station command was not confirmed by topology';
}

interface NativeSliderStyle {
  color?: string;
  format?: string;
  min?: number;
  max?: number;
  width?: number;
}

interface NativeSliderKeyStyle {
  width?: number;
  slider?: NativeSliderStyle;
}

export function nativeSliderWidth(keyWidth: number): number | undefined {
  if (!Number.isFinite(keyWidth)) {
    return undefined;
  }
  return Math.max(28, Math.round(keyWidth) - 100);
}

function decorateNativeSlider(
  unitId: Exclude<YeelightUnitId, typeof POWER_UNIT_ID>,
  key: KeyData,
  value: number,
  context: ConfirmedTargetContext
): string {
  const style = key.style as
    | (KeyData['style'] & NativeSliderKeyStyle)
    | undefined;
  const slider = style?.slider;
  if (!slider) {
    return '';
  }

  // KeyData.width is the authoritative placed-unit width in API v1.
  // style.width is retained as a fallback for older host payloads.
  const sliderWidth = nativeSliderWidth(
    Number.isFinite(Number(key.width))
      ? Number(key.width)
      : Number(style.width)
  );
  if (sliderWidth !== undefined) {
    slider.width = sliderWidth;
  }

  if (unitId === COLOR_TEMPERATURE_UNIT_ID) {
    const range = colorTemperatureRange(context);
    slider.min = range.minimum;
    slider.max = range.maximum;
    return `${range.minimum}:${range.maximum}:${slider.width ?? ''}`;
  }
  if (unitId === COLOR_UNIT_ID) {
    slider.format = '%0.0f';
    return `${slider.width ?? ''}`;
  }
  return `${slider.color ?? ''}:${slider.width ?? ''}`;
}

export function confirmedSliderPosition(
  unitId: Exclude<YeelightUnitId, typeof POWER_UNIT_ID>,
  data: unknown,
  context: ConfirmedTargetContext
): number | undefined {
  const parsed = parseUnitData(unitId, data);

  if (unitId === BRIGHTNESS_UNIT_ID) {
    const brightnessData = parsed as BrightnessUnitData;
    if (
      brightnessData.minimum === 0 &&
      context.properties.power === 'off'
    ) {
      return 0;
    }
    const brightness = numericProperty(context, 'bright', 1, 100);
    if (brightness === undefined) {
      return undefined;
    }
    return Math.round(
      Math.min(
        brightnessData.maximum,
        Math.max(brightnessData.minimum, brightness)
      )
    );
  }

  if (unitId === COLOR_TEMPERATURE_UNIT_ID) {
    const range = colorTemperatureRange(context);
    const kelvin = numericProperty(
      context,
      'ct',
      range.minimum,
      range.maximum
    );
    return kelvin === undefined ? undefined : Math.round(kelvin);
  }

  if (unitId === COLOR_UNIT_ID) {
    const hue = numericProperty(context, 'hue', 0, 359);
    return hue === undefined ? undefined : Math.round(hue);
  }

  if (unitId === SATURATION_UNIT_ID) {
    const saturation = numericProperty(context, 'sat', 0, 100);
    return saturation === undefined
      ? undefined
      : clampPercent(saturation);
  }

  return assertNever(unitId);
}

export function nativeSliderPosition(
  unitId: Exclude<YeelightUnitId, typeof POWER_UNIT_ID>,
  data: unknown,
  value: number,
  context?: ConfirmedTargetContext
): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  if (unitId === BRIGHTNESS_UNIT_ID) {
    const parsed = parseUnitData(unitId, data) as BrightnessUnitData;
    return Math.min(
      1,
      Math.max(
        0,
        (value - parsed.minimum) /
          (parsed.maximum - parsed.minimum)
      )
    );
  }
  if (unitId === COLOR_TEMPERATURE_UNIT_ID) {
    const range = context
      ? colorTemperatureRange(context)
      : {
          minimum: COLOR_TEMPERATURE_MINIMUM,
          maximum: COLOR_TEMPERATURE_MAXIMUM
        };
    return value < range.minimum ||
      value > range.maximum
      ? undefined
      : (value - range.minimum) /
          (range.maximum - range.minimum);
  }
  if (unitId === COLOR_UNIT_ID) {
    return value < 0 || value > 359 ? undefined : value / 359;
  }
  if (unitId === SATURATION_UNIT_ID) {
    return value < 0 || value > 100 ? undefined : value / 100;
  }
  return assertNever(unitId);
}

export interface V1UnitRuntimeOptions {
  source: V1UnitRuntimeSource;
  host: V1UnitRuntimeHost;
  logger: V1UnitRuntimeLogger;
  sliderIntervalMs?: number;
}

export class YeelightV1UnitRuntime {
  private readonly liveKeys = new Map<string, LiveKey>();
  private readonly renderedState = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  private readonly coalescer: V1SliderCoalescer;
  private readonly unsubscribeState: () => void;
  private syncQueued = false;
  private stopped = false;

  constructor(private readonly options: V1UnitRuntimeOptions) {
    this.coalescer = new V1SliderCoalescer({
      intervalMs: options.sliderIntervalMs ?? 1_000
    });
    this.unsubscribeState = options.source.subscribeState(() => {
      this.queueSynchronize();
    });
  }

  async handleAlive(
    serialNumber: string,
    keys: readonly KeyData[]
  ): Promise<void> {
    for (const [identity, liveKey] of this.liveKeys) {
      if (liveKey.serialNumber === serialNumber) {
        this.liveKeys.delete(identity);
        this.renderedState.delete(identity);
      }
    }

    for (const key of keys) {
      const unitId = unitIdForKey(key);
      if (!unitId) {
        continue;
      }
      const identity = liveKeyIdentity(serialNumber, key);
      this.liveKeys.set(identity, {
        identity,
        serialNumber,
        key,
        unitId
      });
    }
    await this.synchronize();
  }

  handleDead(serialNumber: string, keys: readonly KeyData[]): void {
    for (const key of keys) {
      const identity = liveKeyIdentity(serialNumber, key);
      this.liveKeys.delete(identity);
      this.renderedState.delete(identity);
    }
  }

  handleData(payload: PluginDataPayload): void {
    const unitId = unitIdForKey(payload.data.key);
    if (!unitId || this.stopped) {
      return;
    }

    const identity = liveKeyIdentity(
      payload.serialNumber,
      payload.data.key
    );
    const liveKey: LiveKey = {
      identity,
      serialNumber: payload.serialNumber,
      key: payload.data.key,
      unitId
    };
    this.liveKeys.set(identity, liveKey);

    if (unitId === POWER_UNIT_ID) {
      void this.executePower(liveKey);
      return;
    }

    if (!('value' in payload.data)) {
      return;
    }
    let targetId: string;
    try {
      targetId = targetIdFromUnitData(unitId, liveKey.key.data);
    } catch {
      void this.rejectAction(liveKey, 'Select a Yeelight device first');
      return;
    }
    if (!targetId) {
      void this.rejectAction(liveKey, 'Select a Yeelight device first');
      return;
    }

    const laneKey = `${targetId}\u0000${unitId}`;
    const value = Number(payload.data.value);
    this.coalescer.schedule(laneKey, () =>
      this.executeSlider(liveKey, value, laneKey)
    );
  }

  async synchronize(): Promise<void> {
    if (this.stopped) {
      return;
    }
    await Promise.all(
      [...this.liveKeys.values()].map((liveKey) =>
        this.synchronizeKey(liveKey)
      )
    );
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.unsubscribeState();
    this.coalescer.stop();
    this.liveKeys.clear();
    this.renderedState.clear();
    this.inFlight.clear();
  }

  get liveKeyCount(): number {
    return this.liveKeys.size;
  }

  private queueSynchronize(): void {
    if (this.syncQueued || this.stopped) {
      return;
    }
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      void this.synchronize();
    });
  }

  private async executePower(liveKey: LiveKey): Promise<void> {
    const context = this.options.source.getControlContext(
      liveKey.unitId,
      liveKey.key.data
    );
    if (!context) {
      await this.rejectAction(
        liveKey,
        'Yeelight device is offline or unavailable'
      );
      return;
    }
    const laneKey = `${context.target.targetId}\u0000power`;
    if (this.inFlight.has(laneKey)) {
      return;
    }

    this.inFlight.add(laneKey);
    try {
      const plan = createPowerControlPlan(liveKey.key.data, context);
      await this.sendCommands(context, plan.commands);
    } catch (error) {
      await this.reportFailure(liveKey, error);
    } finally {
      this.inFlight.delete(laneKey);
      await this.synchronize();
    }
  }

  private async executeSlider(
    liveKey: LiveKey,
    value: number,
    laneKey: string
  ): Promise<void> {
    if (liveKey.unitId === POWER_UNIT_ID || this.inFlight.has(laneKey)) {
      return;
    }
    const context = this.options.source.getControlContext(
      liveKey.unitId,
      liveKey.key.data
    );
    if (!context) {
      await this.rejectAction(
        liveKey,
        'Yeelight device is offline or unavailable'
      );
      return;
    }
    const position = nativeSliderPosition(
      liveKey.unitId,
      liveKey.key.data,
      value,
      context
    );
    if (position === undefined) {
      this.options.logger.debug(
        'Ignoring invalid Yeelight slider value',
        {
          cid: liveKey.key.cid,
          value
        }
      );
      await this.synchronizeKey(liveKey);
      return;
    }

    this.inFlight.add(laneKey);
    try {
      const plan = createSliderControlPlan(
        liveKey.unitId,
        liveKey.key.data,
        position,
        context
      );
      await this.sendCommands(context, plan.commands);
    } catch (error) {
      await this.reportFailure(liveKey, error);
    } finally {
      this.inFlight.delete(laneKey);
      await this.synchronize();
    }
  }

  private async sendCommands(
    context: ConfirmedTargetContext,
    commands: readonly YeelightCommand[]
  ): Promise<void> {
    for (const command of commands) {
      await this.options.source.sendCommand(
        context.target.deviceId,
        command
      );
    }
  }

  private async rejectAction(
    liveKey: LiveKey,
    message: string
  ): Promise<void> {
    await this.synchronizeKey(liveKey);
    await this.showError(liveKey.serialNumber, message);
  }

  private async reportFailure(
    liveKey: LiveKey,
    error: unknown
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.options.logger.warn('Yeelight control action failed', {
      cid: liveKey.key.cid,
      targetId: (liveKey.key.data as { targetId?: unknown })?.targetId,
      error: message,
      userVisible: !isAmbiguousStationConfirmationFailure(error)
    });
    if (isAmbiguousStationConfirmationFailure(error)) {
      return;
    }
    await this.showError(
      liveKey.serialNumber,
      'Yeelight command failed'
    );
  }

  private async showError(
    serialNumber: string,
    message: string
  ): Promise<void> {
    try {
      await this.options.host.showError(serialNumber, message);
    } catch (error) {
      this.options.logger.debug('Cannot show Flexbar error message', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async synchronizeKey(liveKey: LiveKey): Promise<void> {
    const context = this.options.source.getControlContext(
      liveKey.unitId,
      liveKey.key.data
    );
    if (!context) {
      return;
    }

    try {
      if (liveKey.unitId === POWER_UNIT_ID) {
        const power = context.properties.power;
        if (power !== 'on' && power !== 'off') {
          return;
        }
        const state = power === 'on' ? 1 : 0;
        const signature = `power:${state}`;
        if (this.renderedState.get(liveKey.identity) === signature) {
          return;
        }
        await this.options.host.setMultiState(
          liveKey.serialNumber,
          liveKey.key,
          state
        );
        this.renderedState.set(liveKey.identity, signature);
        return;
      }

      const value = confirmedSliderPosition(
        liveKey.unitId,
        liveKey.key.data,
        context
      );
      if (value === undefined) {
        return;
      }
      const visualSignature = decorateNativeSlider(
        liveKey.unitId,
        liveKey.key,
        value,
        context
      );
      const signature = `slider:${value}:${visualSignature}`;
      if (this.renderedState.get(liveKey.identity) === signature) {
        return;
      }
      await this.options.host.setSlider(
        liveKey.serialNumber,
        liveKey.key,
        value
      );
      this.renderedState.set(liveKey.identity, signature);
    } catch (error) {
      this.options.logger.debug('Cannot synchronize Yeelight key', {
        cid: liveKey.key.cid,
        uid: liveKey.key.uid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported Yeelight Unit: ${String(value)}`);
}
