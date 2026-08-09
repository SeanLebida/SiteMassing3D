// App wiring: state -> geometry -> viewport, plus all the panel controls.

import * as THREE from 'three';
import { Stage } from './scene.js';
import { buildHome, disposeTree, wallFrames, clampOpening, fmtFt, derived } from './build.js';
import { renderOpeningList, syncOpeningValues, initAccordions } from './ui.js';
import { updatePlanPlate, nearestWallHit } from './plan.js';
import { Gizmo, wallPlaneHit, applyDrag } from './gizmo.js';
import { shoot, contactSheet, renderToCanvas } from './capture.js';
import { letterbox, matchExportToPhoto, photoIsTransformed } from './frame.js';
import { defaultHome, defaultScene, defaultExport, nextId, OPENING_PRESETS, migrate } from './defaults.js';

const STORE_KEY = 'sitemassing3d.v1';

const state = load() || {
  home: defaultHome(),
  scene: defaultScene(),
  export: defaultExport(),
};
let selectedId = null;
let pendingAdd = null;

const canvas = document.getElementById('view');
const stage = new Stage(canvas);
const gizmo = new Gizmo(stage.homeGroup);
stage.overlay = gizmo.group; // hidden during export — it is UI, not part of the render
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Build / refresh
// ---------------------------------------------------------------------------

function rebuild() {
  for (const o of state.home.openings) clampOpening(o, state.home.dimensions);

  while (stage.homeGroup.children.length) {
    const c = stage.homeGroup.children.pop();
    disposeTree(c);
  }
  stage.homeGroup.add(buildHome(state.home, state.scene));
  stage.homeGroup.add(gizmo.group);

  const sp = state.home.sitePhoto || {};
  const baseY = sp.baselineY || 0;
  stage.setGroundBaseline(baseY);
  stage.homeGroup.position.set(sp.posX || 0, baseY, sp.posZ || 0);
  stage.homeGroup.rotation.y = THREE.MathUtils.degToRad(sp.rotY || 0);

  // Camera distance is deliberately NOT re-applied here. rebuild() runs on every
  // keystroke and on every frame of a drag, and the orbit handler writes the
  // live distance back into sp.camDist — re-applying it closed that loop and
  // pinned `userMoved`, which quietly killed preset re-framing on resize.

  applyScene();
  gizmo.show(state.home.openings.find((o) => o.id === selectedId), state.home.dimensions);
  updateHud();
  save();
}

/**
 * Scene options own the background colour, the site photo owns it when one is
 * showing. Applying them in the wrong order painted over the photo, so every
 * caller goes through here instead of touching `applySceneOpts` directly.
 */
function applyScene() {
  stage.applySceneOpts(state.scene, state.home.dimensions);
  updateSitePhotoPlate();
}

/**
 * A transparent export is meant to be dropped onto the original photo file as a
 * layer. That only registers while the photo sits untransformed in the frame —
 * pan, zoom or rotate it and the plate was composed against a photo that no
 * longer matches the file on disk. Warn exactly when both conditions are true,
 * because this fails silently and only shows up in the client's plate.
 */
function updateAlphaRegisterWarning() {
  const el = $('alphaRegisterWarn');
  if (!el) return;
  const sp = state.home.sitePhoto;
  const risky = !!(state.export.alpha && sp?.src && sp.show && photoIsTransformed(sp));
  el.style.display = risky ? 'block' : 'none';
}

function updateSitePhotoPlate() {
  const bg = $('sitePhotoBg');
  if (!bg) return;
  const sp = state.home.sitePhoto;
  if (!sp || !sp.src || !sp.show || state.scene.blockLandscape) {
    bg.style.display = 'none';
    bg.style.backgroundImage = '';
    updateAlphaRegisterWarning();
    if (state.scene) stage.scene.background = state.scene.bgVisible === false ? null : new THREE.Color(state.scene.bg);
    return;
  }
  bg.style.display = 'block';
  bg.style.backgroundImage = `url("${sp.src}")`;
  bg.style.opacity = sp.opacity ?? 0.85;
  bg.style.backgroundSize = sp.fitMode || 'contain';
  const scale = sp.scale ?? 1.0;
  const panX = sp.panX ?? 0;
  const panY = sp.panY ?? 0;
  const rot = sp.rotation ?? 0;
  bg.style.transform = `translate(${panX}%, ${panY}%) scale(${scale}) rotate(${rot}deg)`;
  stage.scene.background = null;
  updateAlphaRegisterWarning();
}

function select(id) {
  selectedId = id;
  gizmo.show(state.home.openings.find((o) => o.id === id), state.home.dimensions);
  refreshList();
}

/** Full rebuild of the list DOM — only for changes that move rows between groups. */
function refreshList() {
  renderOpeningList($('openingList'), state.home, {
    selectedId,
    onSelect: select,
    onEdit: (o, geometry) => {
      if (geometry) clampOpening(o, state.home.dimensions);
      rebuild();
      save();
      syncList();
    },
    onRestructure: (id) => { rebuild(); save(); refreshList(); select(id); },
    onDelete: (id) => {
      state.home.openings = state.home.openings.filter((o) => o.id !== id);
      if (selectedId === id) { selectedId = null; gizmo.clear(); }
      rebuild(); save(); refreshList();
    },
    onDuplicate: (id) => {
      const src = state.home.openings.find((o) => o.id === id);
      if (!src) return;
      const copy = { ...src, id: nextId(src.type[0]), offsetFt: src.offsetFt + src.widthFt + 2 };
      state.home.openings.push(copy);
      rebuild(); save(); refreshList(); select(copy.id);
    },
  });
  updateCounts();
}

