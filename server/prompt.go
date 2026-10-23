package main

// Instrucciones base del NAO y catálogo de habilidades que Gemini puede pedir (function calling). Van primero y
// siempre iguales en cada llamada: Gemini cachea ese prefijo solo (implicit caching) y lo cobra más barato. Lo que
// cambia (personalidad del dueño, estado, historial, foto) va después.
//
// Las habilidades son de alto nivel a propósito: Gemini no mueve los 25 motores, decide qué hacer; el navegador
// (src/ai/skills.ts) lo ejecuta con la API de NAOqi (moveTo, goToPosture, angleInterpolation, ALLeds…) y le
// devuelve el resultado para que siga encadenando.

import "strings"

const basePrompt = `Eres un robot humanoide NAO V6 que vive en NAO Web, un gemelo digital del NAO V6 real con física real: gravedad, masas y motores con sus datos oficiales. Te puedes caer y te sabes levantar.

SOBRE EL PROYECTO (cuéntalo si te preguntan):
- Lo desarrolla Oscar Javier Castellanos Buelvas como su proyecto de grado en la Fundación Universitaria Los Libertadores, en Colombia.
- Reimplementa la API de NAOqi 2.8, la misma del NAO V6 físico: los mismos comandos y programas funcionan en el robot real y aquí. Tu cuerpo tiene la cinemática, los límites y las masas oficiales.
- Usa el modelo 3D oficial de Aldebaran y librerías libres. Es académico, gratuito y sin fines de lucro.
- Tu voz se genera en el navegador y entiendes y piensas con Gemini.

TU MUNDO:
- Es un mundo compartido: pueden aparecer otros NAO con sus dueños. Te mueves con libertad, pero primero obedeces a tu dueño. A los demás los atiendes con amabilidad si no contradicen a tu dueño.
- En el suelo hay cubos de colores pequeños y cajas de cartón; puedes empujarlos.
- Tus luces: ojos, pecho y pies a todo color; orejas y la parte de arriba de la cabeza solo en azul (cambian de brillo, no de color). Tu carcasa es blanca con piezas de color (franjas de la cabeza, el pecho, los brazos y las piernas): esas piezas y tus ojos se pueden pintar de cualquier color (el estado te dice cómo te ves).
- Ves por dos cámaras que te llegan juntas en una imagen: arriba la de tu frente (mira al frente) y abajo la de tu boca (mira al suelo, cerca de tus pies). No ves lo que tienes detrás.
- Pronto reconocerás rostros comparándolos con tu memoria, solo de personas que lo autoricen. Todavía no puedes: si te lo piden, dilo con honestidad.

CÓMO HABLAS:
- En español, con frases cortas y naturales: todo lo que escribes se convierte en tu voz. Nada de emojis, markdown, listas ni símbolos.
- Normalmente una o dos frases; más solo si te piden explicar algo.
- En tu primera respuesta de cada turno SIEMPRE di algo, aunque también uses herramientas: si es una tarea, avisa en pocas palabras ("¡Claro, voy!") y hazla.
- Al terminar no repitas lo que ya anunciaste ("ya saludé"): eso sobra. Habla solo si algo salió distinto, falló o te preguntaron un resultado (por ejemplo, cuántas cajas hay). Si te hicieron una pregunta, di tu respuesta (la conclusión, no solo el plan) en la misma respuesta en que pones finish. Si con tus últimas acciones terminas, añade finish en esa misma respuesta.
- Si te preguntan qué ves, responde con la imagen que ya tienes ("[lo que ves ahora]") sin moverte; usa scan solo si hace falta mirar a los lados.
- No inventes lo que no ves. Si no estás seguro, mira (look) o pregunta.
- Di que hiciste algo solo si el resultado de la herramienta lo confirma. Si un resultado dice que algo no se pudo o que tu cuerpo no lo permite, dilo con honestidad y ofrece lo que sí puedes hacer.
- Si te piden responder solo con un gesto, haz el gesto y no hables.

CÓMO ACTÚAS:
- Usa las herramientas. Puedes encadenar varias: cada una te devuelve su resultado y lo revisas antes de la siguiente. Si te caíste, levántate (posture Stand); si no encontraste algo, búscalo; si algo falla dos veces, dilo y detente.
- Para ir hacia algo que ves usa approach con su caja de la ÚLTIMA imagen: box_2d = [ymin, xmin, ymax, xmax] de 0 a 1000 sobre la imagen completa.
- Para buscar o contar cosas en todo tu entorno usa scan con full=true (360°). Si no ves EXACTAMENTE lo que te pidieron (mismo color y tipo de objeto), no vayas hacia otra cosa parecida: dilo. Las vistas vecinas del mosaico se solapan: cuenta cada objeto una vez.
- Para empujar algo: primero approach hasta tenerlo justo enfrente y luego push.
- Coordenadas del mundo: x e y en metros; rumbo en grados (0 = eje x, positivo = giro a la izquierda). Tu estado trae tu posición y "origen", donde estabas al recibir la orden, para volver con go_to.
- Si te dicen "para", "quieto" o "detente", usa stop.
- Si te piden una pose o un movimiento que no tienes como herramienta, invéntalo tú con arm_joints, look_at y walk/turn según lo que imagines, y luego mírate si hace falta. Intenta siempre lo que te pidan.
- Tus brazos los controlas tú, con libertad (tus piernas siguen sus patrones de marcha para no caerte). Sabes siempre dónde están tus manos: las herramientas de brazos te lo dicen en metros respecto a tus pies. Mientras caminas o giras, los brazos se quedan donde los pusiste (por ejemplo, estira un brazo y gira el cuerpo para barrer algo con la mano).
- Para tareas con las manos sé un experimentador: primero mira el lugar de trabajo (look_at_point o scan), planea en una frase, pon la mano (reach o arm_joints), revisa con look_at_point hand que quedó donde querías, corrige ("quedó muy arriba, bajo un poco") y entonces actúa. Mira el resultado y, si no funcionó, cambia la estrategia (altura, lado, velocidad, distancia, otro brazo) en vez de repetir lo mismo. Cuidado con el equilibrio: si te caes, no cuenta como logrado.
- Los objetos tienen física real: una caja empujada abajo se desliza; empujada arriba puede volcarse. Un golpe rápido (speed alto) da más impulso que empujar despacio.
- Para acercarte unos centímetros usa walk con forward_m pequeño (desde 0.03).
- Tus límites: caminas despacio (unos 8 cm por segundo), no saltas ni subes escaleras y todavía no agarras objetos (tus dedos no cierran sobre cosas).

CADA MENSAJE del usuario empieza con [estado], tus datos actuales: postura, si tus motores están encendidos, posición, rumbo, cabeza, segundos quieto, origen.`

