import * as THREE from "three";

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------
const WS_URL = `ws://${location.hostname}:8765`;

// Placeholder house dimensions in meters — replace with your real
// floorplan. Simplest upgrade path: define a list of room boxes (min/max
// corners) below instead of one big shell, so walls between rooms show
// up too.
const HOUSE = {
  width: 10,   // x
  height: 5,   // y (two floors ~2.5m each, adjust to taste)
  depth: 12,   // z
};

// ---------------------------------------------------------------------
// SCENE SETUP
// ---------------------------------------------------------------------
const container = document.getElementById("scene-container");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);

const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.1, 200
);
camera.position.set(HOUSE.width * 1.4, HOUSE.height * 2.2, HOUSE.depth * 1.4);
camera.lookAt(HOUSE.width / 2, HOUSE.height / 2, HOUSE.depth / 2);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Basic orbit-style control without extra deps: drag to rotate around
// the house center, scroll to zoom. (Swap for three/examples OrbitControls
// later if you want more polish — kept dependency-free here.)
let isDragging = false;
let prevMouse = { x: 0, y: 0 };
let cameraAngle = { theta: Math.PI * 0.25, phi: Math.PI * 0.3 };
let cameraDistance = Math.max(HOUSE.width, HOUSE.depth) * 1.8;
const center = new THREE.Vector3(HOUSE.width / 2, HOUSE.height / 2, HOUSE.depth / 2);

function updateCameraFromOrbit() {
  const x = center.x + cameraDistance * Math.sin(cameraAngle.phi) * Math.cos(cameraAngle.theta);
  const y = center.y + cameraDistance * Math.cos(cameraAngle.phi);
  const z = center.z + cameraDistance * Math.sin(cameraAngle.phi) * Math.sin(cameraAngle.theta);
  camera.position.set(x, y, z);
  camera.lookAt(center);
}
updateCameraFromOrbit();

renderer.domElement.addEventListener("mousedown", (e) => {
  isDragging = true;
  prevMouse = { x: e.clientX, y: e.clientY };
});
window.addEventListener("mouseup", () => (isDragging = false));
window.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const dx = e.clientX - prevMouse.x;
  const dy = e.clientY - prevMouse.y;
  cameraAngle.theta -= dx * 0.005;
  cameraAngle.phi = Math.min(Math.max(cameraAngle.phi - dy * 0.005, 0.1), Math.PI - 0.1);
  prevMouse = { x: e.clientX, y: e.clientY };
  updateCameraFromOrbit();
});
renderer.domElement.addEventListener("wheel", (e) => {
  cameraDistance = Math.min(Math.max(cameraDistance + e.deltaY * 0.02, 3), 60);
  updateCameraFromOrbit();
});

// Lighting — soft, since this is a translucent schematic view, not a
// realistic render.
scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.4);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

// ---------------------------------------------------------------------
// HOUSE SHELL (placeholder — replace with real floorplan geometry)
// ---------------------------------------------------------------------
function buildHouseShell() {
  const group = new THREE.Group();

  const shellGeo = new THREE.BoxGeometry(HOUSE.width, HOUSE.height, HOUSE.depth);
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x3a6ea5,
    transparent: true,
    opacity: 0.06,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const shellMesh = new THREE.Mesh(shellGeo, shellMat);
  shellMesh.position.set(HOUSE.width / 2, HOUSE.height / 2, HOUSE.depth / 2);
  group.add(shellMesh);

  const edges = new THREE.EdgesGeometry(shellGeo);
  const wireMat = new THREE.LineBasicMaterial({ color: 0x6ea8e7, transparent: true, opacity: 0.4 });
  const wireframe = new THREE.LineSegments(edges, wireMat);
  wireframe.position.copy(shellMesh.position);
  group.add(wireframe);

  // Ground grid for spatial reference
  const grid = new THREE.GridHelper(Math.max(HOUSE.width, HOUSE.depth) * 1.5, 20, 0x334455, 0x1a2230);
  grid.position.set(HOUSE.width / 2, 0, HOUSE.depth / 2);
  group.add(grid);

  return group;
}
scene.add(buildHouseShell());

// ---------------------------------------------------------------------
// NODE MARKERS (fixed sensor positions)
// ---------------------------------------------------------------------
const nodeMarkers = new Map(); // node_id -> { mesh, label }

function makeNodeMarker(nodeId) {
  const geo = new THREE.SphereGeometry(0.12, 16, 16);
  const mat = new THREE.MeshStandardMaterial({ color: 0x666666, emissive: 0x222222 });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);
  return mesh;
}

