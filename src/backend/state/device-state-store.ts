import { reduceProps, type YeelightProperties } from '../protocol';

export type YeelightConnectionPhase =
  | 'disconnected'
  | 'connecting'
  | 'hydrating'
  | 'connected';

export type YeelightActiveTransport =
  | 'station-daemon'
  | 'udp-r2'
  | 'tcp-session'
  | 'unavailable';

export interface YeelightPendingCommand {
  id: number;
  properties: string[];
  expected?: Record<string, string>;
  baseline: Record<string, string | undefined>;
  startedRevision: number;
  startedAt: number;
}

export interface YeelightDeviceRuntimeState {
  deviceId: string;
  generation: number;
  revision: number;
  phase: YeelightConnectionPhase;
  stale: boolean;
  staleProperties: string[];
  activeTransport: YeelightActiveTransport;
  pendingCommands: YeelightPendingCommand[];
  properties: Record<string, string>;
  lastError?: string;
  updatedAt: number;
}

export interface YeelightRuntimeSnapshot {
  revision: number;
  devices: YeelightDeviceRuntimeState[];
}

export type DeviceStateListener = (
  snapshot: YeelightRuntimeSnapshot
) => void;

export class DeviceStateStore {
  private readonly devices = new Map<string, YeelightDeviceRuntimeState>();
  private snapshotRevision = 0;
  private readonly listeners = new Set<DeviceStateListener>();
  private readonly fieldRevisions = new Map<string, Map<string, number>>();
  private readonly hydrateBaselines = new Map<string, number>();
  private nextCommandId = 0;

  constructor(private readonly now: () => number = Date.now) {}

