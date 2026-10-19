# Lazo (antes MNEMO)

Prueba de concepto del TP de **Visión por Computadora** (Maestría en IA, Universidad de Palermo).
Lazo (antes MNEMO) es un sistema de reconocimiento facial **consentido**, como apoyo a la memoria social de personas con demencia. Está pensado para gafas inteligentes, pero es software: se conecta a las gafas, a la cámara del teléfono o a una webcam a través de una interfaz de captura abstracta. Sólo identifica a quienes se enrolaron en persona, todo el cómputo ocurre en el dispositivo y, ante la duda, dice «no estoy seguro» antes que arriesgar un nombre.

Lazo es el nombre público del proyecto; el paquete Python (`mnemo`, `mnemo-eval`) y la app Android conservan el nombre MNEMO.

El mismo pipeline de ocho etapas (preprocesamiento, calidad, detección, alineación, *embedding*, plantilla, búsqueda y decisión) está implementado tres veces, con los mismos modelos y los mismos umbrales:

| Carpeta | Qué es | Estado |
|---|---|---|
| [`core/`](core) | Banco de pruebas en Python: pipeline de referencia, galería cifrada, CLI con webcam, evaluación FPIR/FNIR y curva DET | 26 tests OK, incluidos los de extremo a extremo con los modelos reales |
| [`web/`](web) | Demo web con webcam o cámara del teléfono. Vista de quien usa las gafas y app del cuidador, todo en el navegador | 23 tests unitarios + 5 aserciones e2e OK en Chrome headless. Paridad con Python: coseno ≥ 0,995 por rostro |
| [`android/`](android) | App Android con la **interfaz de captura abstracta**: cámara del teléfono (CameraX), **Ray-Ban Meta** (Meta Wearables DAT 1.0) y gafas simuladas (MockDeviceKit) | Escrita contra la API del sample oficial; **todavía no compilada** (ver limitaciones) |

## Origen y resultados

Este repositorio es la prueba de concepto del TP de Visión por Computadora de la Maestría en IA (Universidad de Palermo). La evaluación sobre LFW está en [`docs/eval/`](docs/eval): reporte, distribuciones, curva DET, error vs. umbral, ablación y latencias.

Resultados principales sobre LFW (partición por identidad, τ derivado en validación para FPIR = 1 % y congelado antes de prueba):

| Galería | τ_alta | FPIR | FNIR | Rango 1 | Abstención |
|---|---|---|---|---|---|
| N = 10 | 0,269 | 0,89 % | 2,63 % | 97,4 % | 13,1 % |
| N = 25 | 0,354 | 0,09 % | 3,37 % | 96,6 % | 1,8 % |
| N = 50 | 0,384 | 0,11 % | 2,87 % | 97,7 % | 0,7 % |

- **Ablación:** sin alineación, el FNIR con N = 50 sube de 2,9 % a 14,9 %. Sin preprocesamiento no cambia de forma significativa en LFW (3,5 %).
- **Errores de rango 1:** los 4 que hay con N = 50 quedan por debajo de τ_baja; ninguno habría nombrado a otra persona.
- **Latencia por cuadro de 1280×720 en un Apple M4:** 23 ms (p50) y 33 ms (p95) en Python; 49 ms y 54 ms en el navegador con WebAssembly de 4 hilos. El aviso llega a ≈ 1,5 s por la permanencia mínima, que es deliberada.
- **Tráfico:** la prueba e2e (`make e2e`) verifica que la app no hace ninguna solicitud a otros orígenes.

Todas las personas de `assets/faces/`, que usan los demos y los bancos de latencia, son **rostros sintéticos generados con IA**. La foto de `core/tests/data/group.jpg` es la imagen de muestra de InsightFace y sólo se usa en los tests.

## Inicio rápido

