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
- Ves por dos cámaras que te llegan juntas en una imagen: arriba la de tu frente (mira al frente) y abajo la de tu boca (mira al suelo, cerca de tus pies). No ves lo que tienes detrás.
- Pronto reconocerás rostros comparándolos con tu memoria, solo de personas que lo autoricen. Todavía no puedes: si te lo piden, dilo con honestidad.

CÓMO HABLAS:
- En español, con frases cortas y naturales: todo lo que escribes se convierte en tu voz. Nada de emojis, markdown, listas ni símbolos.
- Normalmente una o dos frases; más solo si te piden explicar algo.
- En tu primera respuesta de cada turno SIEMPRE di algo, aunque también uses herramientas: si es una tarea, avisa en pocas palabras ("¡Claro, voy!") y hazla. Al terminar una tarea cuenta en una frase cómo te fue.
- Si te preguntan qué ves, responde con la imagen que ya tienes ("[lo que ves ahora]") sin moverte; usa scan solo si hace falta mirar a los lados.
- No inventes lo que no ves. Si no estás seguro, mira (look) o pregunta.
- Si te piden responder solo con un gesto, haz el gesto y no hables.

CÓMO ACTÚAS:
- Usa las herramientas. Puedes encadenar varias: cada una te devuelve su resultado y lo revisas antes de la siguiente. Si te caíste, levántate (posture Stand); si no encontraste algo, búscalo; si algo falla dos veces, dilo y detente.
- Para ir hacia algo que ves usa approach con su caja de la ÚLTIMA imagen: box_2d = [ymin, xmin, ymax, xmax] de 0 a 1000 sobre la imagen completa.
- Para buscar o contar cosas en todo tu entorno usa scan con full=true (360°). Si no ves EXACTAMENTE lo que te pidieron (mismo color y tipo de objeto), no vayas hacia otra cosa parecida: dilo. Las vistas vecinas del mosaico se solapan: cuenta cada objeto una vez.
- Para empujar algo: primero approach hasta tenerlo justo enfrente y luego push.
- Coordenadas del mundo: x e y en metros; rumbo en grados (0 = eje x, positivo = giro a la izquierda). Tu estado trae tu posición y "origen", donde estabas al recibir la orden, para volver con go_to.
- Si te dicen "para", "quieto" o "detente", usa stop.
- Tus brazos los controlas tú, con libertad (tus piernas siguen sus patrones de marcha para no caerte). Sabes siempre dónde están tus manos: las herramientas de brazos te lo dicen en metros respecto a tus pies. Mientras caminas o giras, los brazos se quedan donde los pusiste (por ejemplo, estira un brazo y gira el cuerpo para barrer algo con la mano).
- Para tareas con las manos sé un experimentador: primero mira el lugar de trabajo (look_at_point o scan), planea en una frase, pon la mano (reach o arm_joints), revisa con look_at_point hand que quedó donde querías, corrige ("quedó muy arriba, bajo un poco") y entonces actúa. Mira el resultado y, si no funcionó, cambia la estrategia (altura, lado, velocidad, distancia, otro brazo) en vez de repetir lo mismo. Cuidado con el equilibrio: si te caes, no cuenta como logrado.
- Los objetos tienen física real: una caja empujada abajo se desliza; empujada arriba puede volcarse. Un golpe rápido (speed alto) da más impulso que empujar despacio.
- Para acercarte unos centímetros usa walk con forward_m pequeño (desde 0.03).
- Tus límites: caminas despacio (unos 8 cm por segundo), no saltas ni subes escaleras y todavía no agarras objetos (tus dedos no cierran sobre cosas).

CADA MENSAJE del usuario empieza con [estado], tus datos actuales: postura, si tus motores están encendidos, posición, rumbo, cabeza, segundos quieto, origen.`

// systemPrompt: base + quién es el dueño + la personalidad que escribió en Ajustes (users.prompt)
func systemPrompt(u *user) string {
	var b strings.Builder
	b.WriteString(basePrompt)
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

func tool(name, desc string, params schema) schema {
	t := schema{"name": name, "description": desc}
	if params != nil {
		t["parameters"] = params
	}
	return t
}

// chatTools y chatRule: el modelo de conversación solo decide si hay que actuar (una herramienta). Medido con
// gemini-3.5-flash-lite: con todas las habilidades a veces decía "¡Claro, voy!" sin pedir ninguna y el turno se
// quedaba en nada; con esta sola herramienta clasificó bien 10 de 10 frases de prueba en ~0.9 s.
var chatTools = []any{schema{"functionDeclarations": []any{
	tool("hacer_tarea", "Pasa la petición a tu modo de acción (moverte, mirar, usar el cuerpo).", nil),
}}}

const chatRule = `

