# reference/ — Estado base (fuente de verdad del NAO real)

Material descargado de fuentes oficiales/abiertas el 2026-10-21. **No se edita a mano**:
todo lo que implementamos en el simulador se deriva o se valida contra esto.

| Carpeta | Qué es | Origen | Licencia |
|---|---|---|---|
| `urdf/naoV50.urdf` | Modelo cinemático oficial NAO V5 (misma cinemática que V6): 26 joints revolute + dedos mimic, límites, masas, inercias, offsets de cada link | [ros-naoqi/nao_robot](https://github.com/ros-naoqi/nao_robot) `nao_description/urdf/naoV50_generated_urdf` | BSD-3 (`urdf/LICENSE-nao_robot.txt`) |
| `urdf/naoV40.urdf` | Igual, versión V4 (para comparar) | idem | BSD-3 |
| `motions/*.motion` | Animaciones por keyframes (HandWave, TaiChi, Forwards, Shoot, StandUpFromFront…) en formato CSV `tiempo,pose,joint1,joint2…` (`*` = sin cambio) | [cyberbotics/webots](https://github.com/cyberbotics/webots) `projects/robots/softbank/nao/motions` | Apache-2.0 (`motions/LICENSE-webots.txt`) |
| `qibullet/robot_posture.py`, `nao_virtual.py` | Valores articulares de las 8 posturas predefinidas (Stand, StandInit, StandZero, Crouch, Sit, SitRelax, LyingBelly, LyingBack). `nao_postures.json` es derivado (`scripts/extract-postures.py`) | [softbankrobotics-research/qibullet](https://github.com/softbankrobotics-research/qibullet) (simulador oficial de SoftBank) | Apache-2.0 (`qibullet/LICENSE-qibullet.txt`) |
| `naoth/*.mef` | Motion nets de NaoTH probados en NAO V6 reales: levantarse de espaldas (y variante brazos atrás), boca abajo y de lado; caída protegida adelante/atrás. Formato: 24 joints (cabecera), keyframes en grados, transiciones en ms; su reproductor interpola lineal con rigidez 0.75 (`KeyFrameMotionParameters.cfg`). Sin modificar | [BerlinUnited/NaoTH](https://github.com/BerlinUnited/NaoTH) `NaoTHSoccer/Config/platform/Nao6/motionnet` @ `4a388b41` (2026-10-12) | Apache-2.0 (`naoth/LICENSE-naoth.txt`, `NOTICE-naoth.txt`: © 2017 Humboldt-Universität zu Berlin) |
| `naoqi-2.8-api/*.md` | Documentación oficial de la API NAOqi 2.8 (la que corre en NAO6), convertida a Markdown: ALMotion, ALRobotPosture, ALTextToSpeech, ALMemory, ALLeds, ALVideoDevice, ALAudioDevice, ALSpeechRecognition, ALFaceDetection, ALSonar, colisiones externas, joints/masas/links/**motores** NAO V6, stiffness, fall manager | http://doc.aldebaran.com/2-8/ | © SoftBank/Aldebaran — solo referencia |

## Lo que NO existe en abierto

- El código de **NAOqi** como tal (ALMotion, walk engine, ALRobotPosture, etc.) es **binario cerrado**.
  Lo que es abierto es el framework de comunicación [aldebaran/libqi](https://github.com/aldebaran/libqi) (C++, BSD-3)
  y sus bindings [aldebaran/libqi-python](https://github.com/aldebaran/libqi-python) (BSD-3).
- Por eso el simulador **reimplementa la API pública documentada** (mismos nombres de servicios,
  métodos, parámetros, unidades y semántica), usando el URDF para la cinemática.
  Un script Python real (`session.service("ALMotion").angleInterpolation(...)`) debe correr igual.

## Mallas 3D oficiales (opcional)

[ros-naoqi/nao_meshes2](https://github.com/ros-naoqi/nao_meshes2) tiene las mallas reales, pero con licencia
**CC BY-NC-ND 4.0** (no comercial, sin modificaciones). Por eso no se incluyen: usamos geometría básica y luego
piezas propias hechas en Meshy, alineadas a los frames del URDF.

## Joints NAO V6 (25 DOF)

| Cadena | Joints |
|---|---|
| Head | HeadYaw, HeadPitch |
| LArm | LShoulderPitch, LShoulderRoll, LElbowYaw, LElbowRoll, LWristYaw, LHand |
| RArm | RShoulderPitch, RShoulderRoll, RElbowYaw, RElbowRoll, RWristYaw, RHand |
| LLeg | LHipYawPitch, LHipRoll, LHipPitch, LKneePitch, LAnklePitch, LAnkleRoll |
| RLeg | (RHipYawPitch — acoplado a LHipYawPitch), RHipRoll, RHipPitch, RKneePitch, RAnklePitch, RAnkleRoll |

Rangos exactos: `naoqi-2.8-api/family_nao_technical_joints_naov6.md` (incluye la tabla anti-colisión HeadYaw↔HeadPitch).