/** Cheap update: values and selection only, existing rows untouched. */
function syncList() {
  syncOpeningValues($('openingList'), state.home, selectedId, {
    selectedId,
    onSelect: select,
    onEdit: (o, geometry) => {
      if (geometry) clampOpening(o, state.home.dimensions);
      rebuild();
      save();
      syncList();
    },
  });
  updateCounts();
}

function updateCounts() {
  const doors = state.home.openings.filter((o) => o.type !== 'window').length;
  const wins = state.home.openings.length - doors;
  $('openCount').textContent = `${doors} door${doors === 1 ? '' : 's'} / ${wins} window${wins === 1 ? '' : 's'}`;
}

function updateHud() {
  const d = state.home.dimensions;
  const dv = derived(d);
  const ratio = (d.lengthFt / d.widthFt).toFixed(2);
  const camY = Math.round(stage.camera.position.y * 10) / 10;
  $('hud').textContent =
    `${state.home.name}\n` +
    `${fmtFt(d.widthFt)} W × ${fmtFt(d.lengthFt)} L   (front wall reads ${ratio}× the gable end)\n` +
    `eave ${fmtFt(dv.eaveY)}   ridge ${fmtFt(dv.ridgeY)}   pitch ${d.roofPitch}/12   floor ${fmtFt(d.floorHeightFt)}\n` +
    `camera ${camY}' up   ${Math.round(stage.getCameraDistance())}' out   ${state.scene.focal}mm`;
  $('ratioHint').textContent =
    `Front wall must read ${ratio}× as long as the gable end is wide. Roof ridge ${fmtFt(dv.ridgeY)} above grade.`;
}

// ---------------------------------------------------------------------------
// Form binding
// ---------------------------------------------------------------------------

const dimFields = [
  ['f_width', 'widthFt'], ['f_length', 'lengthFt'], ['f_wallHeight', 'wallHeightFt'],
  ['f_floorHeight', 'floorHeightFt'], ['f_pitch', 'roofPitch'],
  ['f_eaveOverhang', 'eaveOverhangFt'], ['f_rakeOverhang', 'rakeOverhangFt'],
  ['f_dormerWidth', 'dormerWidthFt'], ['f_dormerHeight', 'dormerHeightFt'],
  ['f_frontWallHeight', 'frontWallHeightFt'], ['f_backWallHeight', 'backWallHeightFt'],
  ['f_leftWallHeight', 'leftWallHeightFt'], ['f_rightWallHeight', 'rightWallHeightFt'],
];
const colorFields = [
  ['c_siding', 'siding'], ['c_trim', 'trim'], ['c_roof', 'roof'],
  ['c_skirting', 'skirting'], ['c_door', 'door'], ['c_glass', 'glass'],
];
const planFields = [['p_width', 'widthFt'], ['p_rot', 'rotation'], ['p_x', 'offsetX'], ['p_z', 'offsetZ']];
const photoFields = [
  ['sp_op', 'opacity'], ['sp_scale', 'scale'], ['sp_panX', 'panX'],
  ['sp_panY', 'panY'], ['sp_rot', 'rotation'], ['sp_baselineY', 'baselineY'],
  ['sp_camDist', 'camDist'], ['sp_posX', 'posX'], ['sp_posZ', 'posZ'], ['sp_rotY', 'rotY'],
];
const sceneNums = [['s_focal', 'focal'], ['s_eye', 'eye'], ['s_landingDepth', 'landingDepthFt']];
const sceneRanges = [['s_sunAz', 'sunAz'], ['s_sunEl', 'sunEl'], ['s_flat', 'flat']];
const sceneChecks = [['s_grid', 'grid'], ['s_shadow', 'shadow'], ['s_steps', 'steps'], ['s_stepLanding', 'stepLanding'], ['s_wireframe', 'wireframe'], ['s_blockLandscape', 'blockLandscape'], ['s_labels', 'labels'], ['s_dims', 'dims'], ['s_horizon', 'horizon']];

