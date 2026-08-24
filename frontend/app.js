import * as THREE from "three";

// ---------------------------------------------------------------------
// VERSION — bump this on every change to frontend/app.js. Shown in the
// HUD so you can confirm at a glance whether a deploy actually landed,
// instead of guessing from a git pull that silently no-opped.
// ---------------------------------------------------------------------
const APP_VERSION = "0.2.0";

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------
const WS_URL = `ws://${location.hostname}:8765`;
const FLOORPLAN_URL = "../config/floorplan.json";

// The floorplan/marker mirror below is OFF by default — it was a wrong
// fix for a drag-direction complaint (see mousemove handler below for
// the actual fix). Left here disabled in case a genuine east/west data
// mirror is ever needed later.
const MIRROR_X = false;
function wx(x) {
  return MIRROR_X ? -x : x;
}

// ---------------------------------------------------------------------
// SCENE SETUP
// ---------------------------------------------------------------------
const container = document.getElementById("scene-container");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);

const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.1, 200
);

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
let cameraDistance = 20; // overwritten once the floorplan bounds are known
const center = new THREE.Vector3(0, 0, 0); // overwritten once floorplan loads

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
  // ROTATE_DIRECTION: if dragging left still spins the view right (or
  // vice versa), this is the ONLY thing to flip — change 1 to -1 below,
  // save, git pull, hard-refresh. No need to wait on another round trip.
  const ROTATE_DIRECTION = -1;
  cameraAngle.theta -= ROTATE_DIRECTION * dx * 0.005;
  cameraAngle.phi = Math.min(Math.max(cameraAngle.phi - dy * 0.005, 0.1), Math.PI - 0.1);
  prevMouse = { x: e.clientX, y: e.clientY };
  updateCameraFromOrbit();
});
renderer.domElement.addEventListener("wheel", (e) => {
  cameraDistance = Math.min(Math.max(cameraDistance + e.deltaY * 0.02, 3), 80);
  updateCameraFromOrbit();
});

// Lighting — soft, since this is a translucent schematic view, not a
// realistic render.
scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.4);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

// ---------------------------------------------------------------------
// FLOORPLAN (loaded from config/floorplan.json — see that file's
// comments for how coordinates are defined, and its caveats about
// approximation vs. laser-measured precision)
// ---------------------------------------------------------------------
async function loadFloorplan() {
  const res = await fetch(FLOORPLAN_URL);
  if (!res.ok) {
    throw new Error(`failed to load floorplan.json: ${res.status}`);
  }
  return res.json();
}

function buildFloorplan(data) {
  const group = new THREE.Group();
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const room of data.rooms) {
    const level = data.levels[room.level];
    const yBase = level.y_base;
    const yTop = yBase + level.ceiling_height;
    const cx = room.x + room.w / 2;
    const cz = room.z + room.d / 2;
    const cy = yBase + level.ceiling_height / 2;

    const geo = new THREE.BoxGeometry(room.w, level.ceiling_height, room.d);
    const color = new THREE.Color(room.color || "#3a6ea5");
    const mat = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: room.exterior ? 0.03 : 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(wx(cx), cy, cz);
    group.add(mesh);

    const edges = new THREE.EdgesGeometry(geo);
    const wireMat = new THREE.LineBasicMaterial({
      color, transparent: true, opacity: room.exterior ? 0.25 : 0.55,
    });
    const wireframe = new THREE.LineSegments(edges, wireMat);
    wireframe.position.copy(mesh.position);
    group.add(wireframe);

    // Floor-level room label
    const label = makeRoomLabelSprite(room.label);
    label.position.set(wx(cx), yBase + 0.05, cz);
    group.add(label);

    minX = Math.min(minX, room.x); maxX = Math.max(maxX, room.x + room.w);
    minZ = Math.min(minZ, room.z); maxZ = Math.max(maxZ, room.z + room.d);
    minY = Math.min(minY, yBase); maxY = Math.max(maxY, yTop);
  }

  // Ground grid for spatial reference, sized to the floorplan extent
  const spanX = maxX - minX, spanZ = maxZ - minZ;
  const gridSize = Math.max(spanX, spanZ) * 1.6;
  const grid = new THREE.GridHelper(gridSize, 20, 0x334455, 0x1a2230);
  grid.position.set(wx((minX + maxX) / 2), minY, (minZ + maxZ) / 2);
  group.add(grid);

  return {
    group,
    bounds: { minX, maxX, minZ, maxZ, minY, maxY },
  };
}

function makeRoomLabelSprite(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "bold 28px sans-serif";
  ctx.fillStyle = "rgba(230, 230, 230, 0.55)";
  ctx.textAlign = "center";
  ctx.fillText(text, canvas.width / 2, 40);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.8, 0.45, 1);
  // Note: three.js Sprites always billboard to face the camera, so this
  // is not really "flat on the floor" — it'll tilt to face you as you
  // orbit. Good enough for a schematic room label; swap for a
  // CSS2DRenderer/HTML overlay later if you want true floor-plane text.
  return sprite;
}

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
  entry.mesh.position.set(wx(x), y, z);
  entry.sprite.position.set(wx(x), y + 1.9, z);

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
const versionEl = document.getElementById("version-tag");
if (versionEl) versionEl.textContent = `v${APP_VERSION}`;

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
    mesh.position.set(wx(x), y, z);
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

async function init() {
  let floorplanData;
  try {
    floorplanData = await loadFloorplan();
  } catch (err) {
    console.error("Could not load floorplan.json:", err);
    statusEl.textContent = "floorplan failed to load — check config/floorplan.json";
    statusEl.className = "bad";
    return;
  }

  const { group, bounds } = buildFloorplan(floorplanData);
  scene.add(group);

  // Point the orbit camera at the actual center of the loaded floorplan
  // instead of the old hardcoded placeholder box. Mirror x here too so
  // orbiting stays centered on the (now-flipped) house.
  center.set(
    wx((bounds.minX + bounds.maxX) / 2),
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2
  );
  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  cameraDistance = Math.max(spanX, spanZ) * 1.6;
  updateCameraFromOrbit();

  connect();
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  // Billboard the status sprites toward the camera (Sprite does this
  // automatically in three.js, kept here as a reminder / extension point
  // if you switch to a non-Sprite label approach later).
  renderer.render(scene, camera);
}

init();
