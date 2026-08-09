// Renderer, lights, cameras and the view presets.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { derived } from './build.js';

// 35mm-equivalent focal length -> vertical FOV, assuming a 36x24mm frame.
export const focalToFov = (mm) => 2 * Math.atan(24 / (2 * mm)) * 180 / Math.PI;

/** The eight corners of the home's overall bounding box, overhangs included. */
function boxCorners(dim, d) {
  const hx = dim.lengthFt / 2 + dim.rakeOverhangFt;
  const hz = dim.widthFt / 2 + dim.eaveOverhangFt;
  const out = [];
  for (const x of [-hx, hx]) {
    for (const y of [0, d.ridgeY]) {
      for (const z of [-hz, hz]) out.push(new THREE.Vector3(x, y, z));
    }
  }
  return out;
}

export class Stage {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();

    this.persp = new THREE.PerspectiveCamera(50, 1, 0.5, 4000);
    this.ortho = new THREE.OrthographicCamera(-50, 50, 30, -30, -2000, 4000);
    this.camera = this.persp;

    this.controls = new OrbitControls(this.persp, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.005; // never go below grade

    this.orthoControls = new OrbitControls(this.ortho, canvas);
    this.orthoControls.enableDamping = true;
    this.orthoControls.enabled = false;

    // Once the user drags the camera themselves, presets stop re-fitting the
    // frame on export — their framing is the intent, not the preset's.
    this.userMoved = false;
    const touched = () => { this.userMoved = true; };
    this.controls.addEventListener('start', touched);
    this.orthoControls.addEventListener('start', touched);

    this.buildEnvironment();
  }

  buildEnvironment() {
    this.hemi = new THREE.HemisphereLight(0xcfd8e3, 0x6a6357, 1.0);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff4e6, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    // World units are feet, so the normal bias has to be generous or the eave
    // and gable-end grazing angles show shadow acne.
    this.sun.shadow.normalBias = 0.3;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.fill = new THREE.DirectionalLight(0xdfe7f2, 0.35);
    this.fill.position.set(-40, 30, -60);
    this.scene.add(this.fill);

    const groundMat = new THREE.ShadowMaterial({ opacity: 0.26 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(400, 80, 0x4a525d, 0x30363e);
    this.grid.position.y = -0.005;
    this.scene.add(this.grid);

    this.planGroup = new THREE.Group();
    this.scene.add(this.planGroup);

    this.homeGroup = new THREE.Group();
    this.scene.add(this.homeGroup);
  }

  /**
   * Where the ground-plane horizon lands in the frame, as a fraction from the
   * top edge. This is the one measurement that tells you whether the massing's
   * camera actually matches the site photo's camera: line this up with the
   * horizon in the photo and the ground planes agree, so the home sits on the
   * lot instead of floating over it.
   *
   * Null for the orthographic elevations, which have no vanishing point, and
   * when the horizon falls well outside the frame.
   */
  horizonFraction() {
    if (this.camera !== this.persp) return null;
    const cam = this.persp;
    cam.updateMatrixWorld(true);

    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-9) return null; // straight down: no horizon in frame
    fwd.normalize();

    // A point at the camera's own height, effectively at infinity, projects to
    // the vanishing point of every horizontal direction — i.e. the horizon.
    const far = cam.position.clone().addScaledVector(fwd, 1e6);
    const ndcY = far.project(cam).y;
    if (!isFinite(ndcY)) return null;

    const t = (1 - ndcY) / 2;
    return t < -0.5 || t > 1.5 ? null : t;
  }

  applySceneOpts(o, dim) {
    const az = THREE.MathUtils.degToRad(o.sunAz);
    const el = THREE.MathUtils.degToRad(o.sunEl);
    const r = Math.max(dim.lengthFt, dim.widthFt) * 2.2 + 40;
    this.sun.position.set(
      Math.cos(el) * Math.sin(az) * r,
      Math.sin(el) * r,
      Math.cos(el) * Math.cos(az) * r,
    );
    this.sun.target.position.set(0, dim.floorHeightFt, 0);

    // Overcast mix: trade the hard sun for ambient sky.
    this.sun.intensity = THREE.MathUtils.lerp(2.6, 0.55, o.flat);
    this.hemi.intensity = THREE.MathUtils.lerp(0.55, 1.85, o.flat);
    this.fill.intensity = THREE.MathUtils.lerp(0.2, 0.5, o.flat);
    this.ground.material.opacity = THREE.MathUtils.lerp(0.34, 0.08, o.flat);
    this.sun.castShadow = o.shadow;

    // Keep the shadow frustum tight to the home; a frustum sized to the light's
    // distance wastes texels and shows acne along the eave.
    const s = this.sun.shadow.camera;
    const half = Math.max(dim.lengthFt, dim.widthFt) * 0.8 + 8;
    s.left = -half; s.right = half; s.top = half; s.bottom = -half;
    s.near = 1; s.far = r * 3;
    s.updateProjectionMatrix();

    const blockLandscape = !!o.blockLandscape;
    this.ground.visible = o.grid && !blockLandscape;
    this.grid.visible = o.grid && !blockLandscape;
    this.scene.background = o.bgVisible === false ? null : new THREE.Color(o.bg);
    this.persp.fov = focalToFov(o.focal);
    this.persp.updateProjectionMatrix();
    this.setWireframe(o.wireframe);
  }

  setWireframe(enabled) {
    if (!this.homeGroup) return;
    const wf = !!enabled;
    this.homeGroup.traverse((o) => {
      if (o.isMesh && o.material) {
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of list) {
          m.wireframe = wf;
        }
      }
    });
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this._aspect = w / h;
    this.reframeOrtho();
    this.refit();
  }

