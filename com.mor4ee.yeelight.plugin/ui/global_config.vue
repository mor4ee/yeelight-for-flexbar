<template>
  <v-container class="yeelight-config pa-4">
    <div class="identity-row">
      <div class="identity-copy">
        <v-icon icon="mdi-lightbulb-group-outline" size="28" />
        <div class="identity-text">
          <div class="text-subtitle-1 font-weight-medium">Yeelight</div>
          <div class="text-caption text-medium-emphasis">
            {{ $t('Config.LocalNetwork') }}
          </div>
        </div>
      </div>
      <div class="identity-actions">
        <v-chip
          size="small"
          variant="tonal"
          :color="onlineDeviceCount > 0 ? 'success' : undefined"
        >
          {{
            $t('Config.OnlineCount', {
              online: onlineDeviceCount,
              total: devices.length
            })
          }}
        </v-chip>
        <v-btn
          color="primary"
          variant="tonal"
          size="small"
          prepend-icon="mdi-radar"
          :loading="scanBusy"
          :disabled="loading || manualBusy"
          @click="scan"
        >
          {{ $t('Config.Scan') }}
        </v-btn>
      </div>
    </div>

    <v-alert
      v-if="errorMessage"
      type="error"
      variant="tonal"
      density="compact"
      closable
      @click:close="errorMessage = ''"
    >
      {{ errorMessage }}
    </v-alert>

    <v-alert
      v-else-if="discoveryError"
      type="warning"
      variant="tonal"
      density="compact"
    >
      {{ discoveryError }}
    </v-alert>

    <v-progress-linear
      v-if="scanning"
      color="primary"
      indeterminate
      rounded
    />

    <v-sheet class="settings-section" rounded="lg">
      <div class="section-heading">
        <span>{{ $t('Config.Devices') }}</span>
        <v-chip size="small" variant="tonal">{{ targets.length }}</v-chip>
      </div>

      <div v-if="loading" class="empty-state">
        <v-progress-circular color="primary" indeterminate size="26" />
      </div>

      <div v-else-if="targets.length" class="device-list">
        <div
          v-for="target in targets"
          :key="target.targetId"
          class="device-row"
        >
          <v-icon
            :icon="
              target.online
                ? 'mdi-lightbulb-on-outline'
                : 'mdi-lightbulb-off-outline'
            "
            :color="target.online ? 'success' : undefined"
          />
          <div class="device-copy">
            <div class="device-name">
              {{ targetDisplayName(target) }}
            </div>
            <div class="device-meta">
              {{ target.host }}
              <template v-if="target.model"> · {{ target.model }}</template>
            </div>
            <div class="device-capabilities">
              {{ capabilitySummary(target.capabilities) }}
            </div>
          </div>
          <v-chip
            size="small"
            variant="tonal"
            :color="target.online ? 'success' : 'warning'"
          >
            {{
              target.online
                ? $t('Config.Online')
                : $t('Config.Offline')
            }}
          </v-chip>
        </div>
      </div>

      <div v-else class="empty-state">
        <v-icon icon="mdi-radar" size="26" />
        <span>{{ $t('Config.NoDevices') }}</span>
      </div>
    </v-sheet>

    <v-sheet class="settings-section" rounded="lg">
      <div class="section-heading">
        <span>{{ $t('Config.ManualTitle') }}</span>
      </div>

      <div class="manual-row">
        <v-text-field
          v-model="manualAddress"
          :label="$t('Config.ManualAddress')"
          :placeholder="$t('Config.ManualPlaceholder')"
          variant="solo-filled"
          density="compact"
          hide-details
          :disabled="manualBusy"
          @keyup.enter="addManualAddress"
        />
        <v-btn
          color="primary"
          variant="tonal"
          size="small"
          prepend-icon="mdi-plus"
          :loading="manualBusy"
          :disabled="!manualAddress.trim() || scanBusy"
          @click="addManualAddress"
        >
          {{ $t('Config.Add') }}
        </v-btn>
      </div>

      <div v-if="manualAddresses.length" class="manual-addresses">
        <v-chip
          v-for="address in manualAddresses"
          :key="address"
          size="small"
          variant="tonal"
          closable
          :disabled="manualBusy"
          @click:close="removeManualAddress(address)"
        >
          {{ address }}
        </v-chip>
      </div>
    </v-sheet>
  </v-container>
