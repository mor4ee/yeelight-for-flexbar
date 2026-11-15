<template>
  <v-container
    class="yeelight-editor pa-4"
    :class="{ 'target-menu-open': targetMenuOpen }"
  >
    <v-select
      v-model:menu="targetMenuOpen"
      :model-value="modelValue.data.targetId"
      :items="targetItems"
      :menu-props="{ maxHeight: 240 }"
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
  data() {
    return {
      payload: null,
      loading: true,
      errorMessage: '',
      targetMenuOpen: false,
      requiredCapability: 'power'
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
      this.$emit('update:modelValue', { data: this.modelValue.data });
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

.yeelight-editor.target-menu-open {
  min-height: 300px;
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