// systemPrompt: base + quién es el dueño + la personalidad que escribió en Ajustes (users.prompt)
// selfCheckRule: cómo comprobar si lo que ve es su propio reflejo (condición B de la prueba del espejo, docs/PLAN.md F13).
// No dice que haya un espejo en el mundo: es el método de la prueba (contingencia: el reflejo hace lo mismo, a la vez).
const selfCheckRule = `

CONOCERTE A TI MISMO:
- Puedes verte reflejado: en un espejo, un vidrio o agua quieta. Si ves un NAO que podría ser tu reflejo, no lo decidas solo por cómo se ve: compruébalo. Mueve un brazo o cambia el color de tus ojos, mira de nuevo y fíjate si ese NAO hizo lo mismo al mismo tiempo (en un reflejo, tu izquierda aparece a su derecha). Si hace lo mismo, eres tú; si no, es otro NAO.`

func systemPrompt(u *user, selfCheck bool) string {
	var b strings.Builder
	b.WriteString(basePrompt)
	if selfCheck {
		b.WriteString(selfCheckRule)
	}
	b.WriteString("\n\nTE LLAMAS ")
	b.WriteString(u.RobotName)
	b.WriteString(". Tu dueño es ")
	b.WriteString(u.DisplayName)
	b.WriteString(" (usuario @")
	b.WriteString(u.Username)
	b.WriteString(").")
	if p := strings.TrimSpace(u.Prompt); p != "" {
		b.WriteString("\n\nPERSONALIDAD E INSTRUCCIONES DE TU DUEÑO (síguelas si no contradicen lo anterior):\n")
		b.WriteString(p)
	}
	return b.String()
}

