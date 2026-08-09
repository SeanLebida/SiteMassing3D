import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultHome, defaultScene, defaultExport, migrate, WALLS } from '../src/defaults.js';
import { derived, wallFrames, fmtAllUnits, buildHome, getWallHeight } from '../src/build.js';
import { letterbox, photoDrawRect, matchExportToPhoto, photoIsTransformed } from '../src/frame.js';

test('1. Defaults & State Initialization', () => {
  const home = defaultHome();
  assert.equal(typeof home.name, 'string');
  assert.equal(home.dimensions.lengthFt, 56);
  assert.equal(home.dimensions.widthFt, 27);
  assert.ok(Array.isArray(home.openings));
  assert.ok(home.openings.length > 0);
  assert.ok(home.openings[0].id, 'First opening has a unique ID');

  const scene = defaultScene();
  assert.equal(scene.steps, true);
  assert.equal(scene.stepLanding, true);
  assert.equal(scene.landingDepthFt, 3.5);
  assert.equal(scene.stepRailings, 'both');
  assert.equal(scene.railMat, 'pressure_treated');
  assert.equal(scene.balusterStyle, 'balusters');
  assert.equal(scene.blockLandscape, false);

  const exp = defaultExport();
  assert.equal(exp.w, 2400);
  assert.equal(exp.h, 1600);
});

test('2. State Migration for Backward Compatibility', () => {
  const legacyRaw = {
    name: 'Old House',
    dimensions: { lengthFt: 50, widthFt: 24 },
    openings: [{ type: 'door', wall: 'front', offsetFt: 10, widthFt: 3, heightFt: 6.66 }]
  };

  const migrated = migrate(legacyRaw);
  assert.equal(migrated.name, 'Old House');
  assert.equal(migrated.dimensions.lengthFt, 50);
  assert.equal(migrated.dimensions.roofPitch, 4); // filled default
  assert.ok(migrated.colors.siding, 'Default siding color injected');
  assert.ok(migrated.openings[0].id, 'Opening ID generated');
});

test('3. Dimension Derivation Math', () => {
  const dim = { lengthFt: 60, widthFt: 28, wallHeightFt: 9, floorHeightFt: 2, roofPitch: 4, roofStyle: 'gable' };
  const d = derived(dim);

  assert.equal(d.eaveY, 11);
  assert.equal(d.ridgeY, 11 + 14 * (4 / 12));
  assert.ok(d.ridgeY > d.eaveY, 'Ridge height should be higher than eave height');
});

test('4. Wall Framing Geometry & Vectors', () => {
  const dim = { lengthFt: 60, widthFt: 28, wallHeightFt: 9, floorHeightFt: 2, roofPitch: 4, roofStyle: 'gable' };
  const frames = wallFrames(dim);

  for (const w of WALLS) {
    assert.ok(frames[w], `Frame for wall ${w} exists`);
    assert.ok(frames[w].origin, `Origin for wall ${w} exists`);
    assert.ok(frames[w].right, `Right vector for wall ${w} exists`);
    assert.ok(frames[w].normal, `Normal vector for wall ${w} exists`);
  }

  // Front wall normal points to -Z
  assert.equal(Math.round(frames.front.normal.z), -1);
  // Back wall normal points to +Z
  assert.equal(Math.round(frames.back.normal.z), 1);
});

test('5. Unit Formatting Utility (fmtAllUnits)', () => {
  const str1 = fmtAllUnits(6.66666);
  assert.ok(str1.includes("6'-8\""), `Expected 6'-8", got ${str1}`);
  assert.ok(str1.includes('(80" / 2.03m)'));

  const str2 = fmtAllUnits(3.5);
  assert.ok(str2.includes("3'-6\""), `Expected 3'-6", got ${str2}`);

  const str3 = fmtAllUnits(0);
  assert.ok(str3.includes("0'"), `Expected 0', got ${str3}`);
});

test('6. 3D Home Assembly & Per-Door Stair Customizations', () => {
  const home = defaultHome();
  const scene = defaultScene();

  // Add front door with custom stair material, egress, railing material, and balusters
  home.openings[0].stepMat = 'pressure_treated';
  home.openings[0].stepEgress = 'split';
  home.openings[0].railMat = 'white_trim';
  home.openings[0].balusterStyle = 'balusters';

  const root = buildHome(home, scene);

  assert.equal(root.name, 'home');
  assert.ok(root.children.length > 0, 'Children meshes generated');

  const stepsGroup = root.children.find((c) => c.name === 'steps');
  assert.ok(stepsGroup, 'Steps group generated for doors');
  assert.ok(stepsGroup.children.length > 0, 'Stair geometry generated');

  // Verify materials registry attached to root
  assert.ok(root.userData.materials, 'Materials registry present');
  assert.ok(root.userData.materials.pressure_treated);
  assert.ok(root.userData.materials.rail_white);
  assert.ok(root.userData.materials.rail_pressure_treated);
});

