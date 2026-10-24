# Modelos 3D de los muebles y objetos (Meshy)

Cada mueble del mundo 1 ya existe como **placeholder** de formas simples, con física, en `src/sim/props.ts`, con un
id (`model: 'bed'`…). Cuando llega su modelo, la app lo dibuja en lugar del placeholder, ajustado solo a su caja. La
física no cambia: siguen siendo las cajas del placeholder, estables y livianas. Si un modelo falla o no está, se ve el
placeholder: nada se rompe.

## El flujo, para un modelo (y se repite igual para todos)

1. **Generar en Meshy** con el prompt de la tabla y exportar **GLB**.
2. **Reducirlo** con los scripts de Juntox (`juntox/site/tools/`, requieren `npm install` en `juntox/site`). Cualquiera
   de los dos sirve:
   - Sin decodificador, el más simple:
     `cd ../juntox/site && node tools/prep-model.mjs <descarga.glb> <id> --texture 512 --format jpeg --keep-color`
     (añadir `--simplify 0.3` si tiene muchos triángulos). Escribe `juntox/site/models/<id>.glb`: **copiarlo** a
     `nao/public/models/props/<id>.glb` y borrarlo de juntox.
   - Más liviano (geometría comprimida con meshopt; la app ya trae el decodificador):
     `node tools/prep-hero.mjs <descarga.glb> --out ../../nao/public/models/props/<id>.glb --ratios 0.3 --texture 512`
     (`node tools/inspect.mjs <archivo>` dice triángulos y peso de las texturas para elegir `--ratios`).
3. **Anotarlo** en `public/models/props/manifest.json`:
   ```json
   { "bed": { "file": "bed.glb" } }
   ```
4. **Recargar** la página: el modelo reemplaza al placeholder. Si quedó mirando hacia otro lado, se corrige su frente
   en grados sin tocar el archivo: `{ "bed": { "file": "bed.glb", "turn": 90 } }`.

Ajuste automático (`src/sim/propModels.ts`): el GLB se toma con **Y arriba y el frente hacia +Z** (lo normal en glTF y
Meshy), se gira hacia donde mira el mueble, se escala **sin deformar** para caber en la caja del placeholder, se centra
y se apoya en el piso.

**Presupuesto por modelo:** ≤ 300 KB y ≤ 10 000 triángulos; textura de 512 px (1024 solo para las piezas
protagonistas). La cámara del NAO trabaja a 320 × 240: más detalle no se ve y pesa en tablets.

**Archivos de prueba:** los que empiezan con `_` (p. ej. `_prueba-mesita.glb`) no se suben a git (`.gitignore`): para
probar con modelos de otros proyectos sin publicarlos. Antes de desplegar, que no quede ninguno.

**Licencia:** revisar los términos de Meshy según el plan con que se generó (en algunos el modelo es tuyo, en otros pide
atribución) y anotarlo aquí al subir el primero.

## Muebles con placeholder (listos para recibir su modelo)

Estilo común para todos los prompts (diseño propio, sin referencias a marcas ni personajes): *"stylized toy-like game
asset, soft rounded shapes, bright saturated colors, simple clean materials, single object, no background"*.

| id | Cuarto | Caja (ancho × fondo × alto, m) | Prompt (+ estilo común) |
|---|---|---|---|
| `bed` | Casa | 0.90 × 1.90 × 0.90 (cabecera) | single kid bed with wooden frame and headboard, white mattress, blue blanket, white pillow |
| `nightstand` | Casa | 0.40 × 0.38 × 0.50 | small wooden nightstand with one drawer and round knob |
| `toy_shelf` | Casa | 0.30 × 1.20 × 0.90 | low yellow toy shelf with three open cubbies |
| `lab_table` | Laboratorio | 0.90 × 0.50 × 0.35 | low white lab table with metal legs |
| `lab_shelf` | Laboratorio | 0.35 × 0.60 × 1.20 | tall grey metal shelving unit with four shelves |
| `whiteboard` | Laboratorio | 1.20 × 0.03 × 0.80 | wall whiteboard with aluminum frame and marker tray |
| `plant` | Pasillo | 0.60 × 0.60 × 0.93 | big leafy indoor plant in a terracotta pot |
| `pouf` | Espejo | 0.45 × 0.45 × 0.38 | round lilac fabric pouf |

## Siguientes (aún sin placeholder; los agrego yo antes de que lleguen)

- **Piezas protagonistas (alta calidad):** base de carga del NAO (casa), planta grande o un sofá.
- **Objetos para la visión (baja calidad, se mueven con física):** taza, libro, peluche, mochila, zapato, frutas
  (manzana, banano), carro de juguete, silla pequeña, maceta. Estos son objetos sueltos, no muebles: su física será la
  envolvente convexa del modelo (como el NAO) con masa APPROX.
- **Patio de retos (mundo 2):** banco de parque, regadera.
