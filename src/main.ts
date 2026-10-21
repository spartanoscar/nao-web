// F1: escena mínima para validar el bundle (Three.js) y el deploy.
// El entorno real (suelo, cubos, cajas y el esqueleto del NAO) llega en F2 dentro de src/sim/.
import * as THREE from 'three';

const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);

// NAO mide 0.574 m: la cámara se encuadra a esa escala (unidades = metros, como el URDF)
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50);
camera.position.set(1.2, 0.8, 1.2);
camera.lookAt(0, 0.3, 0);

scene.add(new THREE.GridHelper(4, 40, 0x3a4250, 0x232a35));
scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1.2));

// Marcador de altura del NAO mientras no existe el modelo
const marker = new THREE.Mesh(
  new THREE.BoxGeometry(0.15, 0.574, 0.1),
  new THREE.MeshStandardMaterial({ color: 0x3aa0ff, wireframe: true }),
);
marker.position.y = 0.574 / 2;
scene.add(marker);

function resize() {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop((t) => {
  marker.rotation.y = t / 2000;
  renderer.render(scene, camera);
});
