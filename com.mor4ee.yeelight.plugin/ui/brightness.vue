<template>
  <v-container class="yeelight-editor pa-4">
    <v-select
      :model-value="modelValue.data.targetId"
      :items="targetItems"
      :label="$t('Editor.Target')"
      item-title="title"
      item-value="value"
      variant="solo-filled"
      density="compact"
      hide-details
      :loading="loading"
      :disabled="loading"
      @update:model-value="selectTarget"
    />

    <v-alert
      v-if="errorMessage"
      type="error"
      variant="tonal"
      density="compact"
    >
      {{ errorMessage }}
    </v-alert>
    <v-alert
      v-else-if="targetWarning"
      type="warning"
      variant="tonal"
      density="compact"
    >
      {{ targetWarning }}
    </v-alert>
    <div
      v-else-if="!loading && compatibleTargets.length === 0"
      class="empty-state"
    >
      <v-icon icon="mdi-radar" size="22" />
      <span>{{ $t('Editor.NoDevices') }}</span>
    </div>

    <v-sheet class="range-section" rounded="lg">
      <div class="range-heading">
        <span>{{ $t('Editor.BrightnessRange') }}</span>
        <v-chip size="small" variant="tonal">
          {{ modelValue.data.minimum }}–{{ modelValue.data.maximum }}%
        </v-chip>
      </div>
      <v-range-slider
        :model-value="range"
        :min="0"
        :max="100"
        :step="1"
        color="primary"
        density="compact"
        hide-details
        thumb-label
        @update:model-value="setRange"
      />
      <div class="range-fields">
        <v-text-field
          :model-value="modelValue.data.minimum"
          :label="$t('Editor.Minimum')"
          type="number"
          min="0"
          max="99"
          step="1"
          suffix="%"
          variant="solo-filled"
          density="compact"
          hide-details
          @update:model-value="setMinimum"
        />
        <v-text-field
          :model-value="modelValue.data.maximum"
          :label="$t('Editor.Maximum')"
          type="number"
          min="1"
          max="100"
          step="1"
          suffix="%"
          variant="solo-filled"
          density="compact"
          hide-details
          @update:model-value="setMaximum"
        />
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
  emits: ['update:modelValue'],
  watch: {
    'modelValue.width'() {
      if (this.syncNativeWidth()) {
        this.emitChange();
      }
    },
    'modelValue.style.width'() {
      if (this.syncNativeWidth()) {
        this.emitChange();
      }
    }
  },
  data() {
    return {
      payload: null,
      loading: true,
      errorMessage: '',
      requiredCapability: 'brightness'
    };
  },
  computed: {
    range() {
      return [
        this.modelValue.data.minimum,
        this.modelValue.data.maximum
      ];
    },
    targets() {
      return this.payload?.catalog?.targets ?? [];
    },
    compatibleTargets() {
      return this.targets.filter((target) =>
        target.capabilities?.includes(this.requiredCapability)
      );
    },
    selectedTarget() {
      return this.targets.find(
        (target) => target.targetId === this.modelValue.data.targetId
      );
    },
    targetItems() {
      const targets = [...this.compatibleTargets];
      if (
        this.selectedTarget &&
        !targets.some(
          (target) => target.targetId === this.selectedTarget.targetId
        )
      ) {
        targets.push(this.selectedTarget);
      }
      if (
        this.modelValue.data.targetId &&
        !targets.some(
          (target) => target.targetId === this.modelValue.data.targetId
        )
      ) {
        targets.push({
          targetId: this.modelValue.data.targetId,
          name: this.modelValue.data.targetId,
          domain: 'main',
          capabilities: [],
          online: false
        });
      }
      return targets.map((target) => ({
        title: this.targetTitle(target),
        value: target.targetId
      }));
    },
    targetWarning() {
      if (!this.modelValue.data.targetId) {
        return '';
      }
      if (
        !this.selectedTarget ||
        !this.selectedTarget.capabilities?.includes(
          this.requiredCapability
        )
      ) {
        return this.$t('Editor.SavedIncompatible');
      }
      return this.selectedTarget.online
        ? ''
        : this.$t('Editor.SavedUnavailable');
    }
  },
  methods: {
    selectTarget(targetId) {
      this.modelValue.data.targetId = targetId ?? '';
      this.emitChange();
    },
    setRange(values) {
      if (!Array.isArray(values) || values.length !== 2) {
        return;
      }
      const minimum = Math.min(
        99,
        Math.max(0, Math.round(Number(values[0])))
      );
      const maximum = Math.min(
        100,
        Math.max(1, Math.round(Number(values[1])))
      );
      if (minimum >= maximum) {
        return;
      }
      this.modelValue.data.minimum = minimum;
      this.modelValue.data.maximum = maximum;
      this.syncNativeRange();
      this.emitChange();
    },
    setMinimum(value) {
      const minimum = Math.min(
        this.modelValue.data.maximum - 1,
        Math.max(0, Math.round(Number(value)))
      );
      if (Number.isFinite(minimum)) {
        this.setRange([minimum, this.modelValue.data.maximum]);
      }
    },
    setMaximum(value) {
      const maximum = Math.max(
        this.modelValue.data.minimum + 1,
        Math.min(100, Math.round(Number(value)))
      );
      if (Number.isFinite(maximum)) {
        this.setRange([this.modelValue.data.minimum, maximum]);
      }
    },
    syncNativeRange() {
      this.modelValue.style ??= {};
      this.modelValue.style.slider ??= {};
      this.modelValue.style.slider.min = this.modelValue.data.minimum;
      this.modelValue.style.slider.max = this.modelValue.data.maximum;
    },
    syncNativeWidth() {
      const placedWidth = Number(this.modelValue.width);
      const styleWidth = Number(this.modelValue.style?.width);
      const width = Number.isFinite(placedWidth)
        ? placedWidth
        : styleWidth;
      if (!Number.isFinite(width)) {
        return false;
      }
      this.modelValue.style ??= {};
      this.modelValue.style.slider ??= {};
      const sliderWidth = Math.max(28, Math.round(width) - 100);
      if (this.modelValue.style.slider.width === sliderWidth) {
        return false;
      }
      this.modelValue.style.slider.width = sliderWidth;
      return true;
    },
    emitChange() {
      this.$emit('update:modelValue', this.modelValue);
    },
    targetTitle(target) {
      const domain = target.domain === 'background'
        ? this.$t('Editor.Background')
        : this.$t('Editor.Main');
      const status = target.online
        ? this.$t('Editor.Online')
        : this.$t('Editor.Offline');
      return `${target.name} · ${domain} · ${status}`;
    },
    async loadCatalog() {
      this.loading = true;
      this.errorMessage = '';
      try {
        const response = await this.$fd.sendToBackend({
          data: { action: 'yeelight.catalog.get' }
        });
        if (!response?.ok) {
          throw new Error(
            response?.error || this.$t('Editor.ActionFailed')
          );
        }
        this.payload = response.data;
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : String(error);
      } finally {
        this.loading = false;
      }
    }
  },
  mounted() {
    this.modelValue.data ??= {};
    this.modelValue.data.schemaVersion = 1;
    this.modelValue.data.targetId ??= '';
    if (
      !Number.isInteger(this.modelValue.data.minimum) ||
      !Number.isInteger(this.modelValue.data.maximum) ||
      this.modelValue.data.minimum < 0 ||
      this.modelValue.data.maximum > 100 ||
      this.modelValue.data.minimum >= this.modelValue.data.maximum
    ) {
      this.modelValue.data.minimum = 0;
      this.modelValue.data.maximum = 100;
    }
    this.syncNativeRange();
    if (this.syncNativeWidth()) {
      this.emitChange();
    }
    void this.loadCatalog();
  }
};
</script>

<style scoped>
.yeelight-editor {
  display: grid;
  gap: 12px;
  width: 100%;
}

.range-section {
  display: grid;
  gap: 8px;
  padding: 12px;
  background: rgba(var(--v-theme-on-surface), 0.045);
}

.range-heading,
.range-fields,
.empty-state {
  display: flex;
  align-items: center;
}

.range-heading {
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
}

.range-fields {
  gap: 10px;
}

.range-fields > * {
  flex: 1 1 0;
}

.empty-state {
  gap: 9px;
  min-height: 42px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 13px;
}
</style>