  /**
   * Re-derive the ortho frustum from the stored fit box and the current aspect.
   * Storing the box rather than a half-height is what keeps the exported PNG
   * framed the same as the viewport when their aspect ratios differ.
   */
  reframeOrtho() {
    const fit = this._orthoFit;
    if (!fit) return;
    const a = this._aspect || 1;
    const hh = Math.max(fit.h / 2, (fit.w / 2) / a) * fit.pad;
    this.ortho.top = hh; this.ortho.bottom = -hh;
    this.ortho.left = -hh * a; this.ortho.right = hh * a;
    this.ortho.updateProjectionMatrix();
  }

  useOrtho(on) {
    this.camera = on ? this.ortho : this.persp;
    this.controls.enabled = !on;
    this.orthoControls.enabled = on;
  }

  /**
   * Move the camera to a named preset. Elevation presets use the orthographic
   * camera so walls measure true to scale; the 3/4 and eye-level presets use the
   * perspective camera so they read like a photograph.
   */
  /** Re-apply the last preset — used when the render aspect differs from the viewport. */
  refit() {
    if (this._lastView && !this.userMoved) {
      this.setView(this._lastView, this._lastDim, this._lastOpts);
    }
  }

  setView(name, dim, opts) {
    this._lastDim = dim;
    this._lastOpts = opts;
    this.userMoved = false;
    const d = derived(dim);
    const { widthFt: W, lengthFt: L } = dim;
    const target = new THREE.Vector3(0, d.ridgeY * 0.45, 0);
    const pad = 1.18;

    const ortho = (dir, fitW, fitH) => {
      this.useOrtho(true);
      this._orthoFit = { w: fitW, h: fitH, pad };
      this.reframeOrtho();
      const dist = Math.max(L, W) * 3 + 100;
      this.ortho.position.copy(target).addScaledVector(dir, dist);
      this.orthoControls.target.copy(target);
      this.ortho.up.set(0, 1, 0);
      this.ortho.lookAt(target);
      this.orthoControls.update();
    };

    const corners = boxCorners(dim, d);

    /**
     * Pull the camera back along `dir` until every corner of the home's bounding
     * box lands inside the frame. A bounding-sphere fit is far too loose for a
     * 56' x 27' box, so this iterates on the actual projected extent instead.
     */
    const fitDistance = (dir, look, margin) => {
      const cam = this.persp;
      let dist = Math.max(L, W) * 1.5;
      const v = new THREE.Vector3();
      for (let i = 0; i < 5; i++) {
        cam.position.copy(look).addScaledVector(dir, dist);
        cam.lookAt(look);
        cam.updateMatrixWorld(true);
        let extent = 0;
        for (const c of corners) {
          v.copy(c).project(cam);
          extent = Math.max(extent, Math.abs(v.x), Math.abs(v.y));
        }
        if (!isFinite(extent) || extent <= 0) break;
        dist *= extent * margin;
      }
      return dist;
    };

    const persp = (az, elDeg, margin, look) => {
      this.useOrtho(false);
      const a = THREE.MathUtils.degToRad(az);
      const e = THREE.MathUtils.degToRad(elDeg);
      const dir = new THREE.Vector3(
        Math.cos(e) * Math.sin(a),
        Math.sin(e),
        Math.cos(e) * Math.cos(a),
      );
      const t = look || target;
      const radius = fitDistance(dir, t, margin);
      this.persp.position.copy(t).addScaledVector(dir, radius);
      this.controls.target.copy(t);
      this.persp.lookAt(t);
      this.controls.update();
      return radius;
    };

    switch (name) {
      case 'front': ortho(new THREE.Vector3(0, 0, -1), L, d.ridgeY); break;
      case 'rear':  ortho(new THREE.Vector3(0, 0,  1), L, d.ridgeY); break;
      case 'left':  ortho(new THREE.Vector3(-1, 0, 0), W, d.ridgeY); break;
      case 'right': ortho(new THREE.Vector3( 1, 0, 0), W, d.ridgeY); break;
      case 'plan':
        this.useOrtho(true);
        this._orthoFit = { w: L, h: W, pad: 1.15 };
        this.reframeOrtho();
        this.ortho.up.set(0, 0, -1);
        this.ortho.position.set(0, 500, 0);
        this.orthoControls.target.set(0, 0, 0);
        this.ortho.lookAt(0, 0, 0);
        this.orthoControls.update();
        break;
      // Azimuth 0 puts the camera on +Z (the rear). The front wall faces -Z, so
      // front-facing three-quarters sit near 180 degrees.
      case 'hero-left':  persp(-142, 10, 1.06); break;
      case 'hero-right': persp( 142, 10, 1.06); break;
      case 'rear-left':  persp( -38, 10, 1.06); break;
      case 'eye': {
        // Stand a person in front of the home: camera pinned to eye height,
        // distance solved so the whole home still fits the frame.
        const t = new THREE.Vector3(0, dim.floorHeightFt + dim.wallHeightFt * 0.45, 0);
        const el = Math.atan2(opts.eye - t.y, Math.max(L, W));
        persp(-148, THREE.MathUtils.radToDeg(el), 1.06, t);
        this.persp.position.y = opts.eye;
        this.persp.lookAt(t);
        this.controls.update();
        break;
      }
      default: persp(-142, 10, 1.06);
    }
    this._lastView = name;
  }

