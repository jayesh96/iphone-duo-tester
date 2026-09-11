/* iPhone Duo Tester
   Device body rendered in WebGL (Three.js); the two displays stay real DOM
   iframes placed in the same 3D space through Three's CSS3DRenderer, so the
   URL tester keeps working. UI motion uses GSAP; the hinge itself runs on an
   interruptible spring so drags and flicks feel physical. */

import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const gsap = window.gsap;
if (gsap && window.ScrollTrigger) gsap.registerPlugin(window.ScrollTrigger);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DEG = Math.PI / 180;
// Momentum projection (scroll-style exponential decay) and rubber-banding.
const project = (v, d = 0.995) => ((v / 1000) * d) / (1 - d);
const rubberband = (offset, dimension, c = 0.55) => (offset * dimension * c) / (dimension + c * Math.abs(offset));

// Header-check endpoint. A static host sets <meta name="duo-api" content="">
// and the tester loads sites directly.
const apiMeta = $('meta[name="duo-api"]');
const API_URL = apiMeta ? apiMeta.content : 'api/check';

// Published geometry, in millimetres. See the spec sheet on the page.
const SPEC = {
  W: 164.6, H: 117.8, HW: 82.3, T: 5.2, A: 0.45, R: 8.4, bev: 1.3,
  bz: 3.45, rs: 5.6, obx: 2.55, oby: 2.75, ors: 6,
  closedW: 84.1, closedT: 11.3,
  innerW: 157.7, innerH: 110.9, innerPx: [2670, 1878], innerVw: 890, innerVh: 626,
  outerW: 77.2, outerH: 112.3, outerPx: [1398, 2034], outerVw: 466, outerVh: 678,
};

const stage = $('#stage');
const cssHost = $('#css3d');
const glCanvas = $('#gl');
const floorShadow = $('#floor-shadow');
const range = $('#fold-range');
const rangeOut = $('#fold-out');
const flipBtn = $('#flip-btn');
const hint = $('#hint');
const cursorEl = $('#cursor');
const screens = { inner: $('#screen-inner'), outer: $('#screen-outer') };
const frames = { inner: $('#frame-inner'), outer: $('#frame-outer') };
const ro = { state: $('#ro-state'), size: $('#ro-size'), display: $('#ro-display'), viewport: $('#ro-viewport') };

const state = {
  fold: 180,          // degrees; 0 = open, 180 = closed
  target: 180,
  vel: 0,
  zeta: 1,            // spring damping ratio: 1 = no overshoot, 0.8 after a flick
  over: 0,            // rubber-band overshoot past the hinge stops, in degrees
  dragging: false,
  sliderActive: false,
  settled: true,
  flipped: false,
  tilt: { x: 6, y: -16 },
  tiltTarget: { x: 6, y: -16 },
  innerActive: false,
  outerActive: false,
  touched: false,
  pxPerMm: 4,
  reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
};

/* ====================================================================== */
/* Three.js scene                                                         */
/* ====================================================================== */

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(22, 1, 10, 6000);
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
} catch (err) {
  console.warn('WebGL unavailable; the device body will not render.', err);
  stage.classList.add('no-webgl');
}
const cssRenderer = new CSS3DRenderer({ element: cssHost });

const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(180, 280, 420);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xbfd4ff, 0.7);
rimLight.position.set(-320, 140, -260);
scene.add(rimLight);
scene.add(new THREE.HemisphereLight(0xffffff, 0x14161c, 0.45));

/* Materials ------------------------------------------------------------- */

const FINISH = {
  night: { frame: 0x51555e, glass: 0x1b1e25, key: 0x3d414a },
  star: { frame: 0xe9eaee, glass: 0xf2f0ea, key: 0xdcdde2 },
};
const mats = {
  frame: new THREE.MeshPhysicalMaterial({ color: FINISH.night.frame, metalness: 1, roughness: 0.2, envMapIntensity: 1.25 }),
  glass: new THREE.MeshPhysicalMaterial({ color: FINISH.night.glass, metalness: 0.05, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 0.9, side: THREE.DoubleSide }),
  key: new THREE.MeshPhysicalMaterial({ color: FINISH.night.key, metalness: 1, roughness: 0.28, envMapIntensity: 1.1 }),
  bezel: new THREE.MeshPhysicalMaterial({ color: 0x050506, metalness: 0, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 0.8, side: THREE.DoubleSide }),
  cameraKey: new THREE.MeshPhysicalMaterial({ color: 0x0b0c10, metalness: 0.3, roughness: 0.05, clearcoat: 1, envMapIntensity: 1 }),
  lensRing: new THREE.MeshPhysicalMaterial({ color: 0x2a2d35, metalness: 1, roughness: 0.25 }),
  lensGlass: new THREE.MeshPhysicalMaterial({ color: 0x0a0d1a, metalness: 0.1, roughness: 0.02, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.4 }),
  lensCore: new THREE.MeshStandardMaterial({ color: 0x2a55ff, emissive: 0x1b34a8, emissiveIntensity: 0.55, roughness: 0.3 }),
  flash: new THREE.MeshStandardMaterial({ color: 0xfff4d0, emissive: 0xffe7a8, emissiveIntensity: 0.3, roughness: 0.5 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.6 }),
  // Depth-only: punches a transparent hole in the canvas so the DOM display
  // behind it shows through, while still occluding geometry behind the screen.
  hole: new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }),
  wallpaper: null,
};

