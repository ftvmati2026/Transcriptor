// worker.js
// Corre en un hilo aparte: carga el modelo Whisper una sola vez y transcribe
// los chunks de audio (Float32Array a 16kHz mono) que le manda app.js.
// Ahora app.js puede levantar VARIAS copias de este worker en paralelo
// (una por núcleo disponible) para procesar varios segmentos a la vez.

import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0/+esm";

// No usamos modelos locales propios: que baje del hub de Hugging Face y
// cachee en el navegador (IndexedDB) para las próximas veces.
env.allowLocalModels = false;

let transcriber = null;
let loadedModelId = null;

async function getTranscriber(modelId) {
  if (transcriber && loadedModelId === modelId) return transcriber;

  // Intentamos acelerar con la GPU vía WebGPU si el navegador la soporta;
  // si falla por lo que sea, caemos de nuevo a CPU (WASM) sin romper nada.
  const tryDevices = navigator.gpu ? ["webgpu", "wasm"] : ["wasm"];
  let lastErr = null;
  for (const device of tryDevices) {
    try {
      transcriber = await pipeline("automatic-speech-recognition", modelId, {
        device,
        progress_callback: (data) => {
          postMessage({ type: "model-progress", data });
        },
      });
      loadedModelId = modelId;
      postMessage({ type: "device-used", device });
      return transcriber;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

onmessage = async (e) => {
  const { type } = e.data;

  if (type === "load") {
    const { modelId } = e.data;
    try {
      await getTranscriber(modelId);
      postMessage({ type: "model-ready" });
    } catch (err) {
      postMessage({ type: "error", message: String(err) });
    }
    return;
  }

  if (type === "transcribe-chunk") {
    const { chunkId, audio, language, modelId } = e.data;
    try {
      const model = await getTranscriber(modelId);
      // audio ya viene troceado en clips cortos (<=30s) desde app.js,
      // así que no hace falta el chunking interno del pipeline.
      const result = await model(audio, {
        language: language || undefined, // undefined = autodetectar
        task: "transcribe",
      });
      postMessage({ type: "chunk-result", chunkId, text: result.text.trim() });
    } catch (err) {
      postMessage({ type: "error", chunkId, message: String(err) });
    }
  }
};
