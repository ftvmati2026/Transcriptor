// app.js — hilo principal: maneja la UI y orquesta ffmpeg.wasm + el worker.
//
// ffmpeg.wasm se carga como script clásico (UMD) desde index.html, no como
// módulo ES: si se importa como módulo desde un CDN, la librería intenta
// crear un Worker interno apuntando al script del CDN, y el navegador lo
// bloquea porque un Worker no puede crearse con un script de otro origen.
// Cargándolo como UMD y convirtiendo los archivos del core a blob URLs
// (con toBlobURL) evitamos ese problema por completo.
const { FFmpeg } = FFmpegWASM;
const { fetchFile, toBlobURL } = FFmpegUtil;

// Core de ffmpeg de un solo hilo: no necesita los headers COOP/COEP que
// GitHub Pages no te deja configurar, a costa de ser algo más lento que
// la versión multi-hilo.
const FFMPEG_CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

const CHUNK_SECONDS = 28; // ventana nativa de whisper es de 30s, dejamos margen
const SAMPLE_RATE = 16000;

// ---------- Estado ----------
let currentFile = null;
let ffmpeg = null;
let ffmpegReady = false;
let worker = null;
let workerReady = false;

// ---------- Elementos ----------
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileInfo = document.getElementById("fileInfo");
const fileName = document.getElementById("fileName");
const fileMeta = document.getElementById("fileMeta");
const btnTranscribe = document.getElementById("btnTranscribe");
const btnExtractAudio = document.getElementById("btnExtractAudio");
const btnReset = document.getElementById("btnReset");
const progressSection = document.getElementById("progressSection");
const progressStage = document.getElementById("progressStage");
const progressPct = document.getElementById("progressPct");
const progressBar = document.getElementById("progressBar");
const progressDetail = document.getElementById("progressDetail");
const resultSection = document.getElementById("resultSection");
const transcriptOutput = document.getElementById("transcriptOutput");
const btnDownloadTxt = document.getElementById("btnDownloadTxt");
const btnCopy = document.getElementById("btnCopy");
const audioResultSection = document.getElementById("audioResultSection");
const audioPreview = document.getElementById("audioPreview");
const btnDownloadAudio = document.getElementById("btnDownloadAudio");

// ---------- Utilidades UI ----------
function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function setProgress(stage, pct, detail = "") {
  progressSection.classList.remove("hidden");
  progressStage.textContent = stage;
  progressPct.textContent = `${Math.round(pct)}%`;
  progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  progressDetail.textContent = detail;
}

function resetUI() {
  currentFile = null;
  fileInput.value = "";
  fileInfo.classList.add("hidden");
  progressSection.classList.add("hidden");
  resultSection.classList.add("hidden");
  audioResultSection.classList.add("hidden");
  transcriptOutput.value = "";
}

// ---------- Selección de archivo ----------
// El navegador no siempre informa un MIME correcto en formatos poco comunes
// (a veces llega vacío), así que además del MIME chequeamos la extensión.
const VIDEO_EXTENSIONS = [
  "mp4", "mov", "mkv", "avi", "webm", "wmv", "flv", "m4v", "3gp", "mpeg", "mpg", "ts", "ogv",
];

function isVideo(file) {
  if (file.type.startsWith("video/")) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

function onFileSelected(file) {
  currentFile = file;
  fileName.textContent = file.name;
  fileMeta.textContent = `${humanSize(file.size)} · ${file.type || "tipo desconocido"}`;
  fileInfo.classList.remove("hidden");
  resultSection.classList.add("hidden");
  audioResultSection.classList.add("hidden");
  // Extraer audio como archivo aparte solo tiene sentido si es un video
  btnExtractAudio.classList.toggle("hidden", !isVideo(file));
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) onFileSelected(file);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) onFileSelected(fileInput.files[0]);
});
btnReset.addEventListener("click", resetUI);

// ---------- ffmpeg.wasm ----------
async function getFFmpeg() {
  if (ffmpegReady) return ffmpeg;
  ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => {
    // progress viene 0..1 durante el exec en curso
    setProgress("Convirtiendo el archivo…", progress * 100);
  });
  await ffmpeg.load({
    coreURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
  });
  ffmpegReady = true;
  return ffmpeg;
}

// Convierte cualquier audio/video a WAV mono 16kHz (formato que espera whisper)
async function extractPcmWav(file) {
  const ff = await getFFmpeg();
  const inputName = "input" + (file.name.match(/\.[a-zA-Z0-9]+$/)?.[0] || "");
  await ff.writeFile(inputName, await fetchFile(file));
  await ff.exec(["-i", inputName, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "wav", "out.wav"]);
  const data = await ff.readFile("out.wav");
  await ff.deleteFile(inputName);
  await ff.deleteFile("out.wav");
  return data.buffer; // ArrayBuffer
}

// Extrae el audio del video preservando calidad, para descarga directa
async function extractAudioForDownload(file) {
  const ff = await getFFmpeg();
  const inputName = "input" + (file.name.match(/\.[a-zA-Z0-9]+$/)?.[0] || "");
  await ff.writeFile(inputName, await fetchFile(file));
  await ff.exec(["-i", inputName, "-vn", "-acodec", "libmp3lame", "-q:a", "2", "out.mp3"]);
  const data = await ff.readFile("out.mp3");
  await ff.deleteFile(inputName);
  await ff.deleteFile("out.mp3");
  return data.buffer;
}