function makeWallpaperTexture() {
  const c = document.createElement('canvas');
  c.width = 1600; c.height = 1125;
  const g = c.getContext('2d');
  const base = g.createLinearGradient(0, 0, c.width, c.height);
  base.addColorStop(0, '#0c0e2c'); base.addColorStop(0.55, '#1c1146'); base.addColorStop(1, '#082a3d');
  g.fillStyle = base; g.fillRect(0, 0, c.width, c.height);
  const blob = (x, y, r, color) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, color); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, c.width, c.height);
  };
  blob(c.width * 0.18, c.height * 0.08, c.width * 0.6, 'rgba(97,128,255,0.95)');
  blob(c.width * 0.88, c.height * 0.86, c.width * 0.55, 'rgba(255,104,140,0.9)');
  blob(c.width * 0.62, c.height * 0.34, c.width * 0.45, 'rgba(46,230,197,0.75)');
  // The crease: a soft valley down the middle of the inner panel.
  const cr = g.createLinearGradient(c.width * 0.46, 0, c.width * 0.54, 0);
  cr.addColorStop(0, 'rgba(0,0,0,0)'); cr.addColorStop(0.5, 'rgba(0,0,0,0.42)'); cr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = cr; g.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  if (renderer) tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  // ShapeGeometry UVs are the shape's own x/y (mm); map the whole inner panel onto [0,1].
  const w = SPEC.W - 2 * SPEC.bz, h = SPEC.H - 2 * SPEC.bz;
  tex.repeat.set(1 / w, 1 / h);
  tex.offset.set((SPEC.W / 2 - SPEC.bz) / w, (SPEC.H / 2 - SPEC.bz) / h);
  return tex;
}
mats.wallpaper = new THREE.MeshBasicMaterial({ map: makeWallpaperTexture() });

/* Geometry helpers ------------------------------------------------------ */

function roundedRect(x, y, w, h, [tl, tr, br, bl]) {
  const s = new THREE.Shape();
  s.moveTo(x + tl, y + h);
  s.lineTo(x + w - tr, y + h);
  if (tr) s.absarc(x + w - tr, y + h - tr, tr, Math.PI / 2, 0, true);
  s.lineTo(x + w, y + br);
  if (br) s.absarc(x + w - br, y + br, br, 0, -Math.PI / 2, true);
  s.lineTo(x + bl, y);
  if (bl) s.absarc(x + bl, y + bl, bl, -Math.PI / 2, -Math.PI, true);
  s.lineTo(x, y + h - tl);
  if (tl) s.absarc(x + tl, y + h - tl, tl, Math.PI, Math.PI / 2, true);
  return s;
}
const plate = (x, y, w, h, radii, material, z) => {
  const m = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(x, y, w, h, radii), 24), material);
  m.position.z = z;
  // Depth-only holes must be drawn before anything behind them, otherwise the
  // colour already painted there stays. renderOrder wins over material sorting.
  if (material === mats.hole) m.renderOrder = -10;
  return m;
};
function slab(x, y, w, h, radii, depth, bevel, material) {
  const geo = new THREE.ExtrudeGeometry(roundedRect(x, y, w, h, radii), {
    depth: depth - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: 0, bevelSegments: 6, curveSegments: 28,
  });
  geo.translate(0, 0, -(depth / 2 - bevel));
  return new THREE.Mesh(geo, material);
}
const cyl = (r, h, material, segs = 48) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, segs), material);
  m.rotation.x = Math.PI / 2; // axis along z
  return m;
};

/* Device --------------------------------------------------------------- */

const { W, H, HW, T, A, R, bev, bz, rs, obx, oby, ors } = SPEC;
const rig = new THREE.Group();
scene.add(rig);
const phone = new THREE.Group();
rig.add(phone);
const right = new THREE.Group();
phone.add(right);
// The folding half pivots about an axis half a hinge-gap in front of the
// display plane, so the closed stack lands at exactly 11.3 mm.
const leftPivot = new THREE.Group();
leftPivot.position.z = T / 2 + A;
phone.add(leftPivot);
const left = new THREE.Group();
left.position.z = -(T / 2 + A);
leftPivot.add(left);

// Bodies: rounded outer corners, square at the hinge; the bevel rounds the rails.
const bw = HW - bev, bh = H - 2 * bev, br = R - bev;
right.add(slab(0, -bh / 2, bw, bh, [0, br, br, 0], T, bev, mats.frame));
left.add(slab(-bw, -bh / 2, bw, bh, [br, 0, 0, br], T, bev, mats.frame));

// Front cover glass (black bezel) and inner-display wallpaper halves.
const gi = 0.7, gr = R - gi, zf = T / 2 + 0.04;
right.add(plate(0, -(H / 2 - gi), HW - gi, H - 2 * gi, [0, gr, gr, 0], mats.bezel, zf));
left.add(plate(-(HW - gi), -(H / 2 - gi), HW - gi, H - 2 * gi, [gr, 0, 0, gr], mats.bezel, zf));
const wpRight = plate(0, -(H / 2 - bz), HW - bz, H - 2 * bz, [0, rs, rs, 0], mats.wallpaper, T / 2 + 0.08);
const wpLeft = plate(-(HW - bz), -(H / 2 - bz), HW - bz, H - 2 * bz, [rs, 0, 0, rs], mats.wallpaper, T / 2 + 0.08);
right.add(wpRight);
left.add(wpLeft);

// Inner display when fully open: one continuous DOM surface across both halves.
const innerHole = plate(-(HW - bz), -(H / 2 - bz), W - 2 * bz, H - 2 * bz, [rs, rs, rs, rs], mats.hole, T / 2 + 0.3);
phone.add(innerHole);

// Back of the folding half: bezel plus the outer display.
left.add(plate(-(HW - gi), -(H / 2 - gi), HW - gi, H - 2 * gi, [gr, 0, 0, gr], mats.bezel, -(T / 2 + 0.04)));
left.add(plate(-(HW - obx), -(H / 2 - oby), HW - 2 * obx, H - 2 * oby, [ors, ors, ors, ors], mats.hole, -(T / 2 + 0.08)));

// Back of the fixed half: rear glass and the full-width camera bar.
right.add(plate(0, -(H / 2 - gi), HW - gi, H - 2 * gi, [0, gr, gr, 0], mats.glass, -(T / 2 + 0.04)));
const barW = HW - 2 * 2.6, barH = 20, barY = H / 2 - 4 - barH / 2, barD = 1.8;
const bar = slab(2.6, barY - barH / 2, barW, barH, [7.5, 7.5, 7.5, 7.5], barD, 0.6, mats.glass);
bar.position.z = -(T / 2) - barD / 2;
right.add(bar);
for (const lx of [HW - 10, HW - 26.5]) {
  const ring = cyl(7, 1.0, mats.lensRing); ring.position.set(lx, barY, -(T / 2) - barD - 0.5); right.add(ring);
  const glass = cyl(5.7, 0.5, mats.lensGlass); glass.position.set(lx, barY, -(T / 2) - barD - 1.15); right.add(glass);
  const core = cyl(2.6, 0.2, mats.lensCore, 32); core.position.set(lx, barY, -(T / 2) - barD - 1.35); right.add(core);
}
const flash = cyl(1.7, 0.3, mats.flash, 24); flash.position.set(9.6, barY + 5.2, -(T / 2) - barD - 0.1); right.add(flash);
const mic = cyl(0.6, 0.3, mats.dark, 16); mic.position.set(8.6, barY - 5.2, -(T / 2) - barD - 0.1); right.add(mic);