function syncForm() {
  $('f_name').value = state.home.name;
  for (const [id, key] of dimFields) {
    if ($(id)) $(id).value = state.home.dimensions[key] ?? '';
  }
  $('f_roofStyle').value = state.home.dimensions.roofStyle;
  if ($('f_dormerCount')) $('f_dormerCount').value = state.home.dimensions.dormerCount ?? 0;
  if ($('f_dormerStyle')) $('f_dormerStyle').value = state.home.dimensions.dormerStyle || 'gable';
  if ($('f_dormerFalseEave')) $('f_dormerFalseEave').checked = state.home.dimensions.dormerFalseEave !== false;
  if ($('f_dormerInnerFalseEave')) $('f_dormerInnerFalseEave').checked = state.home.dimensions.dormerInnerFalseEave !== false;
  if ($('f_dormerConnected')) $('f_dormerConnected').checked = !!state.home.dimensions.dormerConnected;
  if ($('f_dormerWindow')) $('f_dormerWindow').checked = state.home.dimensions.dormerWindow !== false;
  for (const [id, key] of colorFields) $(id).value = state.home.colors[key];
  for (const [id, key] of planFields) $(id).value = state.home.plan[key];
  $('p_op').value = state.home.plan.opacity;
  $('p_show').checked = state.home.plan.show;
  const sp = state.home.sitePhoto || {};
  if ($('sp_fitMode')) $('sp_fitMode').value = sp.fitMode || 'contain';
  for (const [id, key] of photoFields) {
    if ($(id)) $(id).value = sp[key] ?? 0;
  }
  if ($('sp_show')) $('sp_show').checked = sp.show !== false;
  for (const [id, key] of sceneNums) {
    if ($(id)) $(id).value = state.scene[key] ?? 0;
  }
  for (const [id, key] of sceneRanges) {
    if ($(id)) $(id).value = state.scene[key] ?? 0;
  }
  for (const [id, key] of sceneChecks) {
    if ($(id)) $(id).checked = !!state.scene[key];
  }
  if ($('s_stepRailings')) $('s_stepRailings').value = state.scene.stepRailings || 'both';
  if ($('s_stepMat')) $('s_stepMat').value = state.scene.stepMat || 'concrete';
  if ($('s_stepEgress')) $('s_stepEgress').value = state.scene.stepEgress || 'front';
  if ($('s_railMat')) $('s_railMat').value = state.scene.railMat || 'pressure_treated';
  if ($('s_balusterStyle')) $('s_balusterStyle').value = state.scene.balusterStyle || 'balusters';
  if ($('btnWireframe')) $('btnWireframe').classList.toggle('active', !!state.scene.wireframe);
  $('s_bg').value = state.scene.bg;
  $('x_w').value = state.export.w;
  $('x_h').value = state.export.h;
  $('x_alpha').checked = state.export.alpha;
  $('x_burn').checked = state.export.burn;
  if ($('x_lockFrame')) $('x_lockFrame').checked = state.export.lockFrame !== false;
}

/** Swap in a home spec from disk or the library and reframe on it. */
function loadHome(raw) {
  state.home = migrate(raw);
  selectedId = null;
  gizmo.clear();
  syncForm();
  rebuild();
  refreshList();
  updatePlanPlate(stage, state.home.plan);
  if (!stage.userMoved) {
    stage.setView('hero-left', state.home.dimensions, state.scene);
  }
}