Requisitos: Node ≥ 20.19 (ver `.nvmrc`), [uv](https://docs.astral.sh/uv/) y, para las pruebas e2e, Google Chrome. Primero instalá todo (entorno Python, dependencias web y modelos):

```bash
make setup
```

Después levantá el demo:

```bash
make dev
```

Queda en http://localhost:5173.

| Tarea | Qué hace |
|---|---|
| `make` | Lista todas las tareas |
| `make doctor` | Verifica herramientas y modelos |
| `make dev` / `make dev-phone` | Demo web en local / por HTTPS para abrir desde el celular |
| `make live` | Banco de pruebas Python con la webcam (`ARGS="--listen"` para la voz) |
| `make enroll NAME=Marta REL="tu hija"` | Alta desde Python |
| `make test` · `make e2e` · `make check` | Tests unitarios · e2e con cámara y micrófono falsos · todo antes de un commit |
| `make eval` | Evaluación FPIR/FNIR sobre LFW y gráficos en `docs/eval/` (umbral, DET y distribuciones) |
| `make android` | Abre la app en Android Studio |
| `make clean` / `make distclean` | Limpia builds / deja el repo como recién clonado |

Modelos: `buffalo_sc` de InsightFace, que incluye RetinaFace-500MF (detección + 5 puntos) y MobileFaceNet/ArcFace (embedding de 512-d), unos 16 MB. Para la escucha por voz del demo web se suma Whisper base en ONNX cuantizado, unos 77 MB.

```bash
scripts/download_models.sh
```

---

## Demo web (webcam)

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

**En el teléfono.** La cámara exige HTTPS, así que corré esto en la misma red Wi-Fi que el teléfono:

```bash
npm run dev:phone    # https://<ip-de-tu-mac>:5173 (certificado autofirmado: aceptalo una vez)
```

En *Privacidad → Cámara* elegí **Trasera**. Con el teléfono a la altura de los ojos, reemplaza a las gafas: es el plan alternativo mientras no haya acceso a las gafas reales.

**Qué se puede hacer:**
- *Invitar a alguien al círculo*: sigue la secuencia invitación → consentimiento granular → captura guiada de 5 tomas con control de nitidez y pose → ficha.
- *Vista del portador*: recuadro, 5 puntos, similitud, confirmación 3 de 4 y la frase al oído por la voz local del sistema.
- *Cambio de persona*: si otra cara reemplaza a la ya anunciada, se abre un encuentro nuevo. Se detecta cuando el embedding se aleja del rostro anunciado (coseno < 0,45 en 3 cuadros seguidos). Con *Avisar al cambiar de persona* activo, dice quién es sin que preguntes.
- *Desconocidos*: «No es nadie conocido. Podés invitarlo a sumarse al círculo.». Tiene su propio toggle; cuando preguntás, contesta siempre.
- *«¿Quién es?»* por botón, barra espaciadora o **voz**. Con *Escuchar «¿quién es?»* activo, un detector de voz recorta lo que decís y **Whisper lo transcribe en el navegador**; el audio no sale del dispositivo. Si no hay nadie, responde «No veo a nadie frente a vos.».
- *Historial* de 7 días sin imágenes, con reporte de errores. El descarte anónimo de no enrolados sólo suma a un contador.
- *Privacidad y umbral*: modo privacidad, umbral τ con la banda de abstención visible, FPIR/FNIR estimados (cargando el `eval_report.json` de `core`), exportar auditoría, borrar plantillas y un contador de conexiones salientes.
- La galería se cifra con AES-GCM, con una clave WebCrypto **no extraíble** guardada en IndexedDB. Nunca se guarda una imagen.

**Pruebas:**

```bash
npm test
```

Para la prueba e2e, con `npm run dev` corriendo:

```bash
../.venv/bin/python e2e/make_fixtures.py
```

```bash
npm run e2e
```

## Banco de pruebas en Python (`core/`)

```bash
uv venv -p 3.11 .venv
```

```bash
uv pip install -p .venv -e "core[dev]"
```

```bash
cd core && ../.venv/bin/pytest
```

```bash
../.venv/bin/mnemo enroll --name Marta --relation "tu hija"
```

```bash
../.venv/bin/mnemo live
```

`mnemo live --source` también acepta la URL de una IP-cam del teléfono, o `glasses` para el puente desde la app Android.

**Evaluación.** El conjunto va en carpetas `data/<persona>/*.jpg`. La partición se hace por identidad. El umbral se deriva en validación para el FPIR objetivo y se congela antes de evaluar en prueba. Se barre N = 10, 25 y 50:

```bash
../.venv/bin/mnemo-eval data/ --target-fpir 0.01 --out eval_report.json
```

Opciones de `mnemo-eval`:
- `--dump-scores` guarda las similitudes de genuinas e impostoras, que usa `scripts/plot_scores.py`.
- `--no-align` y `--no-enhance` sirven para la ablación.
- `--band` cambia el ancho de la banda de abstención (0,08 por defecto).

Estos son los análisis de la evaluación; todos escriben en `docs/eval/`:

```bash
.venv/bin/python scripts/ablacion.py           # ablación de alineación/preprocesamiento y ancho de banda
```

```bash
.venv/bin/python scripts/bench_latency.py      # latencia por etapa (CPU) y búsqueda vs. tamaño de galería
```

```bash
cd web && node e2e/bench.mjs                   # latencia en el navegador (WASM, con y sin COOP/COEP) y de Whisper
```

`make data-lfw` baja LFW desde el mirror de figshare, que redirige a S3 con una firma de pocos segundos. Si la red es lenta, el archivo puede quedar con cuerpos de error intercalados. Verificá con `gzip -t data/.cache/lfw.tgz`; el MD5 correcto es `a17d05bd522c52d84eca14327a23d494`.

## App Android (`android/`)

Abrila con Android Studio (JDK 17, SDK 36). Los modelos se copian solos desde `../models`.

- `capture/CaptureSource.kt` es la interfaz abstracta. `PhoneCameraSource` usa CameraX. `GlassesCameraSource` usa `Wearables.createSession`, luego `addCamera(StreamConfiguration(compressVideo = false))` y luego `videoStream`, y convierte I420 a Bitmap.
- *Gafas simuladas* usa el MockDeviceKit del SDK con la cámara del teléfono: prueba toda la ruta del DAT sin hardware.
- Para usar las gafas reales:
  1. Activá Developer Mode en la app Meta AI.
  2. Tocá *Registrar gafas*.
  3. Concedé la cámara de las gafas cuando Meta AI lo pida.
  4. Si hace falta, cargá `mwdat_application_id` y `mwdat_client_token` en `local.properties`.
- La frase sale con el TTS local del sistema. Las gafas son una salida de audio Bluetooth y el SDK no expone una API de altavoz.

---

## ⚠️ Antes de usar las gafas reales: política de Meta

La [Acceptable Use Policy de Meta Wearables](https://wearables.developer.meta.com/acceptable-use-policy) **prohíbe** usar los sensores de las gafas para identificar personas por su rostro o su voz. La única excepción son las apps de accesibilidad **con aprobación previa de Meta**. También prohíbe tapar el LED de captura. MNEMO entra en esa excepción por diseño (accesibilidad, galería cerrada y consentida), pero **hay que pedir la aprobación** antes de probarlo con las Ray-Ban. Mientras tanto, las métricas se obtienen con la cámara del teléfono, que es el plan previsto para este riesgo.

## Limitaciones conocidas

- **Android no se compiló en esta máquina**: no hay JDK y el SDK local es el 33, mientras que el DAT 1.0 requiere compileSdk 36. El código sigue la API del sample oficial `CameraAccess` 1.0.0. Hay que confirmar el formato del buffer en hardware real, porque el SDK documenta «YUV» sin especificar el layout.
- **El DAT pide el permiso `INTERNET`** para coordinarse con la app Meta AI. El pipeline de MNEMO no abre conexiones, pero la afirmación «0 tráfico saliente» hay que verificarla con una captura de red y documentar el tráfico propio del SDK.
- **Preprocesamiento web más liviano**: el navegador aplica corrección gamma, pero no CLAHE ni el filtro bilateral que sí aplica `core`.
  - Los umbrales se calibran con `core`. La paridad, medida sobre los mismos recortes, es ≥ 0,995 de coseno, pero esa medición no forma parte de las suites automáticas.
  - En los casos límite la diferencia de preprocesamiento cruza el umbral. Con barbijo y anteojos de sol, Marta da 0,336 en `core` (se abstiene) y 0,386 en la web (la nombra).
  - Falta portar CLAHE a la web o derivar un τ propio para ella.
- **Calibración en círculos chicos**: con 1–2 personas la app usa la curva de N = 10 del reporte, que es casi plana entre Rápido y Prudente, así que la estimación de errores no cambia entre niveles. Para el demo se cargó la curva de N = 50.
- **Barra de pestañas del celular**: la topbar mide 60,6 px y `web/src/style.css` asume 57 px, así que la barra inferior queda unos 3,6 px cortada en un viewport de 390×844.
- **«¿Quién es?» por voz**: no se usa el reconocimiento de voz de Chrome, porque envía el audio a Google y rompería la regla de que nada sale del dispositivo. Cada plataforma usa reconocimiento local:
  - Web: Whisper base con transformers.js.
  - `core`: faster-whisper (`uv pip install -e "core[voice]"`, luego `mnemo live --listen`).
  - Android: `SpeechRecognizer.createOnDeviceSpeechRecognizer`. Usa el micrófono del teléfono; para usar el de las gafas está `mwdat-speech`, experimental en el DAT 1.0.

  Whisper a veces entiende «¿Qué es?» en lugar de «¿Quién es?»: esa variante se acepta sólo como frase completa.
- **Cambio de persona y «una frase por encuentro»**: la regla se mantiene, pero ahora un encuentro también termina cuando cambia la cara. El umbral de cambio (0,45) está fijado a ojo y conviene calibrarlo con el conjunto propio.
- **Invitación por QR**: en el demo, el alta ocurre en el mismo navegador y el QR es ilustrativo. En la app real el token viaja al teléfono del invitado.
- **iOS**: no implementado. El DAT tiene SDK Swift equivalente (`meta-wearables-dat-ios`).
- **Licencia de los pesos**: los modelos de InsightFace son sólo para investigación no comercial. Por eso no se versionan: se descargan con el script.

## Licencias

- **Código:** MIT, ver [`LICENSE`](LICENSE).
- **Modelos:** los pesos no se versionan ni se redistribuyen en este repositorio. `make models` (o `scripts/download_models.sh`) los baja de su origen y cada uno conserva su propia licencia:
  - **InsightFace `buffalo_sc`**: detector SCRFD-500MF (`det_500m.onnx`) y reconocedor MobileFaceNet entrenado con ArcFace sobre WebFace600K (`w600k_mbf.onnx`), del release v0.7 de [`deepinsight/insightface`](https://github.com/deepinsight/insightface). El código de InsightFace es MIT, pero **los modelos son sólo para investigación no comercial**: así lo indica su README, tanto para la descarga manual como para la automática. Para cualquier uso comercial hay que consultar a sus autores.
  - **Whisper base** (escucha por voz): OpenAI publica el código y los pesos de Whisper bajo licencia MIT (la ficha de `openai/whisper-base` en Hugging Face declara Apache-2.0).
    - El demo web usa la conversión a ONNX cuantizado [`onnx-community/whisper-base`](https://huggingface.co/onnx-community/whisper-base), derivada de `openai/whisper-base`. Su ficha no declara una licencia propia.
    - `core` usa `faster-whisper`, que en la primera ejecución baja `Systran/faster-whisper-base` a la caché de Hugging Face. Su ficha declara MIT.
- **LFW:** se usa sólo para evaluar (`make data-lfw` lo baja a `data/`, que no se versiona) y no se redistribuye. En `docs/eval/` quedan únicamente métricas y gráficos agregados.
- **Rostros sintéticos:** los de `assets/faces/` están generados con IA.
- **Foto de prueba:** `core/tests/data/group.jpg` es `t1.jpg`, la imagen de muestra que trae el paquete `insightface` (repositorio con licencia MIT). Se usa sólo en los tests.
