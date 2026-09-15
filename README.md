# Transcriptor

Convierte audio y video a texto, y video a audio — todo procesado en el
navegador (WebAssembly), sin backend propio. Pensado para hostear gratis
en GitHub Pages.

## Cómo funciona

- **ffmpeg.wasm** convierte cualquier audio/video a WAV mono 16kHz (para
  transcribir) o a MP3 de buena calidad (para descargar el audio de un video).
- **Whisper vía transformers.js**, corriendo en un Web Worker, transcribe el
  audio en segmentos de ~28 segundos para no trabar la pestaña con archivos
  largos.
- No hay servidor: el archivo nunca sale de la computadora del usuario. Por
  eso no depende de que un hosting como Render se mantenga "vivo".

## Probarlo en local

Como usa Web Workers y ES modules, no alcanza con abrir `index.html` como
archivo — necesita servirse por HTTP. Cualquiera de estas alcanza:

```bash
# opción 1: con Node
npx serve .

# opción 2: con Python
python3 -m http.server 8080
```

Después abrí `http://localhost:PUERTO` en el navegador.

## Publicar en GitHub Pages

1. Subí esta carpeta (`index.html`, `styles.css`, `app.js`, `worker.js`) a
   un repositorio en GitHub.
2. En el repo: **Settings → Pages → Source**, elegí la rama (`main`) y la
   carpeta (`/root` o `/docs`, según dónde hayas puesto los archivos).
3. Guardá. GitHub te da una URL tipo
   `https://tu-usuario.github.io/tu-repo/` en un par de minutos.

No hace falta build, ni Actions, ni configurar headers especiales — por eso
se usa el core de ffmpeg de un solo hilo (`@ffmpeg/core`), que no requiere
los headers `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`
que GitHub Pages no te deja setear.

## Primer uso

La primera vez que alguien transcribe algo, el navegador descarga el
modelo Whisper (unos cientos de MB) desde Hugging Face y lo cachea en
IndexedDB. Las siguientes veces arranca directo, sin descargar de nuevo.

## Formatos soportados

No hay una lista blanca de extensiones: cualquier archivo que sueltes se le
pasa directo a ffmpeg, que reconoce el contenedor y códec internamente. Esto
cubre la enorme mayoría de casos reales — MP4, MOV, MKV, AVI, WebM, WMV, WAV,
MP3, M4A, FLAC, OGG, AAC, WMA, etc. La única excepción sería un códec
realmente exótico que el build estándar de ffmpeg.wasm no incluya, algo muy
poco común en archivos de uso normal.

## Limitaciones conocidas

- **Corrección gramatical**: no se aplica corrección gramatical completa
  (requeriría otro modelo de lenguaje pesado corriendo en el navegador).
  Whisper ya devuelve texto con puntuación y capitalización razonables.
- **Cortes de segmento**: el audio se trocea en segmentos fijos de 28s sin
  solapamiento, así que ocasionalmente una palabra justo en el borde puede
  transcribirse un poco distinto. Se podría mejorar agregando solapamiento
  con deduplicación de texto si hace falta más precisión.
- **Velocidad**: todo corre en la CPU del usuario. Un archivo de varias
  horas puede tardar bastante — es el costo de que sea 100% gratis y sin
  servidor.
- **Modelo**: usa `Xenova/whisper-base` por defecto (buen balance
  velocidad/calidad). Se puede cambiar a `whisper-small` (mejor calidad,
  más lento) o `whisper-tiny` (más rápido, menos preciso) editando
  `worker.js`.

## Estructura

```
index.html         → interfaz
styles.css         → estilos
app.js             → UI + ffmpeg.wasm + orquestación
worker.js          → carga y corre el modelo Whisper en segundo plano
vendor/ffmpeg/     → ffmpeg.wasm auto-hosteado (ver más abajo)
```

## Por qué ffmpeg.wasm está auto-hosteado (carpeta vendor/)

`@ffmpeg/ffmpeg` crea internamente un Web Worker apuntando siempre al
mismo sitio de donde se cargó el script. Si se lo carga desde un CDN
(unpkg, jsdelivr), ese Worker termina apuntando al CDN, y los navegadores
no permiten crear un Worker con un script de otro origen que la página —
tira `Failed to construct 'Worker'`. La solución es alojar esos archivos
junto con el resto del sitio, así el Worker queda en el mismo origen. Por
eso `vendor/ffmpeg/ffmpeg.js`, `vendor/ffmpeg/814.ffmpeg.js` y
`vendor/ffmpeg/ffmpeg-util.js` viajan en el repo en vez de importarse
desde un CDN. El core de ffmpeg (`ffmpeg-core.js`/`.wasm`, mucho más
pesado) sí se sigue trayendo de un CDN en tiempo de ejecución, porque ese
no se carga como Worker, sino que se descarga como datos.
