// app.js — hilo principal: maneja la UI y orquesta ffmpeg.wasm + el worker.
//
// ffmpeg.wasm se carga como script clásico (UMD) desde archivos propios en
// vendor/ffmpeg/ (no desde un CDN): la librería crea internamente un Worker
// apuntando siempre a la ubicación de donde se la cargó, y un Worker no
// puede crearse con un script de otro origen. Auto-hosteando los archivos
// junto con el resto del sitio, el Worker queda en el mismo origen y no
// hay restricción posible.
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
const langSelect = document.getElementById("langSelect");
const clockEl = document.getElementById("clock");

// ---------- Reloj en vivo ----------
function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString("es-AR", { hour12: false });
}
tickClock();
setInterval(tickClock, 1000);

// ---------- Fondo animado: manchas de color tipo "ambient glow" ----------
// Unas cuantas manchas de color grandes y difusas que flotan solas y
// reaccionan un poco a dónde está el mouse (efecto de profundidad/parallax),
// dibujadas en un <canvas> detrás de todo el contenido.
function initBgCanvas() {
  const canvas = document.getElementById("bgCanvas");
  const ctx = canvas.getContext("2d");
  let w, h;
  let mouseX = 0.5, mouseY = 0.5; // 0..1

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", (e) => {
    mouseX = e.clientX / window.innerWidth;
    mouseY = e.clientY / window.innerHeight;
  });

  const palette = ["#ff6b6b", "#ffa94d", "#cc5de8", "#20c997", "#ffd43b", "#7fd0ff"];
  const blobs = palette.map((color, i) => ({
    color,
    baseX: Math.random(),
    baseY: Math.random(),
    r: 220 + Math.random() * 160,
    speed: 0.00025 + Math.random() * 0.0004,
    phase: Math.random() * Math.PI * 2,
    depth: 20 + i * 10, // cuánto reacciona al mouse (parallax)
  }));

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    for (const b of blobs) {
      const drift = Math.sin(t * b.speed + b.phase);
      const x = b.baseX * w + drift * 60 + (mouseX - 0.5) * b.depth;
      const y = b.baseY * h + Math.cos(t * b.speed + b.phase) * 60 + (mouseY - 0.5) * b.depth;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, b.r);
      grad.addColorStop(0, b.color + "55");
      grad.addColorStop(1, b.color + "00");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}
initBgCanvas();

// ---------- Botones magnéticos: siguen un poco al mouse al pasar cerca ----------
document.querySelectorAll(".btn").forEach((btn) => {
  btn.addEventListener("mousemove", (e) => {
    const rect = btn.getBoundingClientRect();
    const relX = e.clientX - rect.left - rect.width / 2;
    const relY = e.clientY - rect.top - rect.height / 2;
    btn.style.transform = `translate(${relX * 0.18}px, ${relY * 0.35}px) scale(1.04)`;
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "";
  });
});

// ---------- Confetti de celebración ----------
function celebrate() {
  const colors = ["#ff6b6b", "#ffa94d", "#ffd43b", "#20c997", "#cc5de8"];
  for (let i = 0; i < 24; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 200}px`);
    piece.style.animationDuration = `${1.1 + Math.random() * 0.8}s`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 2200);
  }
}

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

function transcribeChunk(chunkId, audioFloat32, language) {
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
    // audioFloat32 es un subarray (vista) sobre el buffer completo del audio.
    // Float32Array.prototype.slice() copia SOLO el rango de este chunk a un
    // buffer nuevo del tamaño justo — así el worker recibe únicamente este
    // segmento, no el audio entero.
    const chunkCopy = audioFloat32.slice();
    w.postMessage(
      { type: "transcribe-chunk", chunkId, audio: chunkCopy, language },
      [chunkCopy.buffer]
    );
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

      const text = await transcribeChunk(i, chunk, langSelect.value);
      fullText += (fullText ? " " : "") + text;
      transcriptOutput.value = fullText;
    }

    setProgress("Listo", 100, `${totalChunks} segmento(s) procesados`);
    resultSection.classList.remove("hidden");
    celebrate();
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
    celebrate();
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