function bind() {
  initAccordions();

  const toggleSidebar = () => {
    const main = $('mainContainer');
    if (!main) return;
    const collapsed = main.classList.toggle('sidebar-collapsed');
    const text = collapsed ? '▶ Show Sidebar' : '◀ Collapse Sidebar';
    if ($('btnToggleSidebar')) $('btnToggleSidebar').textContent = text;
    if ($('btnToggleSidebarTop')) $('btnToggleSidebarTop').textContent = collapsed ? '▶ Sidebar' : '◀ Sidebar';
    
    setTimeout(fit, 210); // after the sidebar width transition settles
  };

  if ($('btnToggleSidebar')) $('btnToggleSidebar').addEventListener('click', toggleSidebar);
  if ($('btnToggleSidebarTop')) $('btnToggleSidebarTop').addEventListener('click', toggleSidebar);

  $('f_name').addEventListener('input', (e) => { state.home.name = e.target.value; updateHud(); save(); });

  for (const [id, key] of dimFields) {
    $(id).addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isNaN(v)) return; // let the field be empty mid-edit
      state.home.dimensions[key] = v;
      rebuild(); syncList();
    });
  }
  $('f_roofStyle').addEventListener('change', (e) => {
    state.home.dimensions.roofStyle = e.target.value;
    rebuild();
  });
  if ($('f_dormerCount')) {
    $('f_dormerCount').addEventListener('change', (e) => {
      state.home.dimensions.dormerCount = parseInt(e.target.value, 10) || 0;
      rebuild(); save();
    });
  }
  if ($('f_dormerStyle')) {
    $('f_dormerStyle').addEventListener('change', (e) => {
      state.home.dimensions.dormerStyle = e.target.value;
      rebuild(); save();
    });
  }
  if ($('f_dormerFalseEave')) {
    $('f_dormerFalseEave').addEventListener('change', (e) => {
      state.home.dimensions.dormerFalseEave = e.target.checked;
      rebuild(); save();
    });
  }
  if ($('f_dormerInnerFalseEave')) {
    $('f_dormerInnerFalseEave').addEventListener('change', (e) => {
      state.home.dimensions.dormerInnerFalseEave = e.target.checked;
      rebuild(); save();
    });
  }
  if ($('f_dormerConnected')) {
    $('f_dormerConnected').addEventListener('change', (e) => {
      state.home.dimensions.dormerConnected = e.target.checked;
      rebuild(); save();
    });
  }
  if ($('f_dormerWindow')) {
    $('f_dormerWindow').addEventListener('change', (e) => {
      state.home.dimensions.dormerWindow = e.target.checked;
      rebuild(); save();
    });
  }
  if ($('btnResetDormerPos')) {
    $('btnResetDormerPos').addEventListener('click', () => {
      state.home.dimensions.dormerPositions = [];
      rebuild(); save();
    });
  }
  for (const [id, key] of colorFields) {
    $(id).addEventListener('input', (e) => { state.home.colors[key] = e.target.value; rebuild(); });
  }

  for (const [id, key] of planFields) {
    $(id).addEventListener('change', (e) => {
      state.home.plan[key] = parseFloat(e.target.value) || 0;
      updatePlanPlate(stage, state.home.plan); save();
    });
  }
  $('p_op').addEventListener('input', (e) => {
    state.home.plan.opacity = parseFloat(e.target.value);
    updatePlanPlate(stage, state.home.plan); save();
  });
  $('p_show').addEventListener('change', (e) => {
    state.home.plan.show = e.target.checked;
    updatePlanPlate(stage, state.home.plan); save();
  });
  $('filePlan').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      state.home.plan.src = r.result;
      state.home.plan.show = true;
      $('p_show').checked = true;
      updatePlanPlate(stage, state.home.plan);
      save();
    };
    r.readAsDataURL(f);
  });

  function setPhotoDragMode(active) {
    const badge = $('photoDragBadge');
    if (active) {
      stage.controls.enabled = false;
      stage.orthoControls.enabled = false;
      canvas.style.cursor = 'grab';
      if (badge) badge.style.display = 'block';
    } else {
      stage.controls.enabled = stage.camera !== stage.ortho;
      stage.orthoControls.enabled = stage.camera === stage.ortho;
      canvas.style.cursor = '';
      if (badge) badge.style.display = 'none';
    }
  }

  if ($('sp_dragMode')) {
    $('sp_dragMode').addEventListener('change', (e) => {
      setPhotoDragMode(e.target.checked);
    });
  }

  canvas.addEventListener('wheel', (ev) => {
    const isPhotoDrag = $('sp_dragMode')?.checked || ev.shiftKey;
    if (isPhotoDrag && state.home.sitePhoto?.show && state.home.sitePhoto?.src) {
      ev.preventDefault();
      const sp = state.home.sitePhoto;
      const delta = ev.deltaY < 0 ? 0.05 : -0.05;
      sp.scale = Math.max(0.2, Math.min(5.0, Math.round(((sp.scale || 1.0) + delta) * 100) / 100));
      if ($('sp_scale')) $('sp_scale').value = sp.scale;
      updateSitePhotoPlate();
      save();
    }
  }, { passive: false });
  // Photo pan/zoom/opacity move a CSS background — they touch no geometry, so
  // they must not drag a full rebuild of every wall through each slider tick.
  const PHOTO_ONLY = new Set(['opacity', 'scale', 'panX', 'panY', 'rotation']);
  for (const [id, key] of photoFields) {
    if (!$(id)) continue;
    $(id).addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.home.sitePhoto[key] = Number.isNaN(v) ? 0 : v;
      if (key === 'camDist') stage.setCameraDistance(state.home.sitePhoto.camDist);
      if (PHOTO_ONLY.has(key)) { updateSitePhotoPlate(); save(); }
      else rebuild();
    });
  }
  if ($('sp_fitMode')) {
    $('sp_fitMode').addEventListener('change', (e) => {
      state.home.sitePhoto.fitMode = e.target.value;
      updateSitePhotoPlate();
      save();
    });
  }
  if ($('sp_show')) {
    $('sp_show').addEventListener('change', (e) => {
      state.home.sitePhoto.show = e.target.checked;
      updateSitePhotoPlate();
      save();
    });
  }
  if ($('fileSitePhoto')) {
    $('fileSitePhoto').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        const sp = state.home.sitePhoto;
        sp.src = r.result;
        sp.show = true;
        if ($('sp_show')) $('sp_show').checked = true;

        // Read the photo's true pixel size, then shape the export around it.
        const probe = new Image();
        probe.onload = () => {
          sp.natW = probe.naturalWidth;
          sp.natH = probe.naturalHeight;
          matchExportToSitePhoto();
        };
        probe.src = sp.src;
        rebuild();
      };
      r.readAsDataURL(f);
    });
  }
  if ($('btnMatchExport')) $('btnMatchExport').addEventListener('click', () => matchExportToSitePhoto(true));
  if ($('btnResetPhoto')) {
    $('btnResetPhoto').addEventListener('click', () => {
      state.home.sitePhoto = {
        ...state.home.sitePhoto,
        fitMode: 'contain', scale: 1.0, panX: 0, panY: 0, rotation: 0, baselineY: 0, camDist: 60, posX: 0, posZ: 0, rotY: 0, show: true
      };
      syncForm();
      stage.setCameraDistance(state.home.sitePhoto.camDist);
      rebuild();
    });
  }

  function syncCameraStateToForm() {
    const dist = Math.round(stage.getCameraDistance() * 10) / 10;
    state.home.sitePhoto.camDist = dist;
    if ($('sp_camDist') && document.activeElement !== $('sp_camDist')) {
      $('sp_camDist').value = dist;
    }

    // Camera height is reported in the HUD, not written back into scene.eye.
    // scene.eye is the *Eye level preset's* standing height; orbiting a ¾ view
    // used to overwrite it, so the preset then put the viewer 40' in the air.
    updateHud();
    save();
  }

  stage.controls.addEventListener('change', syncCameraStateToForm);
  stage.orthoControls.addEventListener('change', syncCameraStateToForm);

  for (const [id, key] of [...sceneNums, ...sceneRanges]) {
    if ($(id)) {
      $(id).addEventListener('input', (e) => {
        state.scene[key] = parseFloat(e.target.value);
        if (key === 'landingDepthFt') rebuild();
        else applyScene();
        // Re-frame on a lens change only while the framing is still the preset's.
        // Once you have placed the camera against a site photo, dialling in the
        // photo's focal length must change the field of view and nothing else —
        // re-fitting would throw the alignment away at the worst moment.
        if ((key === 'focal' || key === 'eye') && stage._lastView && !stage.userMoved) {
          stage.setView(stage._lastView, state.home.dimensions, state.scene);
        }
        save();
      });
    }
  }
  for (const [id, key] of sceneChecks) {
    if ($(id)) {
      $(id).addEventListener('change', (e) => {
        state.scene[key] = e.target.checked;
        if (['steps', 'stepLanding', 'labels', 'dims'].includes(key)) rebuild();
        else { applyScene(); save(); }
      });
    }
  }
  if ($('s_stepRailings')) {
    $('s_stepRailings').addEventListener('change', (e) => {
      state.scene.stepRailings = e.target.value;
      rebuild();
    });
  }
  if ($('s_stepMat')) {
    $('s_stepMat').addEventListener('change', (e) => {
      state.scene.stepMat = e.target.value;
      rebuild();
    });
  }
  if ($('s_stepEgress')) {
    $('s_stepEgress').addEventListener('change', (e) => {
      state.scene.stepEgress = e.target.value;
      rebuild();
    });
  }
  if ($('s_railMat')) {
    $('s_railMat').addEventListener('change', (e) => {
      state.scene.railMat = e.target.value;
      rebuild();
    });
  }
  if ($('s_balusterStyle')) {
    $('s_balusterStyle').addEventListener('change', (e) => {
      state.scene.balusterStyle = e.target.value;
      rebuild();
    });
  }
  $('s_bg').addEventListener('input', (e) => {
    state.scene.bg = e.target.value;
    applyScene();
    save();
  });

  for (const [id, key] of [['x_w', 'w'], ['x_h', 'h']]) {
    $(id).addEventListener('change', (e) => {
      state.export[key] = parseInt(e.target.value, 10) || 1200;
      fit(); // the locked frame is derived from these
      save();
    });
  }
  $('x_alpha').addEventListener('change', (e) => {
    state.export.alpha = e.target.checked;
    updateAlphaRegisterWarning();
    save();
  });
  $('x_burn').addEventListener('change', (e) => { state.export.burn = e.target.checked; save(); });
  if ($('x_lockFrame')) {
    $('x_lockFrame').addEventListener('change', (e) => {
      state.export.lockFrame = e.target.checked;
      fit();
      save();
    });
  }

  $('btnAddDoor').addEventListener('click', () => armAdd('door'));
  $('btnAddSlider').addEventListener('click', () => armAdd('slider'));
  $('btnAddWindow').addEventListener('click', () => armAdd('window'));

  if ($('btnRotL90')) {
    $('btnRotL90').addEventListener('click', () => stage.rotateView(-90));
  }
  if ($('btnRotR90')) {
    $('btnRotR90').addEventListener('click', () => stage.rotateView(90));
  }
  if ($('btnWireframe')) {
    $('btnWireframe').addEventListener('click', () => {
      state.scene.wireframe = !state.scene.wireframe;
      if ($('s_wireframe')) $('s_wireframe').checked = state.scene.wireframe;
      $('btnWireframe').classList.toggle('active', state.scene.wireframe);
      stage.setWireframe(state.scene.wireframe);
      save();
    });
  }

  // Both the top bar and the in-viewport bar carry preset buttons.
  for (const b of document.querySelectorAll('button[data-view]')) {
    b.addEventListener('click', () => {
      stage.setView(b.dataset.view, state.home.dimensions, state.scene);
      currentViewName = b.textContent.trim();
    });
  }

  // Home library: homes/index.json lists the JSON specs sitting next to it.
  fetch('homes/index.json')
    .then((r) => (r.ok ? r.json() : []))
    .then((list) => {
      for (const item of list) {
        const opt = document.createElement('option');
        opt.value = item.file;
        opt.textContent = item.name || item.file;
        $('library').appendChild(opt);
      }
    })
    .catch(() => { /* opened without a server, or no library — the file picker still works */ });

  $('library').addEventListener('change', async (e) => {
    const file = e.target.value;
    if (!file) return;
    try {
      const res = await fetch(`homes/${file}`);
      if (!res.ok) throw new Error(res.statusText);
      loadHome(await res.json());
    } catch (err) {
      alert(`Could not load homes/${file}: ${err.message}`);
    }
  });

  $('btnNew').addEventListener('click', () => {
    if (!confirm('Discard the current home and start a new one?')) return;
    state.home = defaultHome();
    selectedId = null;
    gizmo.clear();
    syncForm(); rebuild(); refreshList();
    updatePlanPlate(stage, state.home.plan);
    stage.setView('hero-left', state.home.dimensions, state.scene);
  });

  $('btnSave').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.home, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(state.home.name || 'home').replace(/[^\w-]+/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  $('fileHome').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        loadHome(JSON.parse(r.result));
      } catch (err) {
        alert(`Could not read that JSON: ${err.message}`);
      }
    };
    r.readAsText(f);
    e.target.value = '';
  });

  // An elevation is far wider than it is tall; a 3:2 export wastes most of the
  // frame on sky. This retargets the pixel height to the subject's proportions.
  $('btnFitPx').addEventListener('click', () => {
    const fit = stage._orthoFit;
    let ratio;
    if (stage.camera === stage.ortho && fit) {
      ratio = fit.h / fit.w;
    } else {
      const d = state.home.dimensions;
      ratio = 0.62; // three-quarter views read well near 8:5
      if (d.lengthFt > 0) ratio = Math.max(0.5, Math.min(0.75, (derived(d).ridgeY * 2.4) / d.lengthFt));
    }
    state.export.h = Math.max(240, Math.round((state.export.w * ratio) / 16) * 16);
    $('x_h').value = state.export.h;
    fit(); // the locked frame follows the new aspect
    save();
  });

  const doShot = () => shoot(stage, state.home, state.scene, state.export, currentViewName);
  $('btnShot').addEventListener('click', doShot);
  $('btnShot2').addEventListener('click', doShot);
  $('btnSheet').addEventListener('click', () => contactSheet(stage, state.home, state.scene, state.export));

  canvas.addEventListener('pointerdown', onPick);
  // Move/up live on the window so a drag survives the pointer leaving the canvas.
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { pendingAdd = null; canvas.style.cursor = ''; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && e.target === document.body) {
      state.home.openings = state.home.openings.filter((o) => o.id !== selectedId);
      selectedId = null; gizmo.clear(); rebuild(); refreshList();
    }
  });
}