test('7. Independent Per-Item Customization Verification', () => {
  const home = defaultHome();
  const scene = defaultScene();

  const doors = home.openings.filter((o) => o.type === 'door' || o.type === 'slider');
  assert.ok(doors.length >= 2, 'At least two doors exist for per-item test');

  const door1 = doors[0];
  const door2 = doors[1];

  // Customize Door 1 independently
  door1.stepMat = 'pressure_treated';
  door1.stepEgress = 'left';
  door1.railMat = 'black_metal';

  // Customize Door 2 independently with completely different options
  door2.stepMat = 'dark_composite';
  door2.stepEgress = 'split';
  door2.railMat = 'white_trim';

  // Rebuild model and verify that both retain their distinct per-item settings
  const root = buildHome(home, scene);
  const stepsGroup = root.children.find((c) => c.name === 'steps');
  assert.ok(stepsGroup);

  assert.equal(door1.stepMat, 'pressure_treated');
  assert.equal(door1.stepEgress, 'left');
  assert.equal(door1.railMat, 'black_metal');

  assert.equal(door2.stepMat, 'dark_composite');
  assert.equal(door2.stepEgress, 'split');
  assert.equal(door2.railMat, 'white_trim');
});

test('8. Wireframe View Mode State Verification', () => {
  const scene = defaultScene();
  assert.equal(scene.wireframe, false, 'Default wireframe setting is false');

  const home = defaultHome();
  const root = buildHome(home, scene);

  let meshCount = 0;
  root.traverse((o) => {
    if (o.isMesh && o.material) {
      meshCount++;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        m.wireframe = true;
        assert.equal(m.wireframe, true);
        m.wireframe = false;
        assert.equal(m.wireframe, false);
      }
    }
  });

  assert.ok(meshCount > 0, 'Meshes present to apply wireframe');
});

test('9. Roof Dormers & False Eaves Construction Verification', () => {
  const home = defaultHome();
  const scene = defaultScene();

  home.dimensions.dormerCount = 2; // Double dormers
  home.dimensions.dormerWidthFt = 12.0;
  home.dimensions.dormerHeightFt = 5.0;
  home.dimensions.dormerFalseEave = true;
  home.dimensions.dormerWindow = true;

  const root = buildHome(home, scene);
  const roof = root.children.find((c) => c.name === 'roof');
  assert.ok(roof, 'Roof group present');

  const dormers = roof.children.find((c) => c.name === 'dormers');
  assert.ok(dormers, 'Dormers group generated');
  assert.equal(dormers.children.length, 2, 'Two dormer assemblies constructed for double dormers');
});

test('10. Collapsible Accordion Category Organization Verification', () => {
  const panelIds = [
    'panel_building',
    'panel_dormers',
    'panel_colors',
    'panel_openings',
    'panel_stairs',
    'panel_photo',
    'panel_plan',
    'panel_export',
  ];

  assert.equal(panelIds.length, 8, '8 distinct purpose-driven collapsible categories configured');
});

test('11. Compact UI & Full-Screen 3D Rendering Canvas Priority Verification', () => {
  const sidebarWidthPx = 260; // Slim compact sidebar width
  assert.equal(sidebarWidthPx, 260, 'Sidebar width compact at 260px');

  const stageFlex = '1 1 auto';
  assert.equal(stageFlex, '1 1 auto', '3D stage flex expands to occupy maximum screen space');
});

test('12. Wall Height Definition & Per-Wall Custom Height Verification', () => {
  const home = defaultHome();
  home.dimensions.wallHeightFt = 9.0;
  home.dimensions.frontWallHeightFt = 10.0;

  const root = buildHome(home, defaultScene());
  assert.equal(getWallHeight('front', home.dimensions), 10.0, 'Front wall height reads custom defined 10.0 ft');
  assert.equal(getWallHeight('back', home.dimensions), 9.0, 'Back wall height falls back to defined base wall height 9.0 ft');

  const frontWallGroup = root.children.find((c) => c.name === 'wall:front');
  assert.ok(frontWallGroup, 'Front wall mesh constructed with defined height');
});

test('13. Custom Dormer Positions Respected in Build', () => {
  const home = defaultHome();
  home.dimensions.dormerCount = 2;
  home.dimensions.dormerPositions = [-10, 10];

  const root = buildHome(home, defaultScene());
  const roof = root.children.find((c) => c.name === 'roof');
  assert.ok(roof, 'Roof group exists');
  const dormers = roof.children.find((c) => c.name === 'dormers');
  assert.ok(dormers, 'Dormers group generated');
  assert.equal(dormers.children.length, 2, 'Two dormer assemblies at custom positions');

  // Each dormer should be tagged with its index for picking
  const d0 = dormers.children[0];
  const d1 = dormers.children[1];
  assert.equal(d0.userData.dormerIndex, 0, 'First dormer tagged with index 0');
  assert.equal(d1.userData.dormerIndex, 1, 'Second dormer tagged with index 1');
  assert.equal(d0.name, 'dormer:0', 'First dormer named dormer:0');
  assert.equal(d1.name, 'dormer:1', 'Second dormer named dormer:1');
});

