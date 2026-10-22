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
- Para buscar alrededor usa scan. Si no ves EXACTAMENTE lo que te pidieron (mismo color y tipo de objeto), no vayas hacia otra cosa parecida: gira 180 grados (turn) y vuelve a hacer scan; si tampoco está, dilo.
- Para empujar algo: primero approach hasta tenerlo justo enfrente y luego push.
- Coordenadas del mundo: x e y en metros; rumbo en grados (0 = eje x, positivo = giro a la izquierda). Tu estado trae tu posición y "origen", donde estabas al recibir la orden, para volver con go_to.
- Si te dicen "para", "quieto" o "detente", usa stop.
- Tus límites: caminas despacio (unos 8 cm por segundo), no saltas ni subes escaleras y todavía no agarras objetos.

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
	tool("look_at", "Mueve la cabeza a un ángulo.", object(schema{"yaw_deg": number("positivo = izquierda, de -119 a 119"), "pitch_deg": number("positivo = abajo, de -38 a 29")}, "yaw_deg", "pitch_deg")),
	tool("animation", "Animación del cuerpo entero (de pie).",
		object(schema{"name": enum("HandWave = saludar con la mano, Shoot = patear, TaiChi = tai chi, WipeForehead = secarse la frente", "HandWave", "Shoot", "TaiChi", "WipeForehead")}, "name")),
	tool("leds", "Cambia el color de tus luces.",
		object(schema{
			"part":  enum("dónde", "eyes", "ears", "chest", "all"),
			"color": enum("color", "white", "red", "green", "blue", "yellow", "magenta", "cyan", "off"),
		}, "part", "color")),
	tool("look", "Toma una foto nueva con tus dos cámaras.", nil),
	tool("scan", "Mira alrededor girando la cabeza a la izquierda, al centro y a la derecha. Devuelve un mosaico de tres vistas (izquierda a la izquierda).", nil),
	tool("stop", "Detén cualquier movimiento ya.", nil),
}}}