let currentViewName = '¾ front-L';

/**
 * Retarget the export to the site photo's own pixel grid. With the frame locked
 * this is what makes a transparent export drop straight onto the original photo
 * in Photoshop / Affinity / Illustrator at 1:1 — no scaling, no re-cropping,
 * so the massing stays dimensionally honest all the way to the client plate.
 */
function matchExportToSitePhoto(announce = false) {
  const sp = state.home.sitePhoto || {};
  const size = matchExportToPhoto(sp.natW, sp.natH);
  if (!size) {
    if (announce) alert('Load a site photo first — the export is matched to its pixel size.');
    return false;
  }
  state.export.w = size.w;
  state.export.h = size.h;
  state.export.lockFrame = true;
  $('x_w').value = size.w;
  $('x_h').value = size.h;
  if ($('x_lockFrame')) $('x_lockFrame').checked = true;
  fit();
  save();
  return true;
}

function armAdd(type) {
  pendingAdd = type;
  canvas.style.cursor = 'crosshair';
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let drag = null;
let dormerDrag = null;  // { index, startX, startPosX }

function setRay(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, stage.camera);
}

const findOpeningId = (obj) => {
  for (let o = obj; o; o = o.parent) if (o.userData?.opening) return o.userData.opening;
  return null;
};

const findDormerIndex = (obj) => {
  for (let o = obj; o; o = o.parent) {
    if (o.userData?.dormerIndex !== undefined) return o.userData.dormerIndex;
  }
  return null;
};

