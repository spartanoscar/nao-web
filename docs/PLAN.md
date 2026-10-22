# Plan de trabajo — NAO Web: un mundo interactivo con IA

> Proyecto de grado · Fundación Universitaria Los Libertadores · uso **gratuito y académico**
> (las licencias de las mallas oficiales y de los datos de SoftBank no permiten uso comercial).

## Visión

Un NAO V6 virtual, con física real y la API original de NAOqi, que **conversa en tiempo real** con una
persona que lo controla desde su teléfono, **ve** (sus dos cámaras y la del teléfono), **recuerda** a cada
usuario y lo que aprendió del mundo, y **completa tareas** en un entorno 3D.

```
— Oye NAO, ¿qué es esto?                (cámara del teléfono)
— Eso es una manzana, la tienes en tu mano.
— Oye NAO, ¿puedes ir al baño?
— No sé dónde queda. ¿Me guías o quieres que investigue?
— Investiga.
  (mira a su alrededor con sus cámaras; si no ve nada, explora sin chocar; cuando ve el letrero o el
   baño, camina hasta allá)
— Listo, estoy en el baño.               (guarda "baño" = coordenadas en el mapa del usuario)
  … al día siguiente, desde otro equipo, con la misma cuenta …
— Oye NAO, ve al baño.
— Ok, enseguida.                          (va directo: lo recuerda)
```

## Estado actual (2026-10-21)

Hecho y en producción en https://nao.bukivo.com:
- Gemelo digital NAO V6: 25 actuadores, límites oficiales, URDF oficial.
- API NAOqi 2.8: ALMotion (articulaciones, stiffness, wakeUp/rest, moveToward…) y ALRobotPosture (8 posturas).
- Física MuJoCo con masas, inercias y motores oficiales; posturas por grafo validado; marcha continua.
- Caminar con el teclado; mallas oficiales (con licencia y atribución), colores de carcasa y logo de la U.

## Arquitectura objetivo

```
 TELÉFONO (control.html, por QR)          SERVIDOR (Go, como hv/server/ask)          ESCRITORIO (el mundo)
 ─────────────────────────────           ──────────────────────────────────          ─────────────────────
 micrófono ─┐                             sala por QR (relay WebSocket)               mundo 3D + física
 cámara ────┼──── WebSocket ────────────► sesiones y cuotas por usuario ◄──────────► NAO (NAOqi + MuJoCo)
 texto/push ┘                             tokens efímeros de Gemini                    cámaras del NAO
 transcripción ◄──────────────────────── BD: usuarios, memoria, mapas, rostros        transcripción en pantalla
                                          BD vectorial (documentos)                    voz (TTS en el navegador)
                                                    │
                                              Gemini Live (audio + imágenes + herramientas)
```

Regla de oro (ya vigente): **la IA mueve al robot con la misma API NAOqi** que un script humano
(*function calling* → `ALMotion.moveToward`, `ALRobotPosture.goToPosture`, `ALTextToSpeech.say`…).

## Fases

Cada fase se cierra con commits por área, prueba medida y deploy, como hasta ahora.

### F4 — Consola de comandos NAOqi (JS y Python)
- Consola dentro del panel oculto. Python con Pyodide y módulos `naoqi` (`ALProxy`) y `qi` (`Session`).
- Correr tal cual los ejemplos oficiales de la doc. Es la prueba más fuerte de "la lógica es la del NAO real".
- **Criterio:** los scripts de `reference/naoqi-2.8-api` (almotion_*, alrobotposture) funcionan sin cambios
  o con cambios mínimos de Python 2 → 3, documentados.