// Keys on the free rail of the folding half. Closed, that rail is the right
// side: volume up/down, side button with Touch ID, then Camera Control.
function addKey(top, len, proud, depth, material) {
  const k = new THREE.Mesh(new RoundedBoxGeometry(1.2, len, depth, 3, 0.35), material);
  k.position.set(-HW - proud + 0.6, H / 2 - (top + len / 2), 0);
  left.add(k);
}
addKey(24, 10, 0.85, T * 0.55, mats.key);
addKey(37, 10, 0.85, T * 0.55, mats.key);
addKey(60, 14, 0.85, T * 0.62, mats.key);
addKey(88, 20, 0.3, T * 0.5, mats.cameraKey);

// Hinge: a half-cylinder that hides inside the body when open and becomes the
// spine when closed. Geometry faces -z; rotation swings it round to -x.
const hinge = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, H - 0.8, 56, 1, false, Math.PI / 2, Math.PI), mats.frame);
phone.add(hinge);

// Displays: real DOM, placed in the same 3D space.
const sIn = SPEC.innerW / SPEC.innerVw;
const sOut = SPEC.outerW / SPEC.outerVw;
for (const [key, s, vw, vh] of [['inner', sIn, SPEC.innerVw, SPEC.innerVh], ['outer', sOut, SPEC.outerVw, SPEC.outerVh]]) {
  screens[key].style.width = vw + 'px';
  screens[key].style.height = vh + 'px';
  screens[key].style.setProperty('--mm', (1 / s).toFixed(4) + 'px');
}
const innerObj = new CSS3DObject(screens.inner);
innerObj.scale.setScalar(sIn);
innerObj.position.set(0, 0, T / 2 + 0.32);
phone.add(innerObj);
const outerObj = new CSS3DObject(screens.outer);
outerObj.scale.setScalar(sOut);
outerObj.position.set(-HW / 2, 0, -(T / 2 + 0.1));
outerObj.rotation.y = Math.PI;
left.add(outerObj);

function setFinish(c) {
  const f = FINISH[c] || FINISH.night;
  mats.frame.color.setHex(f.frame);
  mats.glass.color.setHex(f.glass);
  mats.key.color.setHex(f.key);
}

/* Sizing --------------------------------------------------------------- */

function fitStage() {
  const w = stage.clientWidth || 800;
  const h = stage.clientHeight || 450;
  if (renderer) {
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
  }
  cssRenderer.setSize(w, h);
  camera.aspect = w / h;
  const tanV = Math.tan((camera.fov * DEG) / 2);
  const distW = (W * 1.18) / 2 / (tanV * camera.aspect);
  const distH = (H * 1.6) / 2 / tanV;
  const dist = Math.max(distW, distH);
  camera.position.set(0, 0, dist);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  state.pxPerMm = h / (2 * dist * tanV);
  apply(true);
}

/* ====================================================================== */
/* Fold geometry                                                          */
/* ====================================================================== */

const v3 = new THREE.Vector3();
function toScreen(obj, x, y, z) {
  obj.updateWorldMatrix(true, false);
  v3.set(x, y, z);
  obj.localToWorld(v3);
  v3.project(camera);
  return { x: ((v3.x + 1) / 2) * stage.clientWidth, y: ((1 - v3.y) / 2) * stage.clientHeight };
}

function apply(force) {
  const fold = state.fold;
  const th = fold * DEG;
  const cos = Math.cos(th);
  const t = fold / 180;

  leftPivot.rotation.y = th;

  // Keep the visual centre of the body in the middle of the stage.
  const leftExtent = -HW * Math.max(cos, 0);
  const centre = (leftExtent + HW) / 2;
  phone.position.x = -centre;

  // Hinge morph: flush inside the body when open, 11.3 mm spine when closed.
  const hr = T / 2 + (SPEC.closedT / 2 - T / 2) * Math.pow(t, 1.4);
  hinge.scale.set(hr, 1, hr);
  hinge.position.set(3.85 * t, 0, (T / 2 + A) * t);
  hinge.rotation.y = (t * Math.PI) / 2;

  // Which display is live? The inner panel is one flat surface, so it only
  // takes over once the folding half is lying flat.
  const innerActive = fold < 0.9;
  const outerActive = fold > 174;
  if (innerActive !== state.innerActive || force) {
    state.innerActive = innerActive;
    screens.inner.classList.toggle('active', innerActive);
    innerHole.visible = innerActive;
    wpLeft.visible = wpRight.visible = !innerActive;
    if (innerActive) ensureLoaded('inner');
  }
  if (outerActive !== state.outerActive || force) {
    state.outerActive = outerActive;
    screens.outer.classList.toggle('active', outerActive);
    if (outerActive) ensureLoaded('outer');
  }

  // Floor shadow follows the footprint.
  const footprint = (HW + HW * Math.max(cos, 0)) * state.pxPerMm;
  const bottom = toScreen(phone, 0, -H / 2, 0);
  floorShadow.style.setProperty('--sw', (footprint * 1.1 + 40).toFixed(1) + 'px');
  floorShadow.style.setProperty('--sx', (bottom.x - stage.clientWidth / 2).toFixed(1) + 'px');
  floorShadow.style.setProperty('--sy', (bottom.y + 6).toFixed(1) + 'px');

  if (!state.sliderActive) range.value = fold.toFixed(1);
  rangeOut.value = Math.round(fold) + '°';
  updateReadout(fold, th);
}