let photoDrag = null;

function onPick(ev) {
  const isPhotoDrag = $('sp_dragMode')?.checked || (ev.shiftKey && state.home.sitePhoto?.show && state.home.sitePhoto?.src);
  if (isPhotoDrag) {
    photoDrag = {
      startX: ev.clientX,
      startY: ev.clientY,
      startPanX: state.home.sitePhoto.panX ?? 0,
      startPanY: state.home.sitePhoto.panY ?? 0,
      startRot: state.home.sitePhoto.rotation ?? 0,
      button: ev.button,
    };
    stage.controls.enabled = false;
    stage.orthoControls.enabled = false;
    canvas.style.cursor = 'grabbing';
    ev.preventDefault();
    return;
  }

  if (ev.button !== 0) return;
  setRay(ev);

  // Dormer picking — check before opening picks so dormers can be dragged.
  if (!pendingAdd) {
    const dormerHits = ray.intersectObjects(stage.homeGroup.children, true);
    const dormerIdx = dormerHits.map((h) => findDormerIndex(h.object)).find((v) => v !== null);
    if (dormerIdx !== null && dormerIdx !== undefined) {
      const dim = state.home.dimensions;
      const count = parseInt(dim.dormerCount, 10) || 0;
      if (count > 0) {
        // Initialise positions array from auto-positions if empty
        if (!Array.isArray(dim.dormerPositions) || dim.dormerPositions.length !== count) {
          dim.dormerPositions = count === 1 ? [0] : [-dim.lengthFt * 0.25, dim.lengthFt * 0.25];
        }
        dormerDrag = {
          index: dormerIdx,
          startClientX: ev.clientX,
          startPosX: dim.dormerPositions[dormerIdx],
        };
        stage.controls.enabled = false;
        stage.orthoControls.enabled = false;
        canvas.style.cursor = 'grabbing';
        ev.preventDefault();
        return;
      }
    }
  }

  const planPick = $('p_pick').checked;

  // Wall frames are in the home's own coordinates. Once the home is nudged or
  // rotated onto the lot (House X/Z/Heading), a world-space pick no longer
  // matches them, so every pick is brought back into the group's local space.
  const toHomeLocal = (p) => stage.homeGroup.worldToLocal(p.clone());

  if (planPick) {
    const hits = ray.intersectObjects(stage.planGroup.children, true);
    if (hits.length) {
      const hit = nearestWallHit(toHomeLocal(hits[0].point), state.home.dimensions);
      addOpening(pendingAdd || 'door', hit.wall, hit.offsetFt, null);
      return;
    }
  }

  const hits = ray.intersectObjects(stage.homeGroup.children, true);

  if (pendingAdd) {
    const wallHit = hits.find((h) => h.object.userData.wall);
    if (!wallHit) return;
    const wall = wallHit.object.userData.wall;
    const f = wallFrames(state.home.dimensions)[wall];
    const rel = toHomeLocal(wallHit.point).sub(f.origin);
    addOpening(pendingAdd, wall, rel.dot(f.right), rel.y);
    return;
  }

  // Resize handle takes priority over the geometry behind it.
  const mode = gizmo.pick(ray);
  const sel = state.home.openings.find((o) => o.id === selectedId);
  if (mode && sel) return beginDrag(sel, mode);

  const hitId = hits.map((h) => findOpeningId(h.object)).find(Boolean);
  if (hitId) {
    const o = state.home.openings.find((x) => x.id === hitId);
    select(hitId);
    scrollToSelected();
    return beginDrag(o, 'move');
  }

  if (selectedId) { selectedId = null; gizmo.clear(); refreshList(); }
}