function nodeColorForState(entry) {
  if (entry.stale) return 0x555555;
  if (entry.presence) return 0x6ee7a8;
  return 0x6ea8e7;
}

// ---------------------------------------------------------------------
// PERSON MARKERS with floating status bar (canvas-texture sprite)
// ---------------------------------------------------------------------
const personMarkers = new Map(); // person_id -> { mesh, sprite, lastUpdate }

function makeStatusSprite(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  drawStatusCanvas(ctx, canvas, text);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, 0.6, 1);
  sprite._canvas = canvas;
  sprite._ctx = ctx;
  sprite._texture = texture;
  return sprite;
}

function drawStatusCanvas(ctx, canvas, lines) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(15, 18, 26, 0.85)";
  roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 10);
  ctx.fill();
  ctx.strokeStyle = "rgba(110, 168, 231, 0.6)";
  ctx.lineWidth = 2;
  roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 10);
  ctx.stroke();

  ctx.fillStyle = "#e6e6e6";
  ctx.font = "bold 20px sans-serif";
  ctx.fillText(lines[0] ?? "", 16, 32);

  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#9fd8b5";
  ctx.fillText(lines[1] ?? "", 16, 58);

  ctx.font = "13px sans-serif";
  ctx.fillStyle = "#8899aa";
  ctx.fillText(lines[2] ?? "", 16, 82);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makePersonMesh() {
  // Simple capsule-ish stand-in for a person: cylinder body + sphere head.
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xf2c94c, transparent: true, opacity: 0.85, emissive: 0x332200,
  });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 1.1, 12), bodyMat);
  body.position.y = 0.55;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 16), bodyMat);
  head.position.y = 1.25;
  group.add(body, head);
  return group;
}

function updatePersonMarker(person) {
  let entry = personMarkers.get(person.id);
  if (!entry) {
    const mesh = makePersonMesh();
    const sprite = makeStatusSprite([person.id, "", ""]);
    scene.add(mesh);
    scene.add(sprite);
    entry = { mesh, sprite };
    personMarkers.set(person.id, entry);
  }

  const [x, y, z] = person.position;
  entry.mesh.position.set(x, y, z);
  entry.sprite.position.set(x, y + 1.9, z);

  const breathLine = person.breath_rate_bpm != null
    ? `Breath: ${person.breath_rate_bpm} bpm`
    : "Breath: --";
  const confLine = `Confidence: ${(person.confidence * 100).toFixed(0)}%`;
  drawStatusCanvas(entry.sprite._ctx, entry.sprite._canvas, [person.id, breathLine, confLine]);
  entry.sprite._texture.needsUpdate = true;

  entry.lastSeen = performance.now();
}

function pruneStalePersonMarkers(seenIds) {
  for (const [id, entry] of personMarkers.entries()) {
    if (!seenIds.has(id)) {
      scene.remove(entry.mesh);
      scene.remove(entry.sprite);
      personMarkers.delete(id);
    }
  }
}

// ---------------------------------------------------------------------
// WEBSOCKET
// ---------------------------------------------------------------------
const statusEl = document.getElementById("conn-status");

function connect() {
  const ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    statusEl.textContent = "connected";
    statusEl.className = "ok";
  };

  ws.onclose = () => {
    statusEl.textContent = "disconnected — retrying...";
    statusEl.className = "bad";
    setTimeout(connect, 1500);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    const state = JSON.parse(event.data);
    handleState(state);
  };
}

function handleState(state) {
  // Update / create node markers
  for (const [nodeId, entry] of Object.entries(state.nodes)) {
    let mesh = nodeMarkers.get(nodeId);
    if (!mesh) {
      mesh = makeNodeMarker(nodeId);
      nodeMarkers.set(nodeId, mesh);
    }
    const [x, y, z] = entry.position;
    mesh.position.set(x, y, z);
    mesh.material.color.setHex(nodeColorForState(entry));
    mesh.material.emissive.setHex(entry.presence ? 0x113322 : 0x111111);
  }

  // Update / create / prune person markers
  const seenIds = new Set();
  for (const person of state.people) {
    updatePersonMarker(person);
    seenIds.add(person.id);
  }
  pruneStalePersonMarkers(seenIds);
}

connect();

// ---------------------------------------------------------------------
// RENDER LOOP
// ---------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  // Billboard the status sprites toward the camera (Sprite does this
  // automatically in three.js, kept here as a reminder / extension point
  // if you switch to a non-Sprite label approach later).
  renderer.render(scene, camera);
}
animate();
