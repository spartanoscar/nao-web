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
- **Hecho (2026-10-22):** las dos cámaras (frames ópticos del URDF, 56.3°×43.7°), vista de depuración y
  `ALVideoDevice` completo salvo `putImage`/`getExpectedImageParameters`. Ver CLAUDE.md "Cámaras del NAO".
  Pendiente: llevar las imágenes a Gemini (F8) y la cámara del teléfono (F7).

### F7 — Teléfono por QR
- Reutilizar el patrón de `hv.bukivo.com`: QR en el escritorio → `control.html` en el teléfono → sala por
  WebSocket en el servidor Go (`/api/ws`).
- El teléfono envía audio del micrófono, frames de su cámara y texto; recibe la transcripción y el estado.
- Controles táctiles de respaldo (joystick) para cuando no se quiere hablar.
- **Hecho (2026-10-22):** sala creada por el servidor para el usuario logueado, QR, `control.html` con la vista del
  NAO en vivo, inclinación para mover la vista del mundo y permisos de micrófono/cámara. Pendiente: enviar audio y
  video del teléfono a la IA (F8).

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
- **Hecho (2026-10-22):** `ALTextToSpeech` + Kokoro en español (G2P propio, voces ef_dora/em_alex/em_santa),
  WebGPU fp32 con respaldo WASM q8, pitchShift/doubleVoice implementados, primer sonido en ~0.5–0.8 s. Ver CLAUDE.md
  "Voz". Pendiente: `ALAnimatedSpeech`, ajustar los parámetros de oído contra videos del NAO, `speed` dentro de
  `\rspd=…\` y demás etiquetas de texto de la doc.
- **Hecho (2026-10-22): cerebro por turnos** (no Gemini Live, para conservar la voz del NAO y pagar solo al hablarle):
  subtítulo final o chat → `POST /api/brain` → `gemini-3.8-flash` con function calling → dice y encadena habilidades de
  alto nivel hechas con NAOqi (walk/turn/go_to = `moveTo`, approach por la caja de Gemini proyectada al suelo, push,
  posturas, gestos, animaciones, LEDs, look, scan), revisando cada resultado. Últimos 20 mensajes, foto combinada de las
  dos cámaras en cada turno, estado compacto. Ver CLAUDE.md "Cerebro del NAO". Siguen: vida autónoma local (con
  `quieto_seg`: aburrirse, sentarse, bostezar), memoria espacial de objetos (`places`), rostros, biblioteca.
- Palabra de activación: **hecho** por nombre ("NAO" o el nombre que le puso su dueño) + 20 s de conversación abierta.
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
- **Hecho (2026-10-22):** BD `nao` (PostgreSQL 12 + pgvector) con usuarios, sesiones, control de costos,
  conversaciones, rostros, memoria del mundo y RAG (estructura); login con contraseña bcrypt y cookie de sesión;
  usuarios Oscar y Nelson con tope de US$2/día. Ver CLAUDE.md "Servidor, base de datos y login".

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
- **Hecho (2026-10-22, en local, sin desplegar):** biblioteca por usuario en el modal de ajustes (imágenes, PDF, Word,
  Excel, CSV, texto; ≤ 4 MB), lectura barata primero, `gemini-embedding-2` 1536 dims, trabajador con estados y cobro
  de tokens. Falta la búsqueda cuando converse la IA.

### F13 — Mundo interactivo y tareas
- **Mundos (decidido con Oscar, 2026-10-23): dos, y cada elemento pone a prueba un módulo real de NAOqi o un experimento
  medible que se pueda repetir con un NAO físico.**
  1. **Laboratorio** (la casa del NAO, mundo de defecto; un aula como la de la universidad):
     - **Espejo** → *prueba del espejo* (Gallup, 1970) adaptada: el NAO cambia el color de sus ojos (ALLeds), se mira y
       comprueba si el reflejo cambió; o mueve un brazo y ve si "el otro" lo imita. En el mundo compartido (F16),
       distinguir "soy yo" de "es otro NAO" por el color y por el movimiento. El espejo se ve también en sus cámaras.
       ✅ Hecho (2026-10-23, `scripts/bench/mirror.js`): sin método 1 de 8 se reconoce (sin comprobar), con método
       (comprobar por contingencia, sin decir que hay espejo) 4 de 4 se mueven, miran y se reconocen. Pendiente: la
       variante del mundo compartido (otro NAO real del mismo color) y la "prueba de la marca" con los LEDs.
     - Pelota roja → `ALRedBallDetection` · NAOmarks oficiales en las paredes → `ALLandMarkDetection` · carteles con
       rostros → `ALFaceDetection` (F11) · mesa baja con objetos cotidianos (tráeme, señálame, ¿qué hay?) · dos pisos
       (baldosa y alfombra, fricción distinta: marcha medida) · base de carga (volver a casa).
  2. **Patio de retos** (exterior, lo que no se arriesga con un robot real): zonas de pasto, arena y gravilla (APPROX:
     material con fricción y suelo blando; MuJoCo no simula granos); charco o estanque como **peligro** (el NAO real no
     es resistente al agua: la IA debe reconocerlo y evitarlo; sin fluidos, zona + efecto visual; el agua quieta refleja
     como el espejo); rampa suave y escalón pequeño (límites de la marcha); obstáculos para la navegación.
  - **Modelos 3D (Meshy, 1200 créditos ≈ 12 de alta o ~30 de baja calidad):** solo lo orgánico o complejo que la IA debe
    reconocer por la cámara. Baja calidad para la mayoría (la cámara del NAO trabaja a 320×240: variedad > detalle):
    planta, peluche, taza, mochila, zapato, libro, frutas, carro de juguete, silla, maceta, banco de parque, regadera;
    alta calidad solo 2–3 piezas protagonistas (base de carga, planta grande). Lo demás es nuestro (espejo, agua,
    terrenos, paredes, mesas, cajas, rampas, pelota, NAOmarks, carteles). Colisión = envolvente convexa, como el NAO.
    Revisar la licencia de Meshy según el plan y anotarla (como las mallas de Aldebaran).
  - Orden: espejo en el mundo actual → laboratorio → objetos de Meshy → patio.
  - **Forma del mundo 1 (decidido con Oscar, 2026-10-23): pasillo con cuartos separados**, cada uno un experimento y un
    punto de aparición, para que los NAO del mundo compartido no se vean todos entre todos (F16: solo se sincronizan los
    del mismo cuarto). Casa (aparece ahí), Cuarto del espejo, Laboratorio, Baño (tapetes, azulejo resbaloso, charco como
    peligro), Sala de pruebas (rampa, escalones de 1–4 cm, escalera) y el pasillo (letreros + NAOmarks: "ve al
    laboratorio"). ✅ Paso 1–2 (2026-10-23): pasillo, 5 cuartos, letreros, capas por cuarto, aparecer en cualquiera;
    espejo y objetos en su cuarto. Faltan: baño y sala de pruebas con sus fricciones y escalones, NAOmarks, objetos de
    Meshy, base de carga.
  - **Reto de la escalera** (idea de Oscar): con la marcha estándar el NAO real no sube escaleras de una casa. Si no se
    logra enseñarle, los estudiantes con acceso al código buscan su patrón (grabador, modo animador o laboratorio) y
    exportan su rutina (JSON con autor); un banco la evalúa igual para todos en la física aparte del laboratorio (sube o
    no, tiempo, energía = ∫ τ·ω de los motores, inclinación máxima, caídas) → ranking, y la comparación entre muchas
    soluciones es un resultado de la tesis.
- **Entorno (idea original):** un apartamento o piso de la universidad con habitaciones, puertas, baño con letrero y objetos.
- **Percepción:** Gemini con las imágenes de las cámaras del NAO para reconocer objetos y letreros. Los 2
  **sonares** del NAO (`ALSonar`, raycast en la física) sirven para no chocar.
- **Navegación:** mapa de ocupación construido mientras camina, exploración por fronteras, rutas A* y
  evasión de obstáculos, todo sobre `moveTo` / `moveToward`.
- **Memoria de lugares:** al encontrar algo, se guarda en el mapa del usuario (F10). "Aprender" aquí es
  **memoria persistente**, no reentrenar un modelo.
- **Planificador:** Gemini descompone la orden en herramientas: `goTo(lugar)`, `explore(objetivo)`,
  `lookAt(objeto)`, `say(texto)`, `goToPosture(...)`.

### F16 — Mundo compartido (varios NAO en la misma sala)
Decidido con Oscar (2026-10-22). ✅ Fase 1 (2026-10-24, ver CLAUDE.md "Mundo compartido"): verse y chocar, 8 cápsulas de
salida estilo Halo en la sala de pruebas (la primera libre por persona, hasta 6; dos con un NAO quieto), presencia y pases en nao-api, sala en un Durable
Object (en producción en nao-world.nao-world.workers.dev) y plan B en nao-api. Faltan: objetos compartidos, voz entre
personas y sincronizar por cuarto.
- **Modelo "cada uno simula su NAO"** (como Meccha Chameleon con Epic Online Services: el proveedor solo conecta,
  la simulación corre en los equipos): cada navegador corre la física de su robot y comparte su estado (posición del
  torso, 25 articulaciones, LEDs ≈ 30 números) a 12–15 Hz; los NAO de los demás se dibujan con ese estado, suavizado,
  con el nombre del dueño encima. El anfitrión (Oscar en la presentación) simula los objetos compartidos (cubos).
- **Relay en Cloudflare Durable Objects** (cuenta de Bukivo, la del mismo servidor; plan gratis = objetos con SQLite,
  sin usar su almacenamiento): la sala vive cerca del primero que entra (Miami para Colombia, ~40–90 ms entre
  personas) en vez de Francia (~200 ms medidos). API de hibernación de WebSocket para no pagar duración.
- **Solo se conecta con 2 o más personas:** la presencia la lleva `nao-api` (gratis); a solas no sale ni un mensaje
  hacia Cloudflare; al quedar solo, se desconecta tras 30 s. Robot quieto = cero mensajes.
- Cupo gratis por cuenta: 100 000 solicitudes/día (los mensajes entrantes cuentan 20:1) → ~18 000 por hora con 5 NAO;
  se reinicia a las 00:00 UTC (7 pm Colombia). Verificar antes el plan y el uso de Workers de la cuenta de Bukivo.
- Login: `nao-api` entrega un pase firmado de pocos minutos; el Worker solo verifica la firma.
- Voz entre personas: lo que cada uno dice al teléfono → transcripción (ya existe) → texto a todos → el NAO de esa
  persona lo dice con su voz (Kokoro, local). Sin WebRTC.
- Plan B: la misma sala por el relay de `nao-api` (mismo protocolo, cambia la URL).

### F17 — Laboratorio de movimientos (búsqueda automática de movimientos equilibrados)
Propuesta para el proyecto de grado (2026-10-23): un sistema que **encuentra solo** movimientos controlados para una
tarea, manteniendo el equilibrio con física real, y que se ejecutan con la API de NAOqi (corren igual en un NAO físico).
- **Método:** optimización de trayectorias con CMA-ES separable (`src/lab/cmaes.ts`, validado en esfera, elipsoide y
  Rosenbrock). Un movimiento = K poses clave (17 articulaciones cada una, brazos para apoyarse y piernas completas,
  asimétrico) + duraciones; la pose final es la postura objetivo. Cada candidato se reproduce con
  `ALMotion.angleInterpolation` en una física MuJoCo aparte (`src/lab/labSim.ts`, la misma del mundo, sin dibujar,
  ~14× tiempo real) desde una foto exacta del estado (posiciones, velocidades, arranque del solver y una sesión de
  NAOqi nueva): el mismo movimiento da siempre el mismo costo (verificado al cuarto decimal).
- **Puntaje** (`src/lab/tasks.ts`): llegar a la postura (familia de NAOqi e inclinación del torso), no caerse, sin golpe
  (velocidad máxima de bajada del torso), sin giros bruscos (velocidad angular del torso), duración.
- **Resultado, sentarse (StandInit → Sit):** semilla = el camino actual del grafo, que llega pero "cae sentado"
  (bajada del torso 1.14 m/s, giro 5.1 rad/s). 961 intentos (60 generaciones × 16) en ~8 min: **bajada 0.53 m/s (2.2×
  más suave), giro 2.5 rad/s**, termina en Sit con el torso −35° atrás y 11° de lado. Conectado al grafo como
  StandInit → Sit (`naoqi/taught/SitDownControlled.json`); en el mundo 4 de 4: Sit, bajada 0.40–0.52 m/s.
- **Lección (para el informe):** la primera búsqueda dio 0.30 m/s pero sentándose **ladeado** (−14° atrás, 33° de lado):
  el puntaje solo pedía ~36° de inclinación total y el optimizador la cumplió de costado. Ahora mide atrás y de lado por
  separado. El optimizador hace exactamente lo que se mide: el puntaje es la especificación.
- **Levantarse (Sit → Crouch), primer intento:** 1 281 intentos sin éxito (siempre termina de espaldas; costo 112 → 106).
  Una vez caído, todos los candidatos fallan parecido y no hay pista de hacia dónde mejorar. Próximo: semilla enseñada
  a mano con el modo animador siguiendo el video (51–63 s), puntaje por etapas (primero apoyar la mano y recoger las
  piernas sin caer, luego cuclillas) y penalizar el torso hacia atrás desde el principio.
- **Imitación (2026-10-23):** "Imitar lo grabado" toma las poses del grabador o del modo animador (que se pueden
  grabar sin física, aunque solas no se sostengan) como referencia y semilla. Costo = física (no caerse, sin golpe,
  terminar en la familia de la última pose) + parecido (distancia media en rad a las poses grabadas ×10). Prueba con las
  4 poses del camino viejo para sentarse: 241 intentos (111 s) → bajada 1.14 → 0.54 m/s, sentado derecho; sin referencia
  hicieron falta 961 para lo mismo. Es el camino para levantarse: Oscar graba la referencia del video y el
  laboratorio la vuelve factible.
- **Siguiente:** robustez (variar fricción, masas, empujones), más tareas (agacharse a recoger, patear), seguir una
  búsqueda desde el mejor resultado anterior.
- Interfaz: panel oculto → "Laboratorio de movimientos" (tarea, generaciones, Buscar/Detener, curva del costo, "Ver en
  el robot" carga el mejor en el grabador y lo reproduce).

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

### F18 — Repositorio público y documentación para estudiantes y profesores (fase adicional, al final)
Pedido por Oscar (2026-10-24): el repo se publicará como **público** y la documentación vivirá en el mismo subdominio
(nao.bukivo.com, p. ej. `/docs`). Regla que no cambia: **solo quien tiene una cuenta que nosotros creamos consume algo**
(IA, transcripción, biblioteca, rostros, el mundo compartido); publicar el código no puede abrir nada de eso.
- **Ya cumple (revisado 2026-10-24):** sin registro abierto (`deploy.sh user add`); toda ruta que gasta pide sesión
  (cerebro, biblioteca, rostros, ajustes, salas, pase del mundo) o un pase firmado por nao-api (la sala del mundo en
  Cloudflare y su plan B; origen ajeno 403, pase falso o alterado 401); el teléfono entra solo con el código de 16 bytes
  de la sala de su dueño y lo que gasta se cobra al tope diario del dueño (US$2). Claves solo en `.local/` y en
  `/root/nao/.env` (600), nunca en el bundle. Historial (157 commits): sin claves de Gemini, Cloudflare ni Postgres, sin
  llaves privadas, sin `.env` ni JSON de claves; las únicas IP son los rangos públicos de Cloudflare de nginx.
- **Antes de abrirlo:**
  - Escaneo de secretos de todo el historial con una herramienta dedicada (gitleaks o trufflehog), no solo con grep; si
    algo aparece, rotar la clave (no basta reescribir el historial: ya pudo copiarse).
  - Qué revela la infraestructura: `scripts/deploy.sh` (rutas de `../bukivo`, la llave SSH por nombre, `/root/nao`, PM2,
    puertos), `deploy/nginx/*.conf`, el nombre del Worker y su URL. No son secretos, pero describen el servidor de
    Bukivo: decidir si se publican tal cual, se generalizan (variables de entorno, ejemplo `.env.example`) o se quedan en
    un repo privado de despliegue.
  - Abuso sin cuenta: el Worker de Cloudflare cuenta también las solicitudes rechazadas (plan gratis: 100 000/día; al
    agotarse se detiene, no cobra). Verificar el plan de la cuenta de Bukivo; si es de pago, límite de tasa o regla WAF
    para `/world`. Límite de intentos de login ya existe (8 en 15 min por IP o usuario).
  - Licencias de lo que sí está en el repo: `reference/` (docs de NAOqi 2.8 de Aldebaran, URDF, `.motion` de Webots,
    qiBullet Apache-2.0) — confirmar que se pueden redistribuir o dejar solo los enlaces y un script que los baje, como
    ya se hace con las mallas y el grafo de posturas de Choregraphe (que no están en el repo). Elegir la licencia del
    código propio (p. ej. MIT o Apache-2.0) y un `LICENSE`/`NOTICE` con las de terceros.
  - Datos personales: ni fotos ni huellas de rostros ni conversaciones en el repo (están en la BD); `schema.sql` sí se
    publica (solo estructura). Usuarios y contraseñas de prueba fuera del código.
  - Un `SECURITY.md` con cómo reportar un problema, y que nada del CI/CD tenga permisos de escribir en producción.
- **Documentación pública** (`/docs` en el mismo subdominio, para estudiantes y profesores):
  - Qué es y cómo funciona: arquitectura por capas (física, NAOqi, IA, mundo), con diagramas; lo que es fiel al NAO real
    y lo que es aproximado (las `APPROX` del código, en palabras simples).
  - **Del emulador al NAO real:** la misma API de NAOqi 2.8 (`ALProxy`/`qi.Session`, mismos servicios, métodos y
    unidades): cómo escribir y probar un script aquí (consola JS y Python con Pyodide, F4) y correrlo tal cual en un NAO
    V6 (conexión, `naoqi` de Python 2.7 o `qi` de Python 3, Choregraphe); lo que no existe en el real (habilidades de la
    IA, el mundo compartido) y lo que el real tiene y aquí no.
  - La base de datos (estructura de `schema.sql` comentada), el servidor y sus rutas, y cómo levantar todo en local.
  - Guías por tarea (moverse, posturas, cámaras, LEDs, voz, prueba del espejo, reto de la escalera) y referencia de la API
    implementada (generada desde los comentarios con enlace a la doc oficial).

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