</template>

<script>
export default {
  props: {
    modelValue: {
      type: Object,
      required: true
    }
  },
  data() {
    return {
      payload: null,
      loading: true,
      scanBusy: false,
      manualBusy: false,
      manualAddress: '',
      errorMessage: ''
    };
  },
  computed: {
    devices() {
      return this.payload?.catalog?.devices ?? [];
    },
    targets() {
      return this.payload?.catalog?.targets ?? [];
    },
    manualAddresses() {
      return this.payload?.manualAddresses ?? [];
    },
    onlineDeviceCount() {
      return this.devices.filter((device) => device.online).length;
    },
    scanning() {
      return Boolean(this.payload?.discovery?.scanning || this.scanBusy);
    },
    discoveryError() {
      return this.payload?.discovery?.lastError ?? '';
    }
  },
  methods: {
    async request(action, fields = {}) {
      const response = await this.$fd.sendToBackend({
        data: {
          action,
          ...fields
        }
      });
      if (!response?.ok) {
        throw new Error(
          response?.error || this.$t('Config.ActionFailed')
        );
      }
      return response.data;
    },
    async refreshCatalog() {
      this.loading = true;
      this.errorMessage = '';
      try {
        this.payload = await this.request('yeelight.catalog.get');
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : String(error);
      } finally {
        this.loading = false;
      }
    },
    async scan() {
      this.scanBusy = true;
      this.errorMessage = '';
      try {
        this.payload = await this.request('yeelight.discovery.scan');
        this.$fd.showSnackbarMessage(
          'success',
          this.$t('Config.ScanComplete')
        );
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : String(error);
      } finally {
        this.scanBusy = false;
      }
    },
    async addManualAddress() {
      const address = this.manualAddress.trim();
      if (!address) {
        return;
      }
      this.manualBusy = true;
      this.errorMessage = '';
      try {
        this.payload = await this.request('yeelight.manual.add', {
          address
        });
        this.manualAddress = '';
        this.$fd.showSnackbarMessage(
          'success',
          this.$t('Config.AddressAdded')
        );
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : String(error);
      } finally {
        this.manualBusy = false;
      }
    },
    async removeManualAddress(address) {
      this.manualBusy = true;
      this.errorMessage = '';
      try {
        this.payload = await this.request('yeelight.manual.remove', {
          address
        });
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : String(error);
      } finally {
        this.manualBusy = false;
      }
    },
    targetDisplayName(target) {
      const domain = target.domain === 'background'
        ? this.$t('Config.Background')
        : this.$t('Config.Main');
      return `${target.name} · ${domain}`;
    },
    capabilitySummary(capabilities) {
      if (!Array.isArray(capabilities) || capabilities.length === 0) {
        return this.$t('Config.NoCapabilities');
      }
      return capabilities
        .map((capability) =>
          this.$t(`Config.Capability.${capability}`)
        )
        .join(' · ');
    }
  },
  mounted() {
    this.$fd.info('Yeelight Stage 12 config page mounted');
    void this.refreshCatalog();
  }
};
</script>

<style scoped>
.yeelight-config {
  display: grid;
  gap: 14px;
  width: 100%;
}

.identity-row,
.identity-copy,
.identity-actions,
.section-heading,
.manual-row {
  display: flex;
  align-items: center;
}

.identity-row,
.section-heading {
  justify-content: space-between;
}

.identity-row,
.identity-copy,
.identity-actions,
.manual-row {
  gap: 10px;
}

.identity-text,
.device-copy,
.device-name {
  min-width: 0;
}

.settings-section {
  display: grid;
  gap: 10px;
  padding: 12px;
  background: rgba(var(--v-theme-on-surface), 0.045);
}

.section-heading {
  font-size: 13px;
  font-weight: 600;
}

.device-list {
  display: grid;
}

.device-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 54px;
  padding: 7px 2px;
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.09);
}

.device-name,
.device-meta,
.device-capabilities {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device-name {
  font-size: 13px;
  font-weight: 500;
}

.device-meta,
.device-capabilities {
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 11px;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 74px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 13px;
}

.manual-row .v-field {
  min-width: 0;
}

.manual-addresses {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

@media (max-width: 560px) {
  .identity-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .identity-actions {
    justify-content: space-between;
    width: 100%;
  }

  .manual-row {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
