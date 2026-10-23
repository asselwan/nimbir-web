// Nimbir hero object: a claim's path back to payment along the 835.
// prm_4594c690-0d04-4a04-bac9-a85de3164443 (D-0web3d-nimbir). Position is data, vector is verdict:
// the ribbon is the claim's trajectory (billed -> denied -> appealed -> paid on the 835), the
// ghost line is where it ends with no appeal, and the bracket between them is the recovery vector.
import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Vector3, Quaternion, Color,
  CatmullRomCurve3, TubeGeometry, ConeGeometry, SphereGeometry, CircleGeometry,
  BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, LineBasicMaterial,
  LineDashedMaterial, Line, LineSegments, Points, ShaderMaterial, NormalBlending,
} from 'three';

const C = {
  teal: new Color('#126e68'), mint: new Color('#3fbf8f'), rose: new Color('#c4475b'),
  coral: new Color('#e8735a'), ink: new Color('#17242c'), line: new Color('#cdd8d3'),
};

// Stations, left to right. y is the revenue position of the line.
const S = [
  new Vector3(-4.1, 0.7, 0.0),   // billed
  new Vector3(-0.9, -1.0, 0.35), // denied (CARC on the 835)
  new Vector3(1.2, -0.25, -0.2), // appealed
  new Vector3(3.9, 0.7, 0.0),    // paid on the 835
];
const PATH = new CatmullRomCurve3([
  S[0], new Vector3(-2.5, 0.72, 0.15), S[1], new Vector3(0.1, -0.85, 0.2), S[2],
  new Vector3(2.6, 0.45, -0.1), S[3],
], false, 'catmullrom', 0.35);
const GHOST = new CatmullRomCurve3([S[1], new Vector3(1.4, -1.12, 0.3), new Vector3(3.9, -1.15, 0.0)]);
const T_DENY = 0.38, T_APPEAL = 0.62; // curve params near the denial and appeal stations

function colorAt(t, out) {
  if (t < T_DENY - 0.12) return out.copy(C.teal);
  if (t < T_DENY) return out.copy(C.teal).lerp(C.rose, (t - (T_DENY - 0.12)) / 0.12);
  if (t < T_APPEAL) return out.copy(C.rose).lerp(C.coral, (t - T_DENY) / (T_APPEAL - T_DENY));
  return out.copy(C.coral).lerp(C.mint, Math.min(1, (t - T_APPEAL) / 0.18));
}