// ---------- Parseo manual de WAV PCM 16-bit mono ----------
function parseWav16Mono(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  // Buscamos el chunk "data" recorriendo el header en vez de asumir offset fijo,
  // por si el encoder agregó chunks extra (LIST, fact, etc.)
  let offset = 12; // después de "RIFF"+size+"WAVE"
  let dataOffset = -1;
  let dataSize = 0;
  while (offset < view.byteLength - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataOffset === -1) throw new Error("WAV sin chunk de datos");

  const numSamples = dataSize / 2; // 16-bit = 2 bytes por muestra
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
  }
  return samples;
}

// ---------- Worker de transcripción ----------
function getWorker() {
  if (worker) return worker;
  worker = new Worker("worker.js", { type: "module" });
  return worker;
}

function ensureWorkerLoaded() {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    if (workerReady) return resolve();
    setProgress("Cargando el modelo de voz…", 0, "Solo tarda la primera vez; después queda en caché.");
    const handler = (e) => {
      const msg = e.data;
      if (msg.type === "model-progress") {
        const d = msg.data;
        if (d && d.status === "progress" && d.total) {
          const pct = (d.loaded / d.total) * 100;
          setProgress("Descargando modelo de voz…", pct, d.file || "");
        }
      } else if (msg.type === "model-ready") {
        workerReady = true;
        w.removeEventListener("message", handler);
        resolve();
      } else if (msg.type === "error") {
        w.removeEventListener("message", handler);
        reject(new Error(msg.message));
      }
    };
    w.addEventListener("message", handler);
    w.postMessage({ type: "load" });
  });
}

function transcribeChunk(chunkId, audioFloat32) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const handler = (e) => {
      const msg = e.data;
      if (msg.chunkId !== chunkId) return;
      if (msg.type === "chunk-result") {
        w.removeEventListener("message", handler);
        resolve(msg.text);
      } else if (msg.type === "error") {
        w.removeEventListener("message", handler);
        reject(new Error(msg.message));
      }
    };
    w.addEventListener("message", handler);
    // Transferimos el buffer para no copiarlo (más rápido con archivos largos)
    const buf = audioFloat32.buffer.slice(0);
    w.postMessage({ type: "transcribe-chunk", chunkId, audio: new Float32Array(buf) }, [buf]);
  });
}

// ---------- Pipeline completo: transcripción ----------
async function runTranscription(file) {
  btnTranscribe.disabled = true;
  btnExtractAudio.disabled = true;
  try {
    setProgress("Convirtiendo el archivo…", 0);
    const wavBuffer = await extractPcmWav(file);

    setProgress("Preparando el audio…", 100);
    const pcm = parseWav16Mono(wavBuffer);

    await ensureWorkerLoaded();

    const samplesPerChunk = CHUNK_SECONDS * SAMPLE_RATE;
    const totalChunks = Math.max(1, Math.ceil(pcm.length / samplesPerChunk));
    let fullText = "";

    for (let i = 0; i < totalChunks; i++) {
      const start = i * samplesPerChunk;
      const end = Math.min(pcm.length, start + samplesPerChunk);
      const chunk = pcm.subarray(start, end);

      setProgress(
        "Transcribiendo…",
        (i / totalChunks) * 100,
        `Segmento ${i + 1} de ${totalChunks}`
      );

      const text = await transcribeChunk(i, chunk);
      fullText += (fullText ? " " : "") + text;
      transcriptOutput.value = fullText;
    }

    setProgress("Listo", 100, `${totalChunks} segmento(s) procesados`);
    resultSection.classList.remove("hidden");
  } catch (err) {
    setProgress("Error", 0, String(err.message || err));
    console.error(err);
  } finally {
    btnTranscribe.disabled = false;
    btnExtractAudio.disabled = false;
  }
}

// ---------- Pipeline: solo extraer audio ----------
async function runExtractAudioOnly(file) {
  btnTranscribe.disabled = true;
  btnExtractAudio.disabled = true;
  try {
    setProgress("Extrayendo audio…", 0);
    const mp3Buffer = await extractAudioForDownload(file);
    const blob = new Blob([mp3Buffer], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);

    audioPreview.src = url;
    btnDownloadAudio.href = url;
    const base = file.name.replace(/\.[^/.]+$/, "");
    btnDownloadAudio.download = `${base}.mp3`;

    setProgress("Listo", 100);
    audioResultSection.classList.remove("hidden");
  } catch (err) {
    setProgress("Error", 0, String(err.message || err));
    console.error(err);
  } finally {
    btnTranscribe.disabled = false;
    btnExtractAudio.disabled = false;
  }
}

// ---------- Descarga / copia de texto ----------
btnDownloadTxt.addEventListener("click", () => {
  const blob = new Blob([transcriptOutput.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (currentFile?.name.replace(/\.[^/.]+$/, "") || "transcripcion") + ".txt";
  a.click();
  URL.revokeObjectURL(url);
});

btnCopy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(transcriptOutput.value);
  const original = btnCopy.textContent;
  btnCopy.textContent = "Copiado ✓";
  setTimeout(() => (btnCopy.textContent = original), 1500);
});

// ---------- Botones principales ----------
btnTranscribe.addEventListener("click", () => currentFile && runTranscription(currentFile));
btnExtractAudio.addEventListener("click", () => currentFile && runExtractAudioOnly(currentFile));