function beginDrag(o, mode) {
  const hit = wallPlaneHit(ray, o.wall, state.home.dimensions, stage.homeGroup);
  if (!hit) return;
  drag = {
    id: o.id,
    mode,
    origin: hit,
    start: { offsetFt: o.offsetFt, widthFt: o.widthFt, heightFt: o.heightFt, sillFt: o.sillFt },
  };
  stage.controls.enabled = false;
  stage.orthoControls.enabled = false;
  canvas.style.cursor = mode === 'move' ? 'grabbing' : 'crosshair';
}

function onMove(ev) {
  // Dormer drag — project screen-space delta onto the world X axis.
  if (dormerDrag) {
    const dim = state.home.dimensions;
    const dW = dim.dormerWidthFt ?? 10;
    const halfL = dim.lengthFt / 2 - dW / 2 - 1; // keep dormer inside the building
    // Approximate world-space feet per pixel from camera distance.
    const r = canvas.getBoundingClientRect();
    const camDist = stage.getCameraDistance();
    const ftPerPx = (camDist * 2 * Math.tan(THREE.MathUtils.degToRad(stage.persp.fov / 2))) / r.height;
    const screenDx = (ev.clientX - dormerDrag.startClientX) * ftPerPx;
    // Use the camera's right vector to determine the world-X sign so the
    // drag direction matches the cursor regardless of camera angle.
    const camRight = new THREE.Vector3();
    stage.camera.getWorldDirection(camRight);
    camRight.cross(stage.camera.up).normalize();
    const dx = screenDx * Math.sign(camRight.x || 1);
    const newX = Math.max(-halfL, Math.min(halfL, dormerDrag.startPosX + dx));
    dim.dormerPositions[dormerDrag.index] = Math.round(newX * 12) / 12; // snap to 1 inch
    queueRebuild();
    return;
  }

  if (photoDrag) {
    const r = canvas.getBoundingClientRect();
    const dx = ev.clientX - photoDrag.startX;
    const dy = ev.clientY - photoDrag.startY;
    const sp = state.home.sitePhoto;

    if (photoDrag.button === 0 && !ev.altKey) {
      // CSS applies `translate()` in the element's own, unscaled pixels, so the
      // pan percentage is independent of the photo zoom. Multiplying by scale
      // here made the photo outrun the cursor whenever you were zoomed in.
      const percentX = (dx / r.width) * 100;
      const percentY = (dy / r.height) * 100;
      sp.panX = Math.round((photoDrag.startPanX + percentX) * 10) / 10;
      sp.panY = Math.round((photoDrag.startPanY + percentY) * 10) / 10;
      if ($('sp_panX')) $('sp_panX').value = sp.panX;
      if ($('sp_panY')) $('sp_panY').value = sp.panY;
    } else if (photoDrag.button === 2 || ev.altKey) {
      sp.rotation = Math.round((photoDrag.startRot + dx * 0.5) % 360);
      if ($('sp_rot')) $('sp_rot').value = sp.rotation;
    }
    updateSitePhotoPlate();
    save();
    return;
  }

  if (!drag) {
    if (!selectedId || ev.target !== canvas) return;
    setRay(ev);
    const mode = gizmo.pick(ray);
    gizmo.highlight(mode);
    if (mode) canvas.style.cursor = (mode === 'left' || mode === 'right') ? 'ew-resize' : 'ns-resize';
    else if (!pendingAdd && !$('sp_dragMode')?.checked) canvas.style.cursor = '';
    return;
  }

  const o = state.home.openings.find((x) => x.id === drag.id);
  if (!o) return;
  setRay(ev);
  const hit = wallPlaneHit(ray, o.wall, state.home.dimensions, stage.homeGroup);
  if (!hit) return;

  let du = hit.u - drag.origin.u;
  let dv = hit.v - drag.origin.v;
  // Shift locks the drag to the dominant axis; Alt turns off the 1" snap.
  if (ev.shiftKey && !photoDrag) { if (Math.abs(du) >= Math.abs(dv)) dv = 0; else du = 0; }

  applyDrag(o, drag.mode, drag.start, { du, dv }, state.home.dimensions, ev.altKey);
  clampOpening(o, state.home.dimensions);
  queueRebuild();
}