### F5 — Pantalla limpia y panel oculto  ✅ (2026-10-21: panel oculto con º/F2, LEDs con ALLeds; falta la transcripción en pantalla)
- Quitar toda la UI visible: solo el mundo 3D, la transcripción en tiempo real y el QR para conectar el teléfono.
- **Panel oculto** con una tecla (propuesta: <kbd>`</kbd> o <kbd>F2</kbd>): colores de carcasa, articulaciones,
  posturas, animaciones, consola, y las **cámaras** (frente, boca y teléfono) en miniatura.
- Transcripción en pantalla: lo que dice la persona y lo que dice el NAO, con colores distintos.

### F6 — Las cámaras del NAO
- Dos cámaras virtuales renderizadas desde `CameraTop_frame` (frente) y `CameraBottom_frame` (boca) del URDF,
  con el campo de visión y la resolución oficiales de NAO V6 (doc `alvideodevice`).
- `ALVideoDevice` (subscribeCamera / getImageRemote) devuelve esas imágenes: la IA y los scripts ven lo mismo.
- Render a demanda (solo cuando alguien pide un frame), para no repetir el problema de la GPU.

### F7 — Teléfono por QR
- Reutilizar el patrón de `hv.bukivo.com`: QR en el escritorio → `control.html` en el teléfono → sala por
  WebSocket en el servidor Go (`/api/ws`).
- El teléfono envía audio del micrófono, frames de su cámara y texto; recibe la transcripción y el estado.
- Controles táctiles de respaldo (joystick) para cuando no se quiere hablar.

### F8 — Voz y conversación en tiempo real
- **Escucha:** Gemini Live con audio de entrada y transcripción de entrada y salida.
- **Respuesta:** Gemini devuelve texto + llamadas a herramientas; la **voz la genera el navegador** con
  Kokoro-82M (`kokoro-js`, WebGPU/WASM): rápido, sin costo por audio de salida, y se puede ajustar a un tono
  infantil como el del NAO (voz en español + subir el tono con WebAudio). Verificar voces en español con
  `tts.list_voices()`.
- `ALTextToSpeech.say` y `ALAnimatedSpeech` (gestos sincronizados con el habla, módulo real de NAOqi).
- **Voz "estilo NAO":** la voz original no se puede usar (motor comercial de Nuance, antes Acapela, licenciado por
  robot y nativo del robot). Pero la doc de `ALTextToSpeech` dice que la voz oficial de cada idioma se define con
  parámetros sobre la voz base: `pitchShift` (1–4), `doubleVoice` (1–4), `doubleVoiceLevel` (0–4),
  `doubleVoiceTimeShift` (0–0.5 s), `speed` (50–400). Se implementan de verdad en WebAudio sobre la voz base
  (Kokoro o la del sistema) con `setParameter`/`getParameter`, y se ajustan de oído comparando con videos del NAO.
- Palabra de activación "Oye NAO" o pulsar para hablar en el teléfono (reduce costo y falsos disparos).
- Interrumpir al robot hablándole (barge-in).
- Respaldo sin cuota: Web Speech API del navegador.

### F9 — Control de costos (antes de abrirlo a más gente)
- Imágenes **solo cuando aportan**: al preguntar "¿qué es esto?", o como máximo ~1 cada 2–5 s mientras explora.
  Reducidas (~512 px, JPEG), y sin enviar si la escena no cambió (hash perceptual).
- Cuotas diarias por usuario aplicadas **en el servidor** (tokens efímeros, nunca la API key en el navegador).
  Base reutilizable de Rondax: créditos de IA con límite por usuario (`ai_user_limits`, −1 = ilimitado) y
  registro de consumo real (`ai_usage_log`) en `portal/backend-go/internal/aicredits/`.
- Estimación a verificar con los precios vigentes (Gemini Live 2026, referencias abajo): audio de entrada
  ≈ US$0.005/min, imágenes ≈ US$1 por millón de tokens, texto de salida ≈ US$4.5 por millón. Con voz local
  (Kokoro) y una imagen cada 5 s, **10 minutos de conversación ≈ menos de US$0.10**.
- Panel de consumo por usuario (para el informe del proyecto).

### F10 — Cuentas, sesiones y memoria
- Login (reutilizar la autenticación de Bukivo o Google Sign-In; Rondax usa JWT por usuario con
  protección anti fuerza bruta en `portal/backend-go/v1/internal/middleware/`).
- Por usuario en BD: nombre, nombre que le puso al robot, últimas 50 conversaciones, consumo del día,
  **estado del mundo** (pose del robot, objetos movidos) y **lugares aprendidos** ("baño" → x, y).
- Al entrar desde otro equipo: el robot aparece donde quedó, sabe tu nombre y te saluda.

### F11 — Reconocer a las personas (opcional, con consentimiento)
- Fotos de rostro desde la cámara del teléfono → embeddings con el mismo stack de Rondax
  (`rondax/face-recognition/`): `@vladmandic/face-api` sobre tfjs-node (SsdMobilenetv1 + FaceLandmark68 +
  FaceRecognitionNet) → vector de **128 floats**; comparación por distancia euclidiana convertida a puntaje
  0–1 (`lib/faceCompare.js`, umbral 0.80, varias fotos por persona).
- Como face-api también corre en el navegador, se puede calcular el embedding **en el teléfono** y enviar
  solo el vector (nunca la foto): mejor para la privacidad.
- ⚠️ La biometría es **dato sensible** según la Ley 1581 de 2012 (Colombia): autorización explícita, finalidad
  clara, opción de borrar, y guardar solo embeddings (no fotos) siempre que se pueda.

### F12 — Conocimiento propio (RAG)
- Reutilizar el stack de Rondax / Noha Chat: **pgvector** en Postgres, embeddings **Gemini
  `gemini-embedding-2` (1536 dims)**, búsqueda híbrida (BM25 + vector + trigramas) y troceo por títulos y en
  piezas de ~700 caracteres con 60 de solapamiento (`rondax/scripts/cli/vectorize-helpdocs.js`,
  `portal/backend-go/internal/gemembed`).
- Diferencia con Noha: allá el RAG genera SQL; aquí recupera fragmentos de documentos y el robot responde con
  base en ellos, citando la fuente.
- Caso de uso fuerte para estudiantes: "NAO tutor" de una asignatura, que explica con gestos.

### F13 — Mundo interactivo y tareas
- **Entorno:** un apartamento o piso de la universidad con habitaciones, puertas, baño con letrero y objetos.
- **Percepción:** Gemini con las imágenes de las cámaras del NAO para reconocer objetos y letreros. Los 2
  **sonares** del NAO (`ALSonar`, raycast en la física) sirven para no chocar.
- **Navegación:** mapa de ocupación construido mientras camina, exploración por fronteras, rutas A* y
  evasión de obstáculos, todo sobre `moveTo` / `moveToward`.
- **Memoria de lugares:** al encontrar algo, se guarda en el mapa del usuario (F10). "Aprender" aquí es
  **memoria persistente**, no reentrenar un modelo.
- **Planificador:** Gemini descompone la orden en herramientas: `goTo(lugar)`, `explore(objetivo)`,
  `lookAt(objeto)`, `say(texto)`, `goToPosture(...)`.

### F14 — Sonido  (✅ motores, golpes de plástico y pasos sintetizados desde la física, 2026-10-21)
- **Motores sintetizados en vivo** (WebAudio, sin archivos): un "zumbido de reductora" por cada uno de los 24
  actuadores, alimentado por la física de MuJoCo. Tono ∝ velocidad del rotor (velocidad del joint × reducción de su
  motor, `naoV6.motorOf`), volumen ∝ velocidad y torque (corriente). Así suena como el real según la carga: quieto
  y en reposo, silencio; de pie, un zumbido leve de los motores sosteniendo el peso; al caminar, las piernas al
  ritmo de los pasos. Cada tipo de motor (5 modelos oficiales) con su timbre.
- **Golpes y caídas** desde los contactos de MuJoCo (impulso del contacto → volumen): sonidos CC0.
- **Fuentes de sonidos libres:** freesound.org (filtrar CC0: "servo motor", "impact"), kenney.nl (Sci-Fi e Impact
  Sounds, CC0), generadores sfxr.me (jsfxr) y ChipTone (lo generado es propio), ElevenLabs Sound Effects (IA,
  revisar términos). Si alguna articulación del NAO físico aún se mueve, grabarla con el celular es lo mejor.
- Control de sonido y volumen en el panel oculto.

### Física pendiente (en paralelo)
- Levantarse boca arriba o desde sentado (darse vuelta y luego `StandUpFromFront`).
- *Fall manager* documentado: protegerse con los brazos y apagar motores al caer.
- Equilibrio al levantar un pie; marcha omnidireccional propia (mezclar avanzar y girar, más rápida).

### F15 — Diseño propio
- Modelo de Meshy en pose A + script de despiece por planos en las articulaciones; selector "oficial / propio".

## Ideas adicionales para considerar

1. **Ojos que comunican estado** (`ALLeds` ya implementado, como el NAO real): azul = escuchando, amarillo girando =
   pensando, blanco = hablando, rojo = sin cuota o error.
2. **Sensores táctiles de la cabeza** (3 en el NAO): tocarle la cabeza para despertarlo o callarlo; en el
   teléfono, un botón "tocar cabeza". Con eventos de `ALMemory`, como en el robot.
3. **Modo profesor:** a partir de los documentos de F12, el robot da una mini clase con gestos
   (`ALAnimatedSpeech`) y hace preguntas de repaso.
4. **Varios teléfonos en la misma sala:** el robot distingue quién habla (por rostro o por teléfono).
5. **Grabar y reproducir sesiones** (comandos + estado) para la demo del proyecto y para depurar.
6. **El robot escribe sus propios scripts NAOqi** (en la consola de F4, con lista blanca): una demostración
   potente de que usa la API real.
7. **Métricas para el informe:** latencia voz → respuesta, tasa de éxito de tareas ("ir al baño"), costo por
   sesión, caídas por hora de marcha. Con el banco de pruebas de física como base.
8. **Accesibilidad:** subtítulos siempre (ya vienen de la transcripción) y control completo por teclado.

## Referencias
- Patrón QR + WebSocket: `../hv` (`src/remote.js`, `control.html`, `server/ask/`).
- Rostros, RAG y cuotas: `../rondax` (`face-recognition/`, `claude/CLAUDE.chat.md`, `claude/CLAUDE.ai-lab.md`,
  `portal/backend-go/internal/aicredits/`).
- Precios Gemini Live (verificar antes de presupuestar): https://ai.google.dev/gemini-api/docs/pricing
- Kokoro TTS en el navegador: https://www.npmjs.com/package/kokoro-js