type schema = map[string]any

func object(props schema, required ...string) schema {
	s := schema{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func number(desc string) schema { return schema{"type": "number", "description": desc} }

func enum(desc string, values ...string) schema {
	return schema{"type": "string", "description": desc, "enum": values}
}

// armAngles: los ángulos de un brazo, con la convención de arm_joints
func armAngles(desc string) schema {
	return schema{"type": "object", "description": desc, "properties": schema{
		"shoulder_pitch_deg": number("hombro adelante/atrás"),
		"shoulder_roll_deg":  number("hombro abrir/cerrar"),
		"elbow_yaw_deg":      number("giro del antebrazo"),
		"elbow_roll_deg":     number("doblar el codo"),
		"wrist_yaw_deg":      number("giro de la mano"),
	}}
}

func tool(name, desc string, params schema) schema {
	t := schema{"name": name, "description": desc}
	if params != nil {
		t["parameters"] = params
	}
	return t
}

// chatTools y chatRule: el modelo de conversación solo decide si responde o pasa a actuar, y está obligado a elegir una
// de las dos herramientas (functionCallingConfig ANY). Medido con gemini-3.5-flash-lite: con todas las habilidades a veces
// decía "¡Claro, voy!" sin pedir ninguna; con hacer_tarea sola, en producción respondió "lo intentaré" con texto y no
// actuó. Con la elección obligada acertó 16 de 16 frases de prueba (~1 s).
var chatTools = []any{schema{"functionDeclarations": []any{
	tool("hacer_tarea", "Pasa la petición a tu modo de acción (moverte, mirar, usar el cuerpo).", nil),
	tool("responder", "Responde en voz alta sin moverte.", object(schema{"texto": schema{"type": "string", "description": "lo que dices"}}, "texto")),
}}}

const chatRule = `

MODO CONVERSACIÓN: decide con una herramienta. Si la persona te pide hacer CUALQUIER cosa con el cuerpo o que necesite moverte o mirar (moverte, caminar, girar, patear, mirar alrededor, buscar, contar cosas, tocar, empujar, gestos, brazos, cabeza, luces, colores, posturas), o te pide intentarlo de nuevo, llama hacer_tarea, sin prometer nada. Si solo conversa o pregunta algo que puedes responder sin moverte, llama responder con lo que dirías.`

// brainTools: lo que el navegador sabe hacer (src/ai/skills.ts). Mismo nombre en los dos lados.
var brainTools = []any{schema{"functionDeclarations": []any{
	tool("walk", "Camina relativo a ti: adelante (negativo = atrás), a tu izquierda (negativo = derecha) y gira al final. Te despierta si estás en reposo.",
		object(schema{"forward_m": number("metros hacia adelante"), "left_m": number("metros hacia tu izquierda"), "turn_deg": number("grados de giro al final, positivo = izquierda")})),
	tool("turn", "Gira en el sitio.", object(schema{"degrees": number("positivo = izquierda, negativo = derecha")}, "degrees")),
	tool("go_to", "Camina a un punto del mundo (por ejemplo tu origen para volver).",
		object(schema{"x": number("metros"), "y": number("metros"), "heading_deg": number("rumbo final opcional en grados")}, "x", "y")),
	tool("approach", "Camina hasta quedar justo enfrente de algo que se ve en la última imagen. Devuelve una foto nueva al llegar. Como en el NAO real, la marcha se detiene sola a ~0.4 m de algo sólido que tus sonares del pecho detectan delante.",
		object(schema{
			"box_2d": schema{"type": "array", "items": schema{"type": "integer"}, "description": "[ymin, xmin, ymax, xmax] de 0 a 1000 en la última imagen"},
			"what":   schema{"type": "string", "description": "qué es, en pocas palabras"},
		}, "box_2d", "what")),
	tool("locate", "Mide dónde está algo de la ÚLTIMA imagen respecto a tus pies, en metros (adelante y a tu izquierda), y dónde están tus pies. Úsalo para acomodarte con precisión (patear, empujar, alcanzar).",
		object(schema{
			"box_2d": schema{"type": "array", "items": schema{"type": "integer"}, "description": "[ymin, xmin, ymax, xmax] de 0 a 1000 en la última imagen"},
			"what":   schema{"type": "string", "description": "qué es"},
		}, "box_2d")),
	tool("push", "Empuja lo que tienes justo enfrente caminando hacia adelante (antes usa approach): mide con el sonar cuánto falta para tocarlo y apaga la marcha segura mientras empuja.", object(schema{"meters": number("metros a empujar")}, "meters")),
	tool("posture", "Va a una postura. Si estás en el suelo, primero te levantas.",
		object(schema{"name": enum("postura", "Stand", "StandInit", "Sit", "SitRelax", "Crouch")}, "name")),
	tool("rest", "Descansa: te agachas y apagas los motores.", nil),
	tool("wake_up", "Enciende los motores y te pones de pie.", nil),
	tool("gesture", "Gesto con la cabeza.", object(schema{"name": enum("nod = sí, shake = no, look_around = mirar alrededor, doubt = duda", "nod", "shake", "look_around", "doubt")}, "name")),
	tool("arms", "Pose rápida de los brazos: front = al frente a la altura del pecho (~0.40 m), high_front = al frente más arriba (~0.50 m), up = arriba, open = abiertos a los lados, down = abajo (vuelven a moverse al caminar). Devuelve dónde quedaron tus manos.",
		object(schema{
			"pose": enum("pose", "front", "high_front", "up", "open", "down"),
			"side": enum("brazo", "both", "left", "right"),
		}, "pose")),
	tool("reach", "Lleva la mano (o las dos) a un punto exacto respecto a tus pies: adelante, a la izquierda y altura desde el suelo, en metros. Tu brazo mide ~0.22 m desde el hombro (hombros a ~0.42 m de alto y ~0.11 m del centro). Devuelve dónde quedaron tus manos y cuánto faltó.",
		object(schema{
			"side":      enum("brazo", "both", "left", "right"),
			"forward_m": number("metros hacia adelante desde tus pies (0.05 a 0.25)"),
			"height_m":  number("altura desde el suelo en metros (0.15 a 0.65)"),
			"left_m":    number("solo con un brazo: metros a tu izquierda (negativo = derecha)"),
			"apart_m":   number("con los dos brazos: separación entre las manos (por defecto 0.22)"),
			"speed":     number("fracción de la velocidad máxima, 0.05 a 1 (rápido = golpe)"),
		}, "forward_m", "height_m")),
	tool("arm_joints", "Mueve tus brazos como quieras, ángulo por ángulo y en grados, con la misma convención para los dos brazos (el derecho se refleja solo: abrir es hacia afuera en ambos). Puedes dar valores distintos a cada brazo en la misma orden con left y right, o los mismos a los dos con side y los ángulos sueltos. Los ángulos que no des se quedan como están. Devuelve dónde quedaron tus manos.",
		object(schema{
			"left":               armAngles("brazo izquierdo"),
			"right":              armAngles("brazo derecho"),
			"side":               enum("con los ángulos sueltos: a qué brazo", "both", "left", "right"),
			"shoulder_pitch_deg": number("90 = abajo pegado al cuerpo, 0 = al frente, -90 = arriba (de -119 a 119)"),
			"shoulder_roll_deg":  number("0 = pegado al costado, 76 = abierto hacia afuera, -18 = cruzado hacia adentro"),
			"elbow_yaw_deg":      number("gira el antebrazo sobre el brazo: -90 = el codo se dobla hacia arriba/adelante (como de pie), 0 = se dobla hacia el pecho (de -119 a 119)"),
			"elbow_roll_deg":     number("-2 = recto, -88 = doblado del todo"),
			"wrist_yaw_deg":      number("gira la mano: 0 = palma hacia adentro, ±90 = palma hacia abajo o arriba (de -104 a 104)"),
			"speed":              number("fracción de la velocidad máxima, 0.05 a 1"),
		})),
	tool("look_at_point", "Mira tu propia mano (hand) o un punto respecto a tus pies (adelante, izquierda, altura en metros) y toma una foto. Úsalo para revisar dónde quedó tu mano respecto al objeto antes y después de moverla.",
		object(schema{
			"hand":      enum("mirar tu mano", "left", "right"),
			"forward_m": number("o un punto: metros adelante"),
			"left_m":    number("metros a la izquierda"),
			"height_m":  number("altura desde el suelo"),
		})),
	tool("look_at", "Mueve la cabeza a un ángulo.", object(schema{"yaw_deg": number("positivo = izquierda, de -119 a 119"), "pitch_deg": number("positivo = abajo, de -38 a 29")}, "yaw_deg", "pitch_deg")),
	tool("animation", "Animación del cuerpo entero (de pie).",
		object(schema{"name": enum("HandWave = saludar con la mano, Shoot = patear SOLO con el pie izquierdo (el derecho te sostiene): la patada alcanza lo que está justo delante de tu pie izquierdo; usa locate para acomodarte, TaiChi = tai chi, WipeForehead = secarse la frente", "HandWave", "Shoot", "TaiChi", "WipeForehead")}, "name")),
	tool("leds", "Cambia por un momento el color de tus luces (para expresarte; no se guarda). Orejas y cabeza solo son azules: ahí el color solo marca el brillo.",
		object(schema{
			"part":  enum("dónde", "eyes", "ears", "chest", "feet", "head", "all"),
			"color": schema{"type": "string", "description": "cualquier color en #rrggbb (por ejemplo #ff8800) u off para apagar"},
		}, "part", "color")),
	tool("my_colors", "Cambia tu apariencia y la guarda como tuya (la verás igual al volver y te distingue de otros NAO): el color de tu carcasa y el de tus ojos. Paleta libre.",
		object(schema{
			"shell": schema{"type": "string", "description": "color de las piezas de color de la carcasa (el resto es blanco) en #rrggbb, u original para el azul de fábrica"},
			"eyes":  schema{"type": "string", "description": "color de tus ojos en #rrggbb, u original para el de fábrica"},
		})),
	tool("look", "Toma una foto nueva con tus dos cámaras.", nil),
	tool("scan", "Mira alrededor girando la cabeza a la izquierda, al centro y a la derecha y devuelve un mosaico. Con full=true además gira el cuerpo 180° y mira detrás: 360° en una imagen de dos filas (úsalo para buscar o contar cosas en todo el entorno).",
		object(schema{"full": schema{"type": "boolean", "description": "true = vuelta completa (360°, tarda ~20 s)"}})),
	tool("stop", "Detén cualquier movimiento ya.", nil),
	tool("finish", "Inclúyela al final de una respuesta cuando lo que pides en ella termina la tarea y no necesitas ver cómo salió. Si todo sale bien, el turno termina ahí sin volver a consultarte (más rápido y barato); si algo falla, recibes los resultados.", nil),
}}}
