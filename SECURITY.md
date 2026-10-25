# Seguridad

Si encuentras un problema de seguridad (por ejemplo, una forma de consumir la IA, la transcripción o el mundo
compartido sin una cuenta, o de ver datos de otra persona), **no abras un issue público**: repórtalo en privado desde
la pestaña **Security → Report a vulnerability** de este repositorio. Respondo lo antes posible.

Reglas del proyecto que conviene conocer:

- No hay registro abierto: solo entran las cuentas que crea el administrador, y la demo pública es una cuenta
  compartida de solo lectura con un tope diario muy bajo.
- Las claves (Gemini, base de datos, secreto de la sala del mundo) viven solo en el servidor (`server/.env`, fuera de
  git); el navegador nunca las recibe.
- De los rostros se guarda solo la huella numérica (nunca la foto) y con la autorización de la persona (Ley 1581 de
  Colombia).
