import { useConfig as useDirectConfig } from "@/providers/app-state";
import { useHarness } from "@/providers/harness-state";
import type { ModelRef, ResolvedModel } from "@/core/types/app-state";

function labelDirectSource(model: ResolvedModel): ResolvedModel {
  return /opencode/i.test(model.providerLabel)
    ? { ...model, providerLabel: `${model.providerLabel} (API)` }
    : model;
}

export function useConfig() {
  const direct = useDirectConfig();
  const harness = useHarness();
  const model = harness.active
    ? harness.currentModel
    : direct.currentModel
      ? labelDirectSource(direct.currentModel)
      : null;
  return {
    ...direct,
    activeModels: [
      ...direct.activeModels.map(labelDirectSource),
      ...harness.availableModels,
    ],
    currentModel: model,
    currentModelSupportsImageGeneration:
      model?.supportsImageGeneration ?? false,
    currentModelSupportsImageInput: model?.supportsImageInput ?? false,
    currentModelSupportsAudioInput: model?.supportsAudioInput ?? false,
    currentModelSupportsVideoInput: model?.supportsVideoInput ?? false,
    currentModelSupportsTools: model?.supportsTools ?? false,
    selectModel: async (ref: ModelRef) => {
      if (ref.startsWith("harness:opencode/")) await harness.selectModel(ref);
      else {
        harness.deactivate();
        await direct.selectModel(ref);
      }
    },
  };
}
