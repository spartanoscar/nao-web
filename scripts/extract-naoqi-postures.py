"""Convierte el grafo de posturas de NAOqi 2.8 (XML de boost::serialization de Choregraphe 2.8.7.4,
share/naoqi/robot_posture/) a JSON para la app (src/naoqi/naoqiPostureGraph.ts). Solo cambia el formato: mismos
nodos, ángulos, inclinaciones, vecinos, costos y coeficientes de velocidad. Lee datos descargados: correr con -I.

    python3 -I scripts/extract-naoqi-postures.py postures_naoh25.xml motion_postures_naoh25.xml salida.json
"""

import json
import sys
import xml.etree.ElementTree as ET

# Orden de jointAngles: el de ALMotion.getBodyNames("Body") en NAO (26 nombres, con RHipYawPitch)
JOINTS = (
    "HeadYaw HeadPitch LShoulderPitch LShoulderRoll LElbowYaw LElbowRoll LWristYaw LHand LHipYawPitch LHipRoll "
    "LHipPitch LKneePitch LAnklePitch LAnkleRoll RHipYawPitch RHipRoll RHipPitch RKneePitch RAnklePitch RAnkleRoll "
    "RShoulderPitch RShoulderRoll RElbowYaw RElbowRoll RWristYaw RHand"
).split()


def read(path):
    text = open(path, encoding="utf-8").read()
    # boost no escribe el cierre de <boost_serialization>; el DOCTYPE se quita para no resolver nada externo
    body = text[text.index("<boost_serialization"):]
    if "</boost_serialization>" not in body:
        body += "</boost_serialization>"
    root = ET.fromstring(body)
    out = {}
    for item in root.find("postures").findall("item"):
        s = item.find("second")
        sig = s.find("signature")
        angles = [float(x.text) for x in sig.find("jointAngles").findall("item")]
        if len(angles) != len(JOINTS):
            raise SystemExit(f"postura {s.find('id').text}: {len(angles)} ángulos, se esperaban {len(JOINTS)}")
        out[s.find("id").text] = {
            "name": s.find("name").text or "",
            "family": s.find("familyName").text,
            "angles": [round(a, 6) for a in angles],
            # [AngleX, AngleY] de la unidad inercial (rad): alabeo y cabeceo del torso en esa postura
            "inertial": [round(float(x.text), 6) for x in sig.find("inertialAngles").findall("item")],
            # [vecino, costo, enableAntiCollision, speedCoefficient]
            "neighbours": [
                [
                    int(n.find("postureIndex").text),
                    float(n.find("cost").text),
                    int(n.find("enableAntiCollision").text),
                    round(float(n.find("speedCoefficient").text), 4),
                ]
                for n in s.find("neighbours").findall("item")
            ],
        }
    return out


postures_xml, motion_xml, dest = sys.argv[1:4]
graph = {
    "source": "Choregraphe 2.8.7.4 (linux64), share/naoqi/robot_posture/ (c) Aldebaran",
    "joints": JOINTS,
    "postures": read(postures_xml),
    # Poses de protección al caer del fall manager (_FallFrontRightUp…): aún sin usar
    "fallPoses": read(motion_xml),
}
with open(dest, "w", encoding="utf-8") as f:
    json.dump(graph, f, separators=(",", ":"))
print(f"✓ {len(graph['postures'])} posturas, {sum(len(p['neighbours']) for p in graph['postures'].values())} tramos, "
      f"{len(graph['fallPoses'])} poses de caída → {dest}")