export function mount(root) {
  const stage = root.querySelector('.w3d-stage');
  const canvas = stage.querySelector('canvas');
  const labels = [...stage.querySelectorAll('[data-k]')];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (e) { root.dataset.mode = 'poster'; return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

  const scene = new Scene();
  const cam = new PerspectiveCamera(34, 2, 0.1, 60);
  const world = new Group();
  scene.add(world);

  // Ledger floor: a quiet grid the path is pinned to.
  const FLOOR = -1.6, grid = [];
  for (let x = -5; x <= 5.001; x += 0.5) grid.push(x, FLOOR, -1.6, x, FLOOR, 1.6);
  for (let z = -1.6; z <= 1.601; z += 0.4) grid.push(-5, FLOOR, z, 5, FLOOR, z);
  const gridGeo = new BufferGeometry();
  gridGeo.setAttribute('position', new Float32BufferAttribute(grid, 3));
  world.add(new LineSegments(gridGeo, new LineBasicMaterial({ color: C.line, transparent: true, opacity: 0.55 })));

  // The claim's trajectory: a ribbon coloured by state.
  const tube = new TubeGeometry(PATH, 260, 0.045, 10, false);
  const tc = [], tmp = new Color(), uv = tube.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) { colorAt(uv.getX(i), tmp); tc.push(tmp.r, tmp.g, tmp.b); }
  tube.setAttribute('color', new Float32BufferAttribute(tc, 3));
  world.add(new Mesh(tube, new MeshBasicMaterial({ vertexColors: true })));

  // Where the line ends with nobody working it: write-off, dashed and faded.
  const ghost = new Line(new BufferGeometry().setFromPoints(GHOST.getPoints(80)),
    new LineDashedMaterial({ color: C.rose, dashSize: 0.12, gapSize: 0.09, transparent: true, opacity: 0.8 }));
  ghost.computeLineDistances();
  world.add(ghost);

  // Recovery vector: from the write-off end up to the paid end.
  const vTop = S[3].clone().add(new Vector3(0.55, 0, 0)), vBot = new Vector3(vTop.x, -1.15, 0);
  const vec = new Line(new BufferGeometry().setFromPoints([vBot, vTop.clone().add(new Vector3(0, -0.2, 0))]),
    new LineBasicMaterial({ color: C.ink }));
  world.add(vec);
  const vHead = new Mesh(new ConeGeometry(0.08, 0.22, 16), new MeshBasicMaterial({ color: C.ink }));
  vHead.position.copy(vTop).add(new Vector3(0, -0.1, 0));
  world.add(vHead);

  // Direction of travel at the paid end.
  const head = new Mesh(new ConeGeometry(0.12, 0.34, 20), new MeshBasicMaterial({ color: C.mint }));
  head.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), PATH.getTangentAt(1).normalize());
  head.position.copy(S[3]).addScaledVector(PATH.getTangentAt(1), 0.12);
  world.add(head);

  // Stations: a bead on the path, a pin down to the ledger, a shadow disc.
  const pinMat = new LineBasicMaterial({ color: C.ink, transparent: true, opacity: 0.25 });
  const stationCol = [C.teal, C.rose, C.coral, C.mint];
  S.forEach((p, i) => {
    const bead = new Mesh(new SphereGeometry(0.11, 20, 14), new MeshBasicMaterial({ color: stationCol[i] }));
    bead.position.copy(p); world.add(bead);
    world.add(new Line(new BufferGeometry().setFromPoints([p, new Vector3(p.x, FLOOR, p.z)]), pinMat));
    const disc = new Mesh(new CircleGeometry(0.2, 28), new MeshBasicMaterial({ color: stationCol[i], transparent: true, opacity: 0.18 }));
    disc.rotation.x = -Math.PI / 2; disc.position.set(p.x, FLOOR + 0.002, p.z); world.add(disc);
  });

  // Remittance dollars travelling the path. Lookup table keeps the per-frame cost flat.
  const N = 90, LUT = 600, lut = PATH.getSpacedPoints(LUT);
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
  const u = new Float32Array(N), spd = new Float32Array(N), off = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    u[i] = i / N; spd[i] = 0.045 + ((i * 37) % 11) / 400;
    off[i * 2] = (((i * 53) % 17) / 17 - 0.5) * 0.12; off[i * 2 + 1] = (((i * 29) % 13) / 13 - 0.5) * 0.12;
    size[i] = 5 + ((i * 7) % 4);
  }
  const pg = new BufferGeometry();
  pg.setAttribute('position', new Float32BufferAttribute(pos, 3));
  pg.setAttribute('color', new Float32BufferAttribute(col, 3));
  pg.setAttribute('size', new Float32BufferAttribute(size, 1));
  const pmat = new ShaderMaterial({
    transparent: true, depthWrite: false, blending: NormalBlending,
    uniforms: { uPR: { value: renderer.getPixelRatio() } },
    vertexShader: 'attribute float size;attribute vec3 color;varying vec3 vC;uniform float uPR;void main(){vC=color;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=size*uPR*(9.0/-mv.z);gl_Position=projectionMatrix*mv;}',
    fragmentShader: 'varying vec3 vC;void main(){float d=length(gl_PointCoord-0.5);float a=1.0-smoothstep(0.38,0.5,d);if(a<0.01)discard;gl_FragColor=vec4(vC,a);}',
  });
  const dots = new Points(pg, pmat);
  world.add(dots);
  const pa = pg.getAttribute('position'), ca = pg.getAttribute('color');

  function placeDots(dt) {
    for (let i = 0; i < N; i++) {
      // Lines slow down in the denial trough and speed up once the appeal lands.
      const t = u[i], drag = t > T_DENY - 0.05 && t < T_APPEAL ? 0.45 : 1;
      u[i] = (t + spd[i] * dt * drag) % 1; if (!(u[i] >= 0)) u[i] = 0;
      const p = lut[Math.floor(u[i] * LUT)];
      pa.setXYZ(i, p.x, p.y + off[i * 2], p.z + off[i * 2 + 1]);
      colorAt(u[i], tmp); ca.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    pa.needsUpdate = true; ca.needsUpdate = true;
  }

  // Camera, labels, sizing.
  const proj = new Vector3();
  let W = 0, H = 0, narrow = false;
  function resize() {
    const r = stage.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height); narrow = W < 560;
    renderer.setSize(W, H, false);
    cam.aspect = W / H;
    cam.position.set(0, narrow ? 1.5 : 1.2, narrow ? 12.8 : 8.6);
    cam.lookAt(0, -0.2, 0);
    cam.updateProjectionMatrix();
  }
  function placeLabels() {
    labels.forEach((el) => {
      const k = +el.dataset.k;
      const p = k < 4 ? S[k] : new Vector3(vTop.x, (vTop.y + vBot.y) / 2, 0);
      proj.copy(p).applyMatrix4(world.matrixWorld).project(cam);
      el.style.transform = `translate(${((proj.x + 1) / 2) * W}px,${((1 - proj.y) / 2) * H}px)`;
    });
  }

  let tx = 0, ty = 0, rx = 0, ry = 0;
  if (!reduce) stage.addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width - 0.5) * 0.35;
    ty = ((e.clientY - r.top) / r.height - 0.5) * 0.12;
  });

  let visible = true, last = performance.now(), raf = 0, clock = 0;
  function frame(now) {
    raf = 0;
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now; clock += dt;
    rx += (tx - rx) * 0.06; ry += (ty - ry) * 0.06;
    world.rotation.y = -0.22 + rx + Math.sin(clock * 0.25) * 0.05;
    world.rotation.x = 0.06 + ry;
    placeDots(dt);
    world.updateMatrixWorld();
    renderer.render(scene, cam);
    placeLabels();
    if (visible && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function wake() { if (!raf && visible && !document.hidden && !reduce) { last = performance.now(); raf = requestAnimationFrame(frame); } }

  resize();
  if (reduce) {
    // Static render: dots spread along the path, no motion.
    world.rotation.set(0.06, -0.22, 0);
    placeDots(0); world.updateMatrixWorld(); renderer.render(scene, cam); placeLabels();
    root.dataset.mode = 'static';
  } else {
    root.dataset.mode = 'live';
    wake();
  }
  new ResizeObserver(() => { resize(); if (reduce) { renderer.render(scene, cam); placeLabels(); } }).observe(stage);
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; wake(); }).observe(stage);
  document.addEventListener('visibilitychange', wake);
}
