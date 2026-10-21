#!/usr/bin/env python3
"""Extrae las posturas predefinidas del NAO de qiBullet (SoftBank Robotics, Apache-2.0).

Lee reference/qibullet/robot_posture.py con `ast` (sin ejecutarlo) y escribe
reference/qibullet/nao_postures.json: { "Stand": { "HeadYaw": 0.0, ... }, ... }

Uso: python3 -I scripts/extract-postures.py
"""
import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "reference/qibullet/robot_posture.py"
OUT = ROOT / "reference/qibullet/nao_postures.json"

tree = ast.parse(SRC.read_text())
cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "NaoPosture")
base = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "RobotPosture")

# Constantes RobotPosture.STAND = "Stand", etc.
names = {
    t.id: n.value.value
    for n in base.body if isinstance(n, ast.Assign) and isinstance(n.value, ast.Constant)
    for t in n.targets if isinstance(t, ast.Name)
}

init = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "__init__")
joint_names = next(
    ast.literal_eval(n.value) for n in ast.walk(init)
    if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "joint_names" for t in n.targets)
)

postures = {}
for node in ast.walk(init):
    if not isinstance(node, ast.If):
        continue
    test = node.test  # self.isPostureName(RobotPosture.X)
    const = test.args[0].attr
    call = node.body[0].value  # self._setPosture(joint_names, [...])
    values = ast.literal_eval(call.args[1])
    assert len(values) == len(joint_names), const
    postures[names[const]] = {j: round(v, 6) + 0.0 for j, v in zip(joint_names, values)}

OUT.write_text(json.dumps(postures, indent=2) + "\n")
print(f"{len(postures)} posturas → {OUT.relative_to(ROOT)}: {', '.join(postures)}")