function updateReadout(fold, th) {
  let label, size;
  if (fold <= 0.5) {
    label = 'Open';
    size = `${W} × ${H} × ${T} mm`;
  } else if (fold >= 179.5) {
    label = 'Closed';
    size = `${SPEC.closedW} × ${H} × ${SPEC.closedT} mm`;
  } else {
    label = state.dragging || !state.settled ? `Folding · ${Math.round(fold)}°` : `Flex mode · ${Math.round(fold)}°`;
    const w = fold <= 90 ? HW + HW * Math.cos(th) : SPEC.closedW;
    const d = fold < 90 ? T + HW * Math.sin(th) : Math.max(SPEC.closedT, T + HW * Math.sin(th));
    size = `≈ ${w.toFixed(1)} × ${H} × ${d.toFixed(1)} mm`;
  }
  ro.state.textContent = label;
  ro.size.textContent = size;
  if (state.innerActive) {
    ro.display.textContent = `Inner · 7.6″ · ${SPEC.innerPx[0]} × ${SPEC.innerPx[1]}`;
    ro.viewport.textContent = `${SPEC.innerVw} × ${SPEC.innerVh} CSS px @3x`;
  } else if (state.outerActive) {
    ro.display.textContent = `Outer · 5.4″ · ${SPEC.outerPx[0]} × ${SPEC.outerPx[1]}`;
    ro.viewport.textContent = `${SPEC.outerVw} × ${SPEC.outerVh} CSS px @3x`;
  } else {
    ro.display.textContent = 'Folding · displays sleep';
    ro.viewport.textContent = '—';
  }
}

/* ====================================================================== */
/* Animation loop                                                         */
/* ====================================================================== */

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (!state.dragging && !state.sliderActive) {
    // Spring in Apple's terms: response ≈ 0.5 s; damping ratio 1.0 by
    // default (no overshoot), 0.8 only after a gesture that carried momentum.
    const k = state.reduced ? 600 : Math.pow((2 * Math.PI) / 0.5, 2);
    const c = 2 * Math.sqrt(k) * (state.reduced ? 1 : state.zeta);
    const dx = state.fold - state.target;
    const a = -k * dx - c * state.vel;
    state.vel += a * dt;
    state.fold += state.vel * dt;
    if (state.fold < 0) { state.fold = 0; state.vel *= -0.25; }
    if (state.fold > 180) { state.fold = 180; state.vel *= -0.25; }
    if (Math.abs(state.fold - state.target) < 0.2 && Math.abs(state.vel) < 3) {
      state.fold = state.target;
      state.vel = 0;
      state.settled = true;
    } else {
      state.settled = false;
    }
    apply();
  }

  // Tilt easing. Any rubber-band overshoot relaxes back once released.
  if (!state.dragging) state.over += (0 - state.over) * Math.min(1, dt * 8);
  const ty = state.tiltTarget.y + (state.flipped ? 180 : 0) + state.over * 0.12;
  state.tilt.x += (state.tiltTarget.x - state.tilt.x) * Math.min(1, dt * 6);
  state.tilt.y += (ty - state.tilt.y) * Math.min(1, dt * 6);
  rig.rotation.x = -state.tilt.x * DEG;
  rig.rotation.y = state.tilt.y * DEG;

  if (renderer) renderer.render(scene, camera);
  cssRenderer.render(scene, camera);
  updateHint();
  requestAnimationFrame(loop);
}

function setTarget(deg, opts = {}) {
  state.target = clamp(deg, 0, 180);
  state.zeta = opts.bounce ? 0.8 : 1;
  state.settled = false;
  syncSegments();
}

function syncSegments() {
  $$('.seg [data-fold]').forEach((b) => {
    const on = Math.abs(Number(b.dataset.fold) - state.target) < 0.5;
    if (on && !b.classList.contains('active') && gsap) gsap.fromTo(b, { scale: 0.94 }, { scale: 1, duration: 0.4, ease: 'back.out(2.5)' });
    b.classList.toggle('active', on);
  });
}

/* ====================================================================== */
/* Interaction                                                            */
/* ====================================================================== */

$$('.seg [data-fold]').forEach((b) => {
  b.addEventListener('click', () => { touched(); setTarget(Number(b.dataset.fold)); });
});

range.addEventListener('pointerdown', () => { state.sliderActive = true; touched(); });
range.addEventListener('input', () => {
  state.sliderActive = true;
  state.fold = Number(range.value);
  state.target = state.fold;
  state.vel = 0;
  apply();
});
const releaseSlider = () => {
  if (!state.sliderActive) return;
  state.sliderActive = false;
  state.target = Number(range.value);
  state.settled = true;
  syncSegments();
  apply();
};
range.addEventListener('change', releaseSlider);
window.addEventListener('pointerup', releaseSlider);

$$('.seg [data-color]').forEach((b) => b.addEventListener('click', () => setColor(b.dataset.color)));
let currentColor = null;
function setColor(c) {
  if (currentColor && currentColor !== c) track('finish', { finish: c });
  currentColor = c;
  setFinish(c);
  stage.dataset.color = c;
  $$('.seg [data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === c));
  try { localStorage.setItem('duo-color', c); } catch {}
}

flipBtn.addEventListener('click', () => {
  state.flipped = !state.flipped;
  track('turn_around', { flipped: state.flipped });
  flipBtn.setAttribute('aria-pressed', String(state.flipped));
  flipBtn.textContent = state.flipped ? 'Turn back' : 'Turn around';
  touched();
});

function touched() {
  if (state.touched) return;
  state.touched = true;
  stage.classList.add('touched');
  hideHint();
}

// Drag to fold. The previewed site inside the frames stays interactive.
const drag = { active: false, id: null, startX: 0, startFold: 0, lastT: 0, moved: false, vel: 0 };
const isInteractive = (el) => !!(el && el.closest && el.closest('iframe, a, button, input, .viewer, .notice'));

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || isInteractive(e.target)) return;
  drag.active = true;
  drag.id = e.pointerId;
  drag.startX = e.clientX;
  drag.startFold = state.fold;
  drag.lastT = performance.now();
  drag.moved = false;
  drag.vel = 0;
  state.dragging = true;
  stage.classList.add('dragging');
  setCursorState('grabbing');
  stage.setPointerCapture(e.pointerId);
  touched();
});