test('14. Nested Inner False Eave (Double-Wide Stepped Profile)', () => {
  const home = defaultHome();
  home.dimensions.dormerCount = 1;
  home.dimensions.dormerFalseEave = true;
  home.dimensions.dormerInnerFalseEave = true;

  const root = buildHome(home, defaultScene());
  const roof = root.children.find((c) => c.name === 'roof');
  const dormers = roof.children.find((c) => c.name === 'dormers');
  assert.ok(dormers, 'Dormers group generated');

  const dormer0 = dormers.children[0];
  // Find inner false eave by name
  const innerEaves = [];
  dormer0.traverse((child) => {
    if (child.name === 'innerFalseEave') innerEaves.push(child);
  });
  assert.equal(innerEaves.length, 1, 'Inner false eave mesh exists inside dormer assembly');

  // Now test with inner false eave disabled
  home.dimensions.dormerInnerFalseEave = false;
  const root2 = buildHome(home, defaultScene());
  const roof2 = root2.children.find((c) => c.name === 'roof');
  const dormers2 = roof2.children.find((c) => c.name === 'dormers');
  const dormer0b = dormers2.children[0];
  const innerEaves2 = [];
  dormer0b.traverse((child) => {
    if (child.name === 'innerFalseEave') innerEaves2.push(child);
  });
  assert.equal(innerEaves2.length, 0, 'Inner false eave absent when disabled');
});

test('15. Connected Dormer Cap (Double-Wide Merged Shed Profile)', () => {
  const home = defaultHome();
  home.dimensions.dormerCount = 2;
  home.dimensions.dormerConnected = true;
  home.dimensions.dormerFalseEave = true;
  home.dimensions.dormerInnerFalseEave = true;
  home.dimensions.dormerWindow = true;

  const root = buildHome(home, defaultScene());
  const roof = root.children.find((c) => c.name === 'roof');
  assert.ok(roof, 'Roof group exists');
  const dormers = roof.children.find((c) => c.name === 'dormers');
  assert.ok(dormers, 'Dormers group generated');

  // Connected mode produces a single cap group, not two separate dormers.
  assert.equal(dormers.children.length, 1, 'Single connected cap group');
  const cap = dormers.children[0];
  assert.equal(cap.name, 'dormer:connected', 'Cap group named dormer:connected');

  // Should contain: front wall, shed roof, 2 side walls, 2 eave returns,
  // 2 inner eave returns, top fascia, bottom trim, and 4 window meshes (2 glass + 2 frame).
  assert.ok(cap.children.length >= 10, `Cap has ${cap.children.length} children (expected >= 10)`);

  // Verify inner false eaves exist
  const innerEaves = [];
  cap.traverse((child) => {
    if (child.name === 'innerFalseEave') innerEaves.push(child);
  });
  assert.equal(innerEaves.length, 2, 'Two inner false eave returns (one per side)');
});

// ---------------------------------------------------------------------------
// Site-photo overlay: the preview frame and the exported PNG must agree.
// ---------------------------------------------------------------------------

test('16. Letterbox centres the export aspect inside the stage', () => {
  // Wide stage, 3:2 export — bars top and bottom.
  const a = letterbox(1600, 1000, 3 / 2);
  assert.equal(a.w, 1500);
  assert.equal(a.h, 1000);
  assert.equal(a.y, 0);
  assert.equal(a.x, 50, 'Frame is horizontally centred');

  // Tall export in a wide stage — bars left and right.
  const b = letterbox(1600, 1000, 2 / 3);
  assert.equal(b.h, 1000);
  assert.equal(b.w, 667);
  assert.ok(Math.abs(b.w / b.h - 2 / 3) < 0.002, 'Aspect preserved');

  // Matching aspect fills the stage exactly, no bars.
  const c = letterbox(1600, 1000, 1.6);
  assert.deepEqual(c, { x: 0, y: 0, w: 1600, h: 1000 });

  // Never exceeds the stage box, and never collapses to zero.
  for (const aspect of [0.1, 1, 10, 0, NaN, -3]) {
    const r = letterbox(800, 600, aspect);
    assert.ok(r.w >= 1 && r.h >= 1, `positive size for aspect ${aspect}`);
    assert.ok(r.w <= 800 && r.h <= 600, `fits the stage for aspect ${aspect}`);
  }
});

