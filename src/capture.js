// Offscreen-size rendering and PNG export.

import * as THREE from 'three';
import { fmtFt } from './build.js';
import { photoDrawRect } from './frame.js';

function slug(s) {
  return (s || 'home').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'home';
}

function download(canvas, filename) {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
}

const photoImgCache = new Map();

function getCachedImage(src) {
  if (!src) return null;
  if (photoImgCache.has(src)) return photoImgCache.get(src);
  const img = new Image();
  img.src = src;
  photoImgCache.set(src, img);
  return img;
}

/**
 * Render the current camera at an arbitrary pixel size and return a 2D canvas.
 * The live viewport size is restored before returning.
 */
export function renderToCanvas(stage, w, h, alpha, sceneOpts, home) {
  const prevSize = new THREE.Vector2();
  stage.renderer.getSize(prevSize);
  const prevRatio = stage.renderer.getPixelRatio();
  const prevBg = stage.scene.background;
  // The renderer is created with `alpha: true`, so it rests at clear alpha 0 and
  // the site photo shows through the canvas. Restoring a hardcoded 1 here turned
  // the live viewport opaque black the moment you exported once, and the photo
  // you were aligning against disappeared.
  const prevClearAlpha = stage.renderer.getClearAlpha();

  // Save active camera transform, target, and orientation
  const isOrtho = stage.camera === stage.ortho;
  const activeControls = isOrtho ? stage.orthoControls : stage.controls;
  const savedPos = stage.camera.position.clone();
  const savedTarget = activeControls.target.clone();
  const savedQuat = stage.camera.quaternion.clone();
  const savedZoom = stage.camera.zoom;
  const prevAspect = stage.persp.aspect;

  stage.renderer.setPixelRatio(1);
  stage.renderer.setSize(w, h, false);

  if (!isOrtho) {
    stage.persp.aspect = w / h;
    stage.persp.updateProjectionMatrix();
  } else {
    stage._aspect = w / h;
    stage.reframeOrtho();
  }

  const sp = home?.sitePhoto;
  const useBgPhoto = sp && sp.src && sp.show && !alpha;

  if (alpha || useBgPhoto) {
    stage.scene.background = null;
    stage.renderer.setClearAlpha(0);
    stage.grid.visible = false;
  }

  const overlayWas = stage.overlay?.visible;
  if (stage.overlay) stage.overlay.visible = false;

  // Render current camera view at export size
  stage.renderer.render(stage.scene, stage.camera);

  if (stage.overlay) stage.overlay.visible = overlayWas;

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');

  if (useBgPhoto) {
    const img = getCachedImage(sp.src);
    if (img && (img.complete || img.naturalWidth)) {
      ctx.save();
      ctx.globalAlpha = sp.opacity ?? 0.85;
      const scale = sp.scale ?? 1.0;
      const panX = ((sp.panX ?? 0) / 100) * w;
      const panY = ((sp.panY ?? 0) / 100) * h;
      const rot = THREE.MathUtils.degToRad(sp.rotation ?? 0);

      ctx.translate(w / 2 + panX, h / 2 + panY);
      ctx.rotate(rot);
      ctx.scale(scale, scale);

      const { w: drawW, h: drawH } = photoDrawRect(
        sp.fitMode || 'contain',
        img.naturalWidth || img.width,
        img.naturalHeight || img.height,
        w, h,
      );

      ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
    }
  }

  ctx.drawImage(stage.renderer.domElement, 0, 0, w, h);

  // Restore live viewport size, aspect ratio, camera position, and target
  stage.scene.background = prevBg;
  stage.renderer.setClearAlpha(prevClearAlpha);
  stage.grid.visible = !!sceneOpts.grid && !sceneOpts.blockLandscape;
  stage.renderer.setPixelRatio(prevRatio);
  stage.renderer.setSize(prevSize.x, prevSize.y, false);

  stage.camera.position.copy(savedPos);
  activeControls.target.copy(savedTarget);
  stage.camera.quaternion.copy(savedQuat);
  stage.camera.zoom = savedZoom;

  if (!isOrtho) {
    stage.persp.aspect = prevAspect;
    stage.persp.updateProjectionMatrix();
  } else {
    stage._aspect = prevAspect;
    stage.reframeOrtho();
  }
  activeControls.update();

  return out;
}

export function caption(home, viewName) {
  const d = home.dimensions;
  return `${home.name}  ·  ${fmtFt(d.widthFt)} × ${fmtFt(d.lengthFt)}  ·  ${viewName}`;
}

function burnCaption(canvas, text) {
  const ctx = canvas.getContext('2d');
  const fs = Math.max(16, Math.round(canvas.width / 62));
  const pad = Math.round(fs * 0.7);
  ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
  const w = ctx.measureText(text).width + pad * 2;
  const h = fs + pad * 1.4;
  const x = pad, y = canvas.height - h - pad;
  ctx.fillStyle = 'rgba(12,14,18,0.78)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + pad, y + h / 2);
  return canvas;
}

export function shoot(stage, home, sceneOpts, exportOpts, viewName) {
  const c = renderToCanvas(stage, exportOpts.w, exportOpts.h, exportOpts.alpha, sceneOpts, home);
  if (exportOpts.burn && !exportOpts.alpha) burnCaption(c, caption(home, viewName));
  download(c, `${slug(home.name)}-${slug(viewName)}-${exportOpts.w}x${exportOpts.h}.png`);
  return c;
}

const SHEET_VIEWS = [
  ['front', 'Front elevation'],
  ['right', 'Right end elevation'],
  ['rear', 'Rear elevation'],
  ['hero-left', 'Three-quarter, front-left'],
];

/** 2x2 contact sheet of the standard elevation set — the plate set for an image model. */
export function contactSheet(stage, home, sceneOpts, exportOpts) {
  const cw = Math.round(exportOpts.w / 2);
  const ch = Math.round(exportOpts.h / 2);
  const sheet = document.createElement('canvas');
  sheet.width = cw * 2;
  sheet.height = ch * 2;
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = sceneOpts.bg;
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  const restoreView = stage._lastView;

  SHEET_VIEWS.forEach(([view, label], i) => {
    stage.setView(view, home.dimensions, sceneOpts);
    const tile = renderToCanvas(stage, cw, ch, false, sceneOpts, home);
    burnCaption(tile, label);
    ctx.drawImage(tile, (i % 2) * cw, Math.floor(i / 2) * ch);
  });

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.moveTo(cw, 0); ctx.lineTo(cw, sheet.height);
  ctx.moveTo(0, ch); ctx.lineTo(sheet.width, ch);
  ctx.stroke();

  burnCaption(sheet, caption(home, 'elevation set'));
  if (restoreView) stage.setView(restoreView, home.dimensions, sceneOpts);
  download(sheet, `${slug(home.name)}-elevation-set.png`);
  return sheet;
}
