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
        this.$emit('update:modelValue', this.modelValue);
      }
    },
    'modelValue.style.width'() {
      if (this.syncNativeWidth()) {
        this.$emit('update:modelValue', this.modelValue);
      }
    }
  },
  data() {
    return {
      payload: null,
      loading: true,
      errorMessage: '',
      requiredCapability: 'colorTemperature'
    };
  },
  computed: {
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
      this.syncTargetRange(targetId);
      this.$emit('update:modelValue', this.modelValue);
    },
    syncTargetRange(targetId = this.modelValue.data.targetId) {
      const target = this.targets.find(
        (entry) => entry.targetId === targetId
      );
      const minimum = Number(target?.properties?.min_ct);
      const maximum = Number(target?.properties?.max_ct);
      const validRange =
        Number.isInteger(minimum) &&
        Number.isInteger(maximum) &&
        minimum >= 1700 &&
        maximum <= 6500 &&
        minimum < maximum;
      this.modelValue.style ??= {};
      this.modelValue.style.slider ??= {};
      this.modelValue.style.slider.min = validRange ? minimum : 1700;
      this.modelValue.style.slider.max = validRange ? maximum : 6500;
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
        this.syncTargetRange();
        this.$emit('update:modelValue', this.modelValue);
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
    if (this.syncNativeWidth()) {
      this.$emit('update:modelValue', this.modelValue);
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

.empty-state {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 42px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 13px;
}
</style>