stage.addEventListener('pointermove', (e) => {
  if (drag.active && e.pointerId === drag.id) {
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > 4) drag.moved = true;
    const travel = 2 * HW * state.pxPerMm; // the free edge travels twice the half width
    const dir = state.flipped ? -1 : 1;
    const raw = drag.startFold + (dx / travel) * 180 * dir;
    const next = clamp(raw, 0, 180);
    // Past either stop the hinge resists instead of freezing: the body yaws
    // a little with the drag, and progressively less the further you go.
    state.over = rubberband(raw - next, 180, 0.55);
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastT) / 1000;
    const v = (next - state.fold) / dt;
    drag.vel = drag.vel * 0.6 + v * 0.4;
    drag.lastT = now;
    state.fold = next;
    state.target = next;
    apply();
    return;
  }
  if (e.pointerType === 'mouse') {
    const r = stage.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    state.tiltTarget = { x: 6 - py * 10, y: -16 + px * 18 };
  }
});

const endDrag = (e) => {
  if (!drag.active || e.pointerId !== drag.id) return;
  drag.active = false;
  state.dragging = false;
  stage.classList.remove('dragging');
  setCursorState('grab');
  if (!cursorOverStage) showRing(false);
  if (!drag.moved) {
    setTarget(state.fold < 90 ? 180 : 0);
  } else {
    // Project where the momentum would carry the hinge; snap to a stop if
    // that lands near one, otherwise free-stop there like the real hinge.
    // The spring starts at the finger's velocity, so there is no seam.
    const projected = state.fold + project(drag.vel);
    let target;
    if (projected < 36) target = 0;
    else if (projected > 144) target = 180;
    else target = clamp(projected, 36, 144);
    setTarget(target, { bounce: true });
    state.vel = clamp(drag.vel, -900, 900);
  }
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('pointerleave', () => { if (!drag.active) state.tiltTarget = { x: 6, y: -16 }; });

stage.addEventListener('keydown', (e) => {
  if (e.target !== stage) return;
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setTarget(state.target < 90 ? 180 : 0); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setTarget(state.target - 10); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setTarget(state.target + 10); }
  else return;
  touched();
});

/* ====================================================================== */
/* Fold hint: shows where to grab and which way to drag                   */
/* ====================================================================== */

// Two prompts alternate: "drag to fold" at the folding half's free edge, then
// "click and scroll" in the middle of the display. Gone at the first interaction.
let hintShown = false;
let hintTl = null;
let hintPhase = 'drag';
let hintCycle = null;
const hintLabel = hint && hint.querySelector('.label');
const HINT_TEXT = { drag: 'Drag to fold', explore: 'Click & scroll to explore the site' };

function hintAnchor() {
  return hintPhase === 'drag' ? toScreen(left, -HW, 0, T / 2) : toScreen(phone, 0, 6, T / 2);
}
function startHintPhase(phase) {
  hintPhase = phase;
  hint.classList.toggle('tap', phase === 'explore');
  if (hintLabel) hintLabel.textContent = HINT_TEXT[phase];
  if (!gsap) return;
  if (hintTl) hintTl.kill();
  gsap.killTweensOf('#hint .ring');
  gsap.set('#hint .hand', { x: 0, y: 0, rotate: 0, scale: 1 });
  if (phase === 'drag') {
    hintTl = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });
    hintTl.fromTo('#hint .hand', { x: 0, rotate: -6 }, { x: 64, rotate: 4, duration: 1.1, ease: 'power2.inOut' })
      .to('#hint .hand', { x: 0, rotate: -6, duration: 0.9, ease: 'power2.inOut' }, '+=0.2');
    gsap.fromTo('#hint .ring', { scale: 0.6, opacity: 0.9 }, { scale: 1.9, opacity: 0, duration: 1.5, repeat: -1, ease: 'power1.out' });
  } else {
    // A tap: press in, ripple out, then a short scroll nudge.
    hintTl = gsap.timeline({ repeat: -1, repeatDelay: 0.5 });
    hintTl.to('#hint .hand', { scale: 0.82, duration: 0.18, ease: 'power2.in' })
      .to('#hint .hand', { scale: 1, duration: 0.35, ease: 'back.out(3)' })
      .fromTo('#hint .ring', { scale: 0.3, opacity: 0.9 }, { scale: 2.1, opacity: 0, duration: 0.9, ease: 'power1.out' }, '<')
      .to('#hint .hand', { y: -26, duration: 0.7, ease: 'power2.inOut' }, '+=0.3')
      .to('#hint .hand', { y: 0, duration: 0.6, ease: 'power2.inOut' }, '+=0.15');
  }
  // Fade the label between phases.
  gsap.fromTo('#hint .label', { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: 0.4 });
  hintCycle = gsap.delayedCall(phase === 'drag' ? 5 : 6, () => startHintPhase(phase === 'drag' ? 'explore' : 'drag'));
}
function updateHint() {
  if (!hint || state.touched || state.reduced) return;
  const ready = state.settled && state.fold < 1 && !state.flipped;
  if (!ready) { if (hintShown) hideHint(); return; }
  const p = hintAnchor();
  hint.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
  if (!hintShown) {
    hintShown = true;
    hint.hidden = false;
    if (gsap) {
      gsap.set(hint, { opacity: 0 });
      gsap.to(hint, { opacity: 1, duration: 0.5, delay: 0.4 });
      gsap.delayedCall(0.4, () => { if (hintShown) startHintPhase('drag'); });
    } else {
      hint.style.opacity = 1;
      startHintPhase('drag');
    }
  }
}
function hideHint() {
  if (!hint || !hintShown) return;
  hintShown = false;
  if (hintTl) { hintTl.kill(); hintTl = null; }
  if (hintCycle) { hintCycle.kill(); hintCycle = null; }
  if (gsap) gsap.to(hint, { opacity: 0, duration: 0.3, onComplete: () => { hint.hidden = true; gsap.killTweensOf('#hint .ring'); } });
  else hint.hidden = true;
}
// Entering the previewed site counts as exploring it.
for (const fr of Object.values(frames)) fr.addEventListener('pointerenter', touched);

/* ====================================================================== */
/* Custom cursor                                                          */
/* ====================================================================== */

