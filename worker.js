// worker.js
// Corre en un hilo aparte: carga el modelo Whisper una sola vez y transcribe
// los chunks de audio (Float32Array a 16kHz mono) que le manda app.js.

import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0/+esm";

// No usamos modelos locales propios: que baje del hub de Hugging Face y
// cachee en el navegador (IndexedDB) para las próximas veces.
env.allowLocalModels = false;

let transcriber = null;

async function getTranscriber() {
  if (transcriber) return transcriber;
  transcriber = await pipeline(
    "automatic-speech-recognition",
    // whisper-base multilingüe: buen balance velocidad/calidad para correr
    // en CPU/WASM en cualquier compu. Se puede subir a "small" si sobra
    // potencia, o bajar a "tiny" si hace falta más velocidad.
    "Xenova/whisper-base",
    {
      progress_callback: (data) => {
        postMessage({ type: "model-progress", data });
      },
    }
  );
  return transcriber;
}

onmessage = async (e) => {
  const { type } = e.data;

  if (type === "load") {
    try {
      await getTranscriber();
      postMessage({ type: "model-ready" });
    } catch (err) {
      postMessage({ type: "error", message: String(err) });
    }
    return;
  }

  if (type === "transcribe-chunk") {
    const { chunkId, audio, language } = e.data;
    try {
      const model = await getTranscriber();
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