  subscribe(listener: DeviceStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  ensureDevice(
    deviceId: string,
    properties: YeelightProperties = {}
  ): YeelightDeviceRuntimeState {
    const existing = this.devices.get(deviceId);
    if (existing) {
      if (Object.keys(properties).length > 0 && existing.stale) {
        return this.mutate(existing, {
          properties: reduceProps(existing.properties, properties)
        });
      }
      return structuredClone(existing);
    }

    const state: YeelightDeviceRuntimeState = {
      deviceId,
      generation: 0,
      revision: 0,
      phase: 'disconnected',
      stale: true,
      staleProperties: [],
      activeTransport: 'unavailable',
      pendingCommands: [],
      properties: { ...properties },
      updatedAt: this.now()
    };
    this.devices.set(deviceId, state);
    this.fieldRevisions.set(
      deviceId,
      new Map(Object.keys(properties).map((name) => [name, 0]))
    );
    this.emit();
    return structuredClone(state);
  }

  beginConnection(
    deviceId: string,
    generation: number,
    activeTransport: YeelightActiveTransport = 'unavailable'
  ): boolean {
    const state = this.requireDevice(deviceId);
    if (generation <= state.generation) {
      return false;
    }
    this.hydrateBaselines.delete(deviceId);
    this.mutate(state, {
      generation,
      phase: 'connecting',
      stale: true,
      staleProperties: [],
      activeTransport,
      pendingCommands: [],
      lastError: undefined
    });
    return true;
  }

  markHydrating(deviceId: string, generation: number): boolean {
    const state = this.currentGeneration(deviceId, generation);
    if (!state) {
      return false;
    }
    this.hydrateBaselines.set(deviceId, state.revision);
    this.mutate(state, {
      phase: 'hydrating',
      stale: true,
      lastError: undefined
    });
    return true;
  }

  applyProps(
    deviceId: string,
    generation: number,
    patch: Readonly<Record<string, string>>,
    maximumFieldRevision?: number
  ): boolean {
    const state = this.currentGeneration(deviceId, generation);
    if (!state) {
      return false;
    }
    const fieldRevisions = this.fieldRevisions.get(deviceId);
    const safePatch: Record<string, string> = {};
    for (const [name, value] of Object.entries(patch)) {
      if (
        maximumFieldRevision === undefined ||
        (fieldRevisions?.get(name) ?? 0) <= maximumFieldRevision
      ) {
        safePatch[name] = value;
      }
    }
    if (Object.keys(safePatch).length === 0) {
      return true;
    }
    const pendingIndex = state.pendingCommands.findIndex((pending) =>
      this.matchesPending(pending, safePatch)
    );
    const pendingCommands =
      pendingIndex < 0
        ? state.pendingCommands
        : state.pendingCommands.filter(
            (_pending, index) => index !== pendingIndex
          );
    const staleProperties = state.staleProperties.filter(
      (name) => !Object.prototype.hasOwnProperty.call(safePatch, name)
    );
    const resolvesCommandStaleness =
      state.phase === 'connected' && state.staleProperties.length > 0;
    const result = this.mutate(state, {
      properties: reduceProps(state.properties, safePatch),
      pendingCommands,
      stale: resolvesCommandStaleness
        ? staleProperties.length > 0
        : state.stale,
      staleProperties,
      lastError:
        resolvesCommandStaleness && staleProperties.length > 0
          ? state.lastError
          : undefined
    });
    this.recordFieldRevisions(deviceId, safePatch, result.revision);
    return true;
  }

  beginCommand(
    deviceId: string,
    generation: number,
    properties: readonly string[],
    expected?: Readonly<Record<string, string>>
  ): number | undefined {
    const state = this.currentGeneration(deviceId, generation);
    if (
      !state ||
      state.phase !== 'connected' ||
      state.stale ||
      properties.length === 0
    ) {
      return undefined;
    }
    const id = ++this.nextCommandId;
    const baseline: Record<string, string | undefined> = {};
    for (const property of properties) {
      baseline[property] = state.properties[property];
    }
    const pending: YeelightPendingCommand = {
      id,
      properties: [...properties],
      expected: expected ? { ...expected } : undefined,
      baseline,
      startedRevision: state.revision,
      startedAt: this.now()
    };
    this.mutate(state, {
      pendingCommands: [...state.pendingCommands, pending],
      lastError: undefined
    });
    return id;
  }

  resolveCommand(
    deviceId: string,
    generation: number,
    commandId: number
  ): boolean {
    const state = this.currentGeneration(deviceId, generation);
    if (!state) {
      return false;
    }
    const pendingCommands = state.pendingCommands.filter(
      (pending) => pending.id !== commandId
    );
    if (pendingCommands.length === state.pendingCommands.length) {
      return false;
    }
    this.mutate(state, {
      pendingCommands,
      lastError: state.stale ? state.lastError : undefined
    });
    return true;
  }

  hasPendingCommand(
    deviceId: string,
    generation: number,
    commandId: number
  ): boolean {
    const state = this.currentGeneration(deviceId, generation);
    return (
      state?.pendingCommands.some(
        (pending) => pending.id === commandId
      ) ?? false
    );
  }

  failCommand(
    deviceId: string,
    generation: number,
    commandId: number,
    error: string,
    unresolved: boolean
  ): boolean {
    const state = this.currentGeneration(deviceId, generation);
    if (!state) {
      return false;
    }
    const pendingCommands = state.pendingCommands.filter(
      (pending) => pending.id !== commandId
    );
    if (pendingCommands.length === state.pendingCommands.length) {
      return false;
    }
    this.mutate(state, {
      pendingCommands,
      stale: unresolved ? true : state.stale,
      staleProperties: unresolved
        ? [
            ...new Set([
              ...state.staleProperties,
              ...state.pendingCommands
                .filter((pending) => pending.id === commandId)
                .flatMap((pending) => pending.properties)
            ])
          ]
        : state.staleProperties,
      lastError: error
    });
    return true;
  }

  completeHydrate(
    deviceId: string,
    generation: number,
    properties: Readonly<Record<string, string>>
  ): boolean {
    const state = this.currentGeneration(deviceId, generation);
    if (!state) {
      return false;
    }
    const baseline =
      this.hydrateBaselines.get(deviceId) ?? state.revision;
    const fieldRevisions = this.fieldRevisions.get(deviceId);
    const safeProperties: Record<string, string> = {};
    for (const [name, value] of Object.entries(properties)) {
      if ((fieldRevisions?.get(name) ?? 0) <= baseline) {
        safeProperties[name] = value;
      }
    }
    const pendingIndex = state.pendingCommands.findIndex((pending) =>
      this.matchesPending(pending, safeProperties)
    );
    const pendingCommands =
      pendingIndex < 0
        ? state.pendingCommands
        : state.pendingCommands.filter(
            (_pending, index) => index !== pendingIndex
          );
    const result = this.mutate(state, {
      phase: 'connected',
      stale: false,
      staleProperties: [],
      pendingCommands,
      properties: reduceProps(state.properties, safeProperties),
      lastError: undefined
    });
    this.hydrateBaselines.delete(deviceId);
    this.recordFieldRevisions(
      deviceId,
      safeProperties,
      result.revision
    );
    return true;
  }

  markHydrateUnavailable(
    deviceId: string,
    generation: number,
    error: string
  ): boolean {
    const state = this.currentGeneration(deviceId, generation);
    if (!state) {
      return false;
    }
    this.hydrateBaselines.delete(deviceId);
    this.mutate(state, {
      phase: 'connected',
      stale: true,
      staleProperties: [],
      lastError: error
    });
    return true;
  }

  markDisconnected(
    deviceId: string,
    generation: number,
    error?: string
  ): boolean {
    const state = this.currentGeneration(deviceId, generation);
    if (!state) {
      return false;
    }
    this.hydrateBaselines.delete(deviceId);
    this.mutate(state, {
      phase: 'disconnected',
      stale: true,
      staleProperties: [],
      activeTransport: 'unavailable',
      pendingCommands: [],
      lastError: error
    });
    return true;
  }

  get(deviceId: string): YeelightDeviceRuntimeState | undefined {
    const state = this.devices.get(deviceId);
    return state ? structuredClone(state) : undefined;
  }

  snapshot(): YeelightRuntimeSnapshot {
    return {
      revision: this.snapshotRevision,
      devices: [...this.devices.values()]
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
        .map((state) => structuredClone(state))
    };
  }

  private requireDevice(deviceId: string): YeelightDeviceRuntimeState {
    const state = this.devices.get(deviceId);
    if (!state) {
      throw new Error(`Unknown Yeelight device state: ${deviceId}`);
    }
    return state;
  }

  private currentGeneration(
    deviceId: string,
    generation: number
  ): YeelightDeviceRuntimeState | undefined {
    const state = this.devices.get(deviceId);
    return state?.generation === generation ? state : undefined;
  }

  private matchesPending(
    pending: YeelightPendingCommand,
    patch: Readonly<Record<string, string>>
  ): boolean {
    if (pending.expected) {
      return Object.entries(pending.expected).every(
        ([name, value]) => patch[name] === value
      );
    }
    return pending.properties.some(
      (name) =>
        Object.prototype.hasOwnProperty.call(patch, name) &&
        patch[name] !== pending.baseline[name]
    );
  }

  private recordFieldRevisions(
    deviceId: string,
    patch: Readonly<Record<string, string>>,
    revision: number
  ): void {
    const revisions =
      this.fieldRevisions.get(deviceId) ?? new Map<string, number>();
    for (const name of Object.keys(patch)) {
      revisions.set(name, revision);
    }
    this.fieldRevisions.set(deviceId, revisions);
  }

  private mutate(
    state: YeelightDeviceRuntimeState,
    patch: Partial<YeelightDeviceRuntimeState>
  ): YeelightDeviceRuntimeState {
    Object.assign(state, patch);
    state.revision += 1;
    state.updatedAt = this.now();
    this.snapshotRevision += 1;
    this.emit();
    return structuredClone(state);
  }

  private emit(): void {
    if (this.listeners.size === 0) {
      return;
    }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