// The browser's own cursor is used everywhere except over the device itself,
// where a ring with drag arrows takes over (and the site inside stays native).
const finePointer = window.matchMedia('(pointer: fine)').matches;
let cursorState = 'grab';
let cursorOverStage = false;
const cur = { x: -100, y: -100, tx: -100, ty: -100 };
function setCursorState(s) {
  if (!cursorEl || s === cursorState) return;
  cursorEl.classList.remove('is-' + cursorState);
  cursorState = s;
  cursorEl.classList.add('is-' + s);
  const scale = s === 'grabbing' ? 0.85 : 1;
  if (gsap) gsap.to(cursorEl, { scale, duration: 0.3, ease: 'back.out(2)' });
}
function showRing(on) {
  if (!cursorEl) return;
  cursorEl.classList.toggle('is-shown', on);
  stage.classList.toggle('ring-cursor', on);
}
if (cursorEl && finePointer) {
  cursorEl.classList.add('is-grab');
  window.addEventListener('pointermove', (e) => {
    cur.tx = e.clientX; cur.ty = e.clientY;
    if (state.dragging) return;
    const t = e.target;
    const over = !!(t && t.closest && t.closest('#stage')) && !isInteractive(t);
    if (over && !cursorOverStage) { cur.x = cur.tx; cur.y = cur.ty; }
    cursorOverStage = over;
    showRing(over);
    setCursorState('grab');
  }, { passive: true });
  stage.addEventListener('pointerleave', () => { if (!state.dragging) { cursorOverStage = false; showRing(false); } });
  const followCursor = () => {
    const k = state.reduced ? 1 : 0.35;
    cur.x += (cur.tx - cur.x) * k;
    cur.y += (cur.ty - cur.y) * k;
    cursorEl.style.translate = `${cur.x.toFixed(1)}px ${cur.y.toFixed(1)}px`;
    requestAnimationFrame(followCursor);
  };
  requestAnimationFrame(followCursor);
}

/* ====================================================================== */
/* Clock                                                                  */
/* ====================================================================== */

function tickClock() {
  const d = new Date();
  let h = d.getHours() % 12; if (h === 0) h = 12;
  const time = `${h}:${String(d.getMinutes()).padStart(2, '0')}`;
  const date = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $$('[data-time]').forEach((el) => { el.textContent = time; });
  $$('[data-date]').forEach((el) => { el.textContent = date; });
}
tickClock();
setInterval(tickClock, 15000);

/* ====================================================================== */
/* URL tester                                                             */
/* ====================================================================== */

const form = $('#url-form');
const input = $('#url-input');
const clearBtn = $('#url-clear');
const testBtn = $('#test-btn');
const verdict = $('#verdict');
const verdictTitle = $('#verdict-title');
const verdictDetail = $('#verdict-detail');
const verdictChips = $('#verdict-chips');

const site = { token: 0, url: null, src: null, proxied: false, result: null, unverified: false, loadedAt: {}, startedAt: 0, watchdog: null, lastInput: '' };

// How to load a site: 'auto' falls back to the rendering proxy when a site
// refuses to be embedded, 'direct' never proxies, 'proxy' always does.
const modeBox = $('#mode');
const modeHint = $('#mode-hint');
const PROXY_URL = API_URL ? API_URL.replace(/check$/, 'proxy') : '';
let mode = 'auto';
try { mode = localStorage.getItem('duo-mode') || 'auto'; } catch {}
if (!['auto', 'direct', 'proxy'].includes(mode)) mode = 'auto';
const MODE_HINTS = {
  auto: 'Sites that refuse embedding are rendered through this site’s proxy.',
  direct: 'Loads the site exactly as a browser would. Sites that refuse embedding show a notice.',
  proxy: 'Always renders through this site’s proxy. Works for almost any site; logins and some scripts may not.',
};
function setMode(m) {
  mode = m;
  $$('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  modeHint.textContent = MODE_HINTS[m];
  try { localStorage.setItem('duo-mode', m); } catch {}
}
$$('[data-mode]').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); if (site.lastInput) run(site.lastInput); }));
if (!PROXY_URL) modeBox.hidden = true; else setMode(mode);

input.addEventListener('input', () => { clearBtn.hidden = !input.value; });
clearBtn.addEventListener('click', () => { input.value = ''; clearBtn.hidden = true; input.focus(); });
form.addEventListener('submit', (e) => { e.preventDefault(); run(input.value); });

function normalizeClient(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch { return null; }
}

