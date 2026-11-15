import { logger, plugin } from '@eniac/flexdesigner';
import {
  YeelightV1CatalogRuntime,
  normalizeV1UiRequest
} from './catalog-runtime';
import { YeelightV1UnitRuntime } from './unit-runtime';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const runtimeLogger = {
  debug(message: string, data?: Record<string, unknown>): void {
    logger?.debug(message, data);
  },
  info(message: string, data?: Record<string, unknown>): void {
    logger?.info(message, data);
  },
  warn(message: string, data?: Record<string, unknown>): void {
    logger?.warn(message, data);
  }
};

const runtime = new YeelightV1CatalogRuntime({
  configStore: {
    getConfig: () => plugin.getConfig(),
    setConfig: (config) => plugin.setConfig(config)
  },
  logger: runtimeLogger
});

const unitRuntime = new YeelightV1UnitRuntime({
  source: runtime,
  host: {
    setMultiState: (serialNumber, key, state) =>
      plugin.setMultiState(serialNumber, key, state),
    setSlider: (serialNumber, key, value) =>
      plugin.setSlider(serialNumber, key, value),
    showError: (serialNumber, message) =>
      plugin.showFlexbarSnackbarMessage(
        serialNumber,
        message,
        'error',
        'warning',
        2_000
      )
  },
  logger: runtimeLogger
});

let initializationTimer: ReturnType<typeof setTimeout> | undefined;

function ensureInitialized(): Promise<void> {
  return runtime.initialize().catch((error: unknown) => {
    runtimeLogger.warn('Yeelight LAN runtime initialization failed', {
      error: errorMessage(error)
    });
    throw error;
  });
}

plugin.on('plugin.alive', ({ serialNumber, keys }) => {
  runtimeLogger.info('Yeelight plugin keys loaded', {
    serialNumber,
    keys: keys.map((key) => ({
      uid: key.uid,
      cid: key.cid,
      keyType: key.cfg?.keyType,
      width: key.width,
      styleWidth: key.style?.width,
      sliderWidth: (
        key.style as { slider?: { width?: number } } | undefined
      )?.slider?.width,
      targetId: (key.data as { targetId?: unknown })?.targetId
    }))
  });
  void ensureInitialized()
    .then(() => unitRuntime.handleAlive(serialNumber, keys))
    .catch(() => undefined);
});

plugin.on('plugin.dead', ({ serialNumber, keys }) => {
  runtimeLogger.info('Yeelight plugin keys unloaded', {
    serialNumber,
    keys: keys.map((key: { uid: number; cid: string }) => ({
      uid: key.uid,
      cid: key.cid
    }))
  });
  unitRuntime.handleDead(serialNumber, keys);
});

plugin.on('plugin.data', (payload) => {
  runtimeLogger.debug('Yeelight key event', {
    serialNumber: payload.serialNumber,
    cid: payload.data.key.cid,
    uid: payload.data.key.uid,
    value: 'value' in payload.data ? payload.data.value : undefined,
    state: 'state' in payload.data ? payload.data.state : undefined
  });
  void ensureInitialized()
    .then(() => unitRuntime.handleData(payload))
    .catch((error: unknown) => {
      runtimeLogger.warn('Cannot handle Yeelight key event', {
        error: errorMessage(error)
      });
    });
  return {
    status: 'success'
  };
});

plugin.on('device.status', (devices) => {
  runtimeLogger.debug('Flexbar device status changed', {
    devices: devices.map(({ serialNumber, status }) => ({
      serialNumber,
      status
    }))
  });
  if (devices.some(({ status }) => status === 'connected')) {
    void ensureInitialized()
      .then(() => unitRuntime.synchronize())
      .catch(() => undefined);
  }
});

plugin.on('ui.message', async (payload) => {
  try {
    const request = normalizeV1UiRequest(payload);
    const data = await runtime.handleUiRequest(request);
    return {
      ok: true,
      data
    };
  } catch (error) {
    runtimeLogger.warn('Yeelight UI action failed', {
      error: errorMessage(error)
    });
    return {
      ok: false,
      error: errorMessage(error)
    };
  }
});

plugin.start();

initializationTimer = setTimeout(() => {
  initializationTimer = undefined;
  void ensureInitialized().catch(() => undefined);
}, 500);

process.once('SIGTERM', () => {
  if (initializationTimer) {
    clearTimeout(initializationTimer);
    initializationTimer = undefined;
  }
  unitRuntime.stop();
  void runtime.shutdown();
});

runtimeLogger.info('Yeelight FlexDesigner v1 Stage 13 backend started');