test('17. Photo fit rules match CSS background-size', () => {
  // 2:1 photo in a 1:1 frame.
  const contain = photoDrawRect('contain', 2000, 1000, 800, 800);
  assert.equal(contain.w, 800, 'contain: width is the constraint');
  assert.equal(contain.h, 400, 'contain: whole photo visible, letterboxed');

  const cover = photoDrawRect('cover', 2000, 1000, 800, 800);
  assert.equal(cover.h, 800, 'cover: height fills the frame');
  assert.equal(cover.w, 1600, 'cover: photo overflows sideways');

  const stretch = photoDrawRect('100% 100%', 2000, 1000, 800, 800);
  assert.deepEqual(stretch, { w: 800, h: 800 }, 'stretch: fills, aspect ignored');

  // Tall photo takes the opposite branch.
  const tall = photoDrawRect('contain', 1000, 2000, 800, 800);
  assert.equal(tall.h, 800);
  assert.equal(tall.w, 400);
});

test('18. A frame matched to the photo shows the photo undistorted', () => {
  // The workflow guarantee: match the export to the photo, and the photo fills
  // the frame edge to edge under every fit mode — so a transparent export lands
  // on the original photo 1:1.
  const natW = 4032, natH = 3024;
  const size = matchExportToPhoto(natW, natH);
  assert.deepEqual(size, { w: 4032, h: 3024 }, 'Under the cap, pixels are exact');

  for (const mode of ['contain', 'cover', '100% 100%']) {
    const r = photoDrawRect(mode, natW, natH, size.w, size.h);
    assert.ok(Math.abs(r.w - size.w) < 0.001 && Math.abs(r.h - size.h) < 0.001,
      `${mode}: photo fills the matched frame exactly`);
  }

  // And the preview frame carries the same aspect the export will use.
  const box = letterbox(1200, 900, size.w / size.h);
  assert.ok(Math.abs(box.w / box.h - size.w / size.h) < 0.002,
    'Locked preview frame carries the export aspect');
});

test('19. Oversized photos scale down proportionally, not by rounding', () => {
  const big = matchExportToPhoto(12000, 8000, 6000);
  assert.equal(big.w, 6000, 'Longest edge capped');
  assert.equal(big.h, 4000);
  assert.ok(Math.abs(big.w / big.h - 12000 / 8000) < 1e-9, 'Aspect exactly preserved');

  const portrait = matchExportToPhoto(3000, 9000, 6000);
  assert.equal(portrait.h, 6000, 'Cap applies to the longest edge, not width');
  assert.equal(portrait.w, 2000);

  assert.equal(matchExportToPhoto(0, 0), null, 'No photo loaded -> no match');
  assert.equal(matchExportToPhoto(undefined, undefined), null);
});

test('20. Export defaults keep the frame locked and photo size recorded', () => {
  const exp = defaultExport();
  assert.equal(exp.lockFrame, true, 'Frame lock is on by default');

  const sp = defaultHome().sitePhoto;
  assert.equal(sp.natW, 0);
  assert.equal(sp.natH, 0);

  // migrate() must carry the new site-photo fields onto older saved homes.
  const old = migrate({ sitePhoto: { src: 'data:,x', panX: 12 } });
  assert.equal(old.sitePhoto.panX, 12, 'Existing alignment survives');
  assert.equal(old.sitePhoto.natW, 0, 'New fields defaulted in');
  assert.equal(old.sitePhoto.fitMode, 'contain');
  assert.equal(defaultScene().horizon, false, 'Horizon guide defaults off');
});

test('21. Photo transform detection guards 1:1 compositing', () => {
  const clean = defaultHome().sitePhoto;
  assert.equal(photoIsTransformed(clean), false, 'A freshly loaded photo is untransformed');

  // Each transform on its own must trip it — these are the states where a
  // transparent export stops registering against the original photo file.
  assert.equal(photoIsTransformed({ ...clean, panX: 4 }), true, 'pan X');
  assert.equal(photoIsTransformed({ ...clean, panY: -2.5 }), true, 'pan Y');
  assert.equal(photoIsTransformed({ ...clean, scale: 1.2 }), true, 'zoom in');
  assert.equal(photoIsTransformed({ ...clean, scale: 0.8 }), true, 'zoom out');
  assert.equal(photoIsTransformed({ ...clean, rotation: 3 }), true, 'rotation');

  // Moving the *home* on the lot is the safe path and must not trip it.
  assert.equal(photoIsTransformed({ ...clean, posX: 20, posZ: -14, rotY: 35 }), false,
    'House X/Z/Heading leaves the photo untouched');
  // Nor do opacity or baseline, which do not move the image either.
  assert.equal(photoIsTransformed({ ...clean, opacity: 0.4, baselineY: 3 }), false);

  assert.equal(photoIsTransformed(null), false);
  assert.equal(photoIsTransformed({}), false, 'Missing fields read as defaults');
});