function setScreens(stateName, payload) {
  for (const key of ['inner', 'outer']) {
    const sc = screens[key];
    sc.dataset.state = stateName;
    if (payload) {
      $('.notice-title', sc).textContent = payload.title || '';
      $('.notice-text', sc).innerHTML = payload.html || '';
      const link = $('.notice-link', sc);
      if (payload.href) { link.href = payload.href; link.hidden = false; } else { link.hidden = true; }
    }
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Analytics events (no-op when gtag is absent or blocked).
function track(name, params) {
  try { if (typeof gtag === 'function') gtag('event', name, params); } catch {}
}

function setVerdict(kind, title, detailHtml, chips) {
  verdict.hidden = false;
  if (kind !== 'checking' && verdict.dataset.kind !== kind) {
    track('verdict', { kind, host: site.url ? new URL(site.url).hostname : undefined, mode, proxied: site.proxied });
    if (gsap) gsap.fromTo(verdict, { y: 6, opacity: 0.6 }, { y: 0, opacity: 1, duration: 0.4, ease: 'power2.out' });
  }
  verdict.dataset.kind = kind;
  verdictTitle.textContent = title;
  verdictDetail.innerHTML = detailHtml || '';
  verdictChips.innerHTML = '';
  (chips || []).forEach(([label, value]) => {
    const el = document.createElement('span');
    el.className = 'chip';
    if (value === undefined) el.textContent = label;
    else { el.innerHTML = `<b></b> `; el.firstChild.textContent = label; el.append(String(value)); }
    verdictChips.appendChild(el);
  });
}

async function run(raw) {
  const u = normalizeClient(raw);
  if (!u) {
    setVerdict('error', 'That does not look like a web address', 'Try something like <code>example.com</code> or a full <code>https://</code> URL.');
    input.focus();
    return;
  }
  const token = ++site.token;
  site.lastInput = raw;
  track('test_url', { host: u.hostname, mode });
  site.url = null;
  site.result = null;
  site.unverified = false;
  clearTimeout(site.watchdog);
  input.value = u.href.replace(/^https:\/\//, '').replace(/\/$/, '');
  clearBtn.hidden = false;
  testBtn.disabled = true;
  setScreens('checking', { title: '', html: '', href: null });
  setVerdict('checking', `Checking ${u.hostname}…`, 'Fetching the page headers to see whether it can be shown inside another site.');
  try { history.replaceState(null, '', `?url=${encodeURIComponent(u.href)}`); } catch {}

  let result = null;
  let apiMissing = !API_URL;
  if (API_URL) try {
    const r = await fetch(`${API_URL}?url=${encodeURIComponent(String(raw).trim())}`, { headers: { accept: 'application/json' } });
    const isJson = (r.headers.get('content-type') || '').includes('json');
    if (!isJson) apiMissing = true;
    else {
      result = await r.json();
      if (token !== site.token) return;
      if (!r.ok || result.error) {
        testBtn.disabled = false;
        showError(u, result.error || 'Unexpected error.');
        return;
      }
    }
  } catch {
    apiMissing = true;
  }
  if (token !== site.token) return;
  testBtn.disabled = false;

  if (apiMissing) {
    site.unverified = true;
    load(u.href);
    setVerdict('unknown', `Loading ${u.hostname} without a header check`,
      'This host cannot inspect the site’s headers, so the site is loaded directly. If the screen stays blank, the site refuses to be embedded (X-Frame-Options or CSP).');
    return;
  }

  site.result = result;
  const finalHost = new URL(result.url).hostname;
  const useProxy = !!PROXY_URL && (mode === 'proxy' || (mode === 'auto' && !result.embeddable));
  if (!result.embeddable && !useProxy) {
    showBlocked(result, finalHost);
    return;
  }
  load(result.url, useProxy);
  const kind = result.ok ? 'checking' : 'warn';
  const how = useProxy
    ? (result.embeddable ? 'Rendering through the proxy as requested.' : `The site sends <code>${esc(result.reason)}</code>, so it is rendered through this site’s proxy instead.`)
    : 'Headers allow embedding. Waiting for the page to render on the device.';
  setVerdict(kind, result.ok ? `Loading ${finalHost}…` : `${finalHost} responds with HTTP ${result.status}`,
    result.ok ? how : 'The server returned an error status. Rendering whatever it sent.',
    chipsFor(result));
}

function chipsFor(result, extra) {
  const chips = [];
  chips.push(['HTTP', `${result.status}${result.statusText ? ' ' + result.statusText : ''}`]);
  chips.push(['Headers', `${result.timeMs} ms`]);
  if (extra && extra.renderMs != null) chips.push(['Rendered in', `${extra.renderMs} ms`]);
  if (result.redirects && result.redirects.length) {
    chips.push([`${result.redirects.length} redirect${result.redirects.length > 1 ? 's' : ''} →`, new URL(result.url).host]);
  }
  if (result.contentType) chips.push(['Type', result.contentType.split(';')[0]]);
  if (result.headers && result.headers.xFrameOptions) chips.push(['X-Frame-Options', result.headers.xFrameOptions]);
  if (result.headers && result.headers.contentSecurityPolicy) {
    const fa = /frame-ancestors[^;]*/i.exec(result.headers.contentSecurityPolicy);
    if (fa) chips.push(['CSP', fa[0].trim()]);
  }
  if (result.headers && result.headers.server) chips.push(['Server', result.headers.server]);
  return chips;
}

function showBlocked(result, host) {
  site.url = null;
  const title = 'Can’t be shown here';
  const html = `<code>${esc(host)}</code> sends <code>${esc(result.reason)}</code>, which tells browsers not to display it inside another site. It is reachable (HTTP ${esc(result.status)}) — it just refuses to be embedded, so it can’t be previewed on this device.`;
  setScreens('blocked', { title, html, href: result.url });
  setVerdict('blocked', `${host} works, but refuses to be embedded`,
    `The site responds normally, but its <code>${esc(result.reason)}</code> header blocks framing. ${PROXY_URL ? 'Switch Load to <b>Auto</b> or <b>Proxied</b> to render it through this site’s proxy, or ' : 'That is a deliberate security choice by the site, so it cannot be previewed here. '}<a href="${esc(result.url)}" target="_blank" rel="noopener noreferrer">open it in a new tab</a>.`,
    chipsFor(result));
}

function showError(u, message) {
  site.url = null;
  setScreens('error', { title: 'Couldn’t reach it', html: esc(message), href: u.href });
  setVerdict('error', `${u.hostname} is not working`, esc(message) + ` <a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">Try it in a new tab</a>.`);
}

function load(url, proxied = false) {
  site.url = url;
  site.proxied = !!proxied;
  site.src = proxied ? `${PROXY_URL}?url=${encodeURIComponent(url)}` : url;
  site.loadedAt = {};
  site.startedAt = performance.now();
  for (const key of ['inner', 'outer']) frames[key].dataset.src = '';
  setScreens('loading', { title: '', html: '', href: null });
  ensureLoaded('inner');
  ensureLoaded('outer');
  clearTimeout(site.watchdog);
  site.watchdog = setTimeout(() => {
    if (!site.url) return;
    if (Object.keys(site.loadedAt).length === 0) {
      setVerdict('warn', 'Still loading…',
        'The page has not finished rendering after 20 seconds. It may be very slow, or it may be blocking frames with a script rather than a header.',
        site.result ? chipsFor(site.result) : []);
    }
  }, 20000);
}

// Load the current URL into a display's frame the first time that display is shown.
function ensureLoaded(key) {
  if (!site.url) return;
  const active = key === 'inner' ? state.innerActive : state.outerActive;
  if (!active) return;
  const fr = frames[key];
  if (fr.dataset.src === site.src) return;
  fr.dataset.src = site.src;
  screens[key].dataset.state = 'loading';
  fr.src = site.src;
}

// A host whose own Content-Security-Policy forbids embedding other sites
// (frame-src) reports the block here rather than in the frame.
let hostBlocked = false;
document.addEventListener('securitypolicyviolation', (e) => {
  if (!/^(frame|child)-src$/.test(e.violatedDirective) || !site.url) return;
  if (!e.blockedURI || !e.blockedURI.startsWith(new URL(site.url).origin)) return;
  hostBlocked = true;
  const host = new URL(site.url).hostname;
  site.url = null;
  setScreens('error', {
    title: 'This host can’t embed sites',
    html: `The page you are viewing is hosted somewhere whose security policy forbids embedding other websites, so <code>${esc(host)}</code> cannot be shown on the device here. Run the full version from the repository to test it.`,
    href: null,
  });
  setVerdict('error', 'Preview blocked by this host, not by the site',
    `This hosted copy is not allowed to embed other websites at all. It says nothing about <code>${esc(host)}</code>. Run the full version (see the repository README) to get a real verdict.`);
});

for (const key of ['inner', 'outer']) {
  frames[key].addEventListener('load', () => {
    const fr = frames[key];
    if (hostBlocked || !site.url || fr.dataset.src !== site.src) return;
    if (site.proxied) {
      // Proxied documents are same-origin, so the proxy's own error pages
      // can be recognised and shown as a device notice.
      let err = null;
      try { err = fr.contentDocument && fr.contentDocument.documentElement.dataset.duoError; } catch {}
      if (err) {
        const u = new URL(site.url);
        const s = site.result;
        setScreens('error', { title: 'Couldn’t render it', html: esc(err), href: site.url });
        setVerdict('error', `${u.hostname} could not be rendered`, esc(err) + (s ? ` The site itself answered HTTP ${s.status} to the header check.` : ''), s ? chipsFor(s) : []);
        site.url = null;
        return;
      }
    }
    screens[key].dataset.state = 'live';
    const first = Object.keys(site.loadedAt).length === 0;
    site.loadedAt[key] = performance.now();
    if (!first) return;
    const renderMs = Math.round(site.loadedAt[key] - site.startedAt);
    const host = new URL(site.url).hostname;
    if (site.unverified) {
      setVerdict('unknown', `${host} loaded (unverified)`,
        'The frame finished loading, but without the header check this page cannot tell a real page from a browser “refused to connect” screen. Check the display.',
        [['Rendered in', `${renderMs} ms`]]);
    } else if (site.result) {
      const r = site.result;
      const where = `on the ${state.innerActive ? '7.6″ inner' : '5.4″ outer'} display. Fold the device to see it on the other screen.`;
      const via = site.proxied
        ? (r.embeddable ? `Rendered through the proxy ${where}` : `The site refuses to be embedded (<code>${esc(r.reason)}</code>), so it was rendered through this site’s proxy ${where} Logins and some scripts may not work in this mode.`)
        : `Headers allow embedding and the page rendered ${where}`;
      setVerdict(r.ok ? 'ok' : 'warn',
        r.ok ? `${host} works on iPhone Duo${site.proxied ? ' (via proxy)' : ''}` : `${host} renders, but with HTTP ${r.status}`,
        r.ok ? via : 'The page rendered, but the server reported an error status.',
        chipsFor(r, { renderMs }));
    }
  });
}

/* ====================================================================== */
/* Page motion: entrance and scroll reveals                               */
/* ====================================================================== */

function pageMotion() {
  if (!gsap || state.reduced) return;
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  tl.from('.top', { y: -12, opacity: 0, duration: 0.6 })
    .from('.hero > .eyebrow', { y: 14, opacity: 0, duration: 0.6 }, '-=0.3')
    .from('.hero h1', { y: 22, opacity: 0, duration: 0.8 }, '-=0.4')
    .from('.hero .lede', { y: 16, opacity: 0, duration: 0.6 }, '-=0.5')
    .from('.urlbar', { y: 16, opacity: 0, duration: 0.6 }, '-=0.4')
    .from('.mode', { opacity: 0, duration: 0.5 }, '-=0.3')
    .from('.controls > *', { y: 10, opacity: 0, duration: 0.5, stagger: 0.06 }, '-=0.3')
    .from('#stage', { scale: 0.96, duration: 0.9, ease: 'power2.out' }, '-=0.5');

  if (window.ScrollTrigger) {
    gsap.from('.readout > div', { scrollTrigger: { trigger: '.readout', start: 'top 88%', once: true }, y: 20, opacity: 0, duration: 0.6, stagger: 0.08, ease: 'power2.out' });
    gsap.from('.specs .kicker, .specs h2, .specs-lede', { scrollTrigger: { trigger: '.specs', start: 'top 80%', once: true }, y: 24, opacity: 0, duration: 0.7, stagger: 0.1, ease: 'power3.out' });
    $$('.tile').forEach((tile, i) => {
      gsap.from(tile, { scrollTrigger: { trigger: tile, start: 'top 90%', once: true }, y: 28, opacity: 0, duration: 0.7, delay: (i % 3) * 0.08, ease: 'power3.out' });
    });
    gsap.from('footer > *', { scrollTrigger: { trigger: 'footer', start: 'top 95%', once: true }, y: 12, opacity: 0, duration: 0.5, stagger: 0.08 });
  }
}

/* ====================================================================== */
/* Boot                                                                   */
/* ====================================================================== */

try { setColor(localStorage.getItem('duo-color') || 'night'); } catch { setColor('night'); }
// Debug handle (read-only use): inspect fold state and the scene from the console.
window.__duo = { state, scene, camera, hintState: () => ({ hintShown, touched: state.touched, settled: state.settled, fold: state.fold, flipped: state.flipped, reduced: state.reduced, gsap: !!gsap }) };
syncSegments();
fitStage();
window.addEventListener('resize', fitStage);
requestAnimationFrame((t) => { last = t; loop(t); });
pageMotion();

const params = new URLSearchParams(location.search);
// Site shown on arrival when no ?url= is given.
const DEFAULT_URL = 'jayeshbidani.com';
const initial = params.get('url') || DEFAULT_URL;
if (initial) { input.value = initial; clearBtn.hidden = false; }

// Opening demo.
setTimeout(() => {
  setTarget(0);
  if (initial) run(initial);
}, state.reduced ? 100 : 900);