  setCameraDistance(distFt) {
    if (!isFinite(distFt) || distFt <= 0) return;
    this.userMoved = true;
    const target = this.controls.target;
    const dir = this.persp.position.clone().sub(target);
    if (dir.lengthSq() < 1e-4) dir.set(0, 5, 20);
    dir.normalize();
    this.persp.position.copy(target).addScaledVector(dir, distFt);
    this.controls.update();
  }

  getCameraDistance() {
    return this.persp.position.distanceTo(this.controls.target);
  }

  setGroundBaseline(offsetY) {
    const y = offsetY || 0;
    this.ground.position.y = y;
    this.grid.position.y = -0.005 + y;
    this.planGroup.position.y = y;
  }

  rotateView(deg) {
    this.userMoved = true;
    const cam = this.camera === this.ortho ? this.ortho : this.persp;
    const controls = this.camera === this.ortho ? this.orthoControls : this.controls;
    const target = controls.target;
    const rad = THREE.MathUtils.degToRad(deg);

    const offset = cam.position.clone().sub(target);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), rad);
    cam.position.copy(target).add(offset);
    cam.lookAt(target);
    controls.update();
  }

  render() {
    (this.camera === this.ortho ? this.orthoControls : this.controls).update();
    this.renderer.render(this.scene, this.camera);
  }
}