function onUp() {
  if (dormerDrag) {
    dormerDrag = null;
    stage.controls.enabled = stage.camera !== stage.ortho;
    stage.orthoControls.enabled = stage.camera === stage.ortho;
    canvas.style.cursor = '';
    rebuild();
    save();
    return;
  }

  if (photoDrag) {
    photoDrag = null;
    if ($('sp_dragMode')?.checked) {
      canvas.style.cursor = 'grab';
    } else {
      stage.controls.enabled = stage.camera !== stage.ortho;
      stage.orthoControls.enabled = stage.camera === stage.ortho;
      canvas.style.cursor = '';
    }
    save();
    return;
  }

  if (!drag) return;
  drag = null;
  stage.controls.enabled = stage.camera !== stage.ortho;
  stage.orthoControls.enabled = stage.camera === stage.ortho;
  canvas.style.cursor = '';
  syncList();
  save();
}

let rebuildQueued = false;
function queueRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => {
    rebuildQueued = false;
    rebuild();
    syncList();
  });
}

function scrollToSelected() {
  const el = document.querySelector('.opening.sel');
  el?.scrollIntoView({ block: 'nearest' });
}

function addOpening(type, wall, u, v) {
  const p = OPENING_PRESETS[type];
  const o = {
    id: nextId(type[0]),
    type,
    wall,
    offsetFt: Math.max(0, u - p.widthFt / 2),
    widthFt: p.widthFt,
    heightFt: p.heightFt,
    sillFt: type === 'window' && v != null ? Math.max(0, v - p.heightFt / 2) : p.sillFt,
    label: p.label,
  };
  clampOpening(o, state.home.dimensions);
  state.home.openings.push(o);
  selectedId = o.id;
  pendingAdd = null;
  canvas.style.cursor = '';
  rebuild();
  refreshList();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------



function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Plan plates are stored as data URLs and can blow the quota; drop it and retry.
    try {
      const lean = {
        ...state,
        home: {
          ...state.home,
          plan: { ...state.home.plan, src: null },
          sitePhoto: { ...state.home.sitePhoto, src: null },
        },
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(lean));
    } catch { /* give up quietly; the JSON export is the real save path */ }
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return {
      home: migrate(s.home || {}),
      scene: { ...defaultScene(), ...(s.scene || {}) },
      export: { ...defaultExport(), ...(s.export || {}) },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Size the canvas — and the photo plate behind it — to the frame that will
 * actually be exported.
 *
 * With `lockFrame` on, the live frame is letterboxed to the export's aspect
 * ratio. That is the whole point: the photo is a CSS background fitted to this
 * box, and the export refits it to the export's box, so if the two aspects
 * differ the photo lands somewhere else in the PNG and the perspective camera's
 * horizontal field changes too. Every minute you spent aligning the massing to
 * the lot is lost at the moment you hit Render. Locked, the preview *is* the
 * plate.
 */
function fit() {
  const r = canvas.parentElement.getBoundingClientRect();
  const boxW = Math.max(1, Math.floor(r.width));
  const boxH = Math.max(1, Math.floor(r.height));
  const bg = $('sitePhotoBg');

  let box = { x: 0, y: 0, w: boxW, h: boxH };
  const locked = !!state.export.lockFrame && state.export.w > 0 && state.export.h > 0;
  if (locked) box = letterbox(boxW, boxH, state.export.w / state.export.h);

  const px = (v) => `${v}px`;
  for (const el of [canvas, bg]) {
    if (!el) continue;
    if (locked) {
      el.style.left = px(box.x);
      el.style.top = px(box.y);
      el.style.width = px(box.w);
      el.style.height = px(box.h);
    } else {
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
      el.style.height = '';
    }
  }
  $('stage')?.classList.toggle('frame-locked', locked);
  updateFrameHint(locked, box);

  stage.resize(box.w, box.h);
}

/** Tell the user, in the viewport, what the exported plate will be. */
function updateFrameHint(locked, box) {
  const el = $('frameHint');
  if (!el) return;
  if (!locked) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.textContent = `frame ${state.export.w}×${state.export.h}px  ·  preview ${box.w}×${box.h}`;
}

syncForm();
bind();
rebuild();
refreshList();
fit();
updatePlanPlate(stage, state.home.plan);
stage.setView('hero-left', state.home.dimensions, state.scene);
// A session with a site photo has a hand-tuned standoff; the preset would
// otherwise throw it away on every reload.
if (state.home.sitePhoto?.src) stage.setCameraDistance(state.home.sitePhoto.camDist);
addEventListener('resize', fit);

// Debug handle: lets you poke at state/stage from the console without a build step.
window.__app = { state, stage, rebuild, refreshList, renderToCanvas };

/**
 * Draw the horizon guide across the live frame. Matching this line to the
 * horizon in the site photo is what makes the overlay sit on the lot rather
 * than float above it — it is the only direct feedback that the massing's
 * camera height and tilt agree with the camera that took the photo.
 */
let lastHorizonTop = null;
function updateHorizonGuide() {
  const el = $('horizonGuide');
  if (!el) return;
  const t = state.scene.horizon ? stage.horizonFraction() : null;
  if (t === null) {
    if (lastHorizonTop !== null) { el.style.display = 'none'; lastHorizonTop = null; }
    return;
  }
  const top = Math.round(canvas.offsetTop + t * canvas.offsetHeight);
  if (top === lastHorizonTop) return;
  lastHorizonTop = top;
  el.style.display = 'block';
  el.style.left = `${canvas.offsetLeft}px`;
  el.style.width = `${canvas.offsetWidth}px`;
  el.style.top = `${top}px`;
}

(function loop() {
  requestAnimationFrame(loop);
  stage.render();
  updateHorizonGuide();
})();
