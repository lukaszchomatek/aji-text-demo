let extractorPromise;
let modelIdMemo = null;

const loadModel = async (modelId) => {
  if (extractorPromise && modelIdMemo === modelId) {
    return extractorPromise;
  }
  modelIdMemo = modelId;
  extractorPromise = (async () => {
    const start = performance.now();
    self.importScripts(
      "https://unpkg.com/@xenova/transformers@2.17.2/dist/transformers.min.js"
    );
    const { pipeline, env } = self.transformers;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    const extractor = await pipeline("feature-extraction", modelId, {
      quantized: true,
    });
    const loadMs = Math.round(performance.now() - start);
    self.postMessage({ type: "modelReady", payload: { loadMs } });
    return extractor;
  })();
  return extractorPromise;
};

const embedText = async (text, modelId) => {
  const extractor = await loadModel(modelId);
  const output = await extractor(text, {
    pooling: "mean",
    normalize: true,
  });
  return output.data;
};

self.addEventListener("message", async (event) => {
  const { type, id, text, modelId } = event.data;
  if (type === "init") {
    await loadModel(modelId);
    return;
  }
  if (type === "embed") {
    const embedding = await embedText(text, modelId);
    self.postMessage({
      type: "embedResult",
      id,
      payload: { embedding },
    });
  }
});