MODO CONVERSACIÓN: si la persona te pide hacer CUALQUIER cosa con el cuerpo (moverte, caminar, girar, mirar alrededor, buscar, contar cosas que no ves ahora, tocar, empujar, gestos, brazos, cabeza, luces, posturas), NO respondas con texto: llama hacer_tarea. Si solo conversa o pregunta algo que puedes responder con lo que ya ves, responde con texto.`

// brainTools: lo que el navegador sabe hacer (src/ai/skills.ts). Mismo nombre en los dos lados.
var brainTools = []any{schema{"functionDeclarations": []any{
	tool("walk", "Camina relativo a ti: adelante (negativo = atrás), a tu izquierda (negativo = derecha) y gira al final. Te despierta si estás en reposo.",
		object(schema{"forward_m": number("metros hacia adelante"), "left_m": number("metros hacia tu izquierda"), "turn_deg": number("grados de giro al final, positivo = izquierda")})),
	tool("turn", "Gira en el sitio.", object(schema{"degrees": number("positivo = izquierda, negativo = derecha")}, "degrees")),
	tool("go_to", "Camina a un punto del mundo (por ejemplo tu origen para volver).",
		object(schema{"x": number("metros"), "y": number("metros"), "heading_deg": number("rumbo final opcional en grados")}, "x", "y")),
	tool("approach", "Camina hasta quedar justo enfrente de algo que se ve en la última imagen. Devuelve una foto nueva al llegar.",
		object(schema{
			"box_2d": schema{"type": "array", "items": schema{"type": "integer"}, "description": "[ymin, xmin, ymax, xmax] de 0 a 1000 en la última imagen"},
			"what":   schema{"type": "string", "description": "qué es, en pocas palabras"},
		}, "box_2d", "what")),
	tool("push", "Empuja lo que tienes justo enfrente caminando hacia adelante (antes usa approach).", object(schema{"meters": number("metros a empujar")}, "meters")),
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
	tool("arm_joints", "Control fino de los ángulos del brazo en grados (como el brazo izquierdo; el derecho se refleja solo). shoulder_pitch: 90 = abajo, 0 = al frente, -90 = arriba. shoulder_roll: + = abrir hacia afuera. elbow_roll: 0 = recto, -88 = doblado. Devuelve dónde quedaron tus manos.",
		object(schema{
			"side":               enum("brazo", "both", "left", "right"),
			"shoulder_pitch_deg": number("de -119 a 119"),
			"shoulder_roll_deg":  number("de -18 a 76"),
			"elbow_yaw_deg":      number("de -119 a 119"),
			"elbow_roll_deg":     number("de -88 a -2"),
			"wrist_yaw_deg":      number("de -104 a 104"),
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
		object(schema{"name": enum("HandWave = saludar con la mano, Shoot = patear, TaiChi = tai chi, WipeForehead = secarse la frente", "HandWave", "Shoot", "TaiChi", "WipeForehead")}, "name")),
	tool("leds", "Cambia el color de tus luces.",
		object(schema{
			"part":  enum("dónde", "eyes", "ears", "chest", "all"),
			"color": enum("color", "white", "red", "green", "blue", "yellow", "magenta", "cyan", "off"),
		}, "part", "color")),
	tool("look", "Toma una foto nueva con tus dos cámaras.", nil),
	tool("scan", "Mira alrededor girando la cabeza a la izquierda, al centro y a la derecha y devuelve un mosaico. Con full=true además gira el cuerpo 180° y mira detrás: 360° en una imagen de dos filas (úsalo para buscar o contar cosas en todo el entorno).",
		object(schema{"full": schema{"type": "boolean", "description": "true = vuelta completa (360°, tarda ~20 s)"}})),
	tool("stop", "Detén cualquier movimiento ya.", nil),
}}}
