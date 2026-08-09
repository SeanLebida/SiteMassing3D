// Default home spec and shared constants. Units are FEET throughout the app;
// one three.js world unit == one foot.

export const WALLS = ['front', 'back', 'left', 'right'];

export const WALL_LABEL = {
  front: 'Front (long wall)',
  back: 'Rear (long wall)',
  left: 'Left end (gable)',
  right: 'Right end (gable)',
};

let seq = 0;
export const nextId = (prefix) => `${prefix}${(++seq).toString(36)}${Date.now().toString(36).slice(-3)}`;

export const OPENING_PRESETS = {
  door:   { widthFt: 3.0,  heightFt: 6.67, sillFt: 0,   label: 'Entry door' },
  slider: { widthFt: 6.0,  heightFt: 6.67, sillFt: 0,   label: 'Sliding door' },
  window: { widthFt: 4.0,  heightFt: 3.5,  sillFt: 3.5, label: 'Window' },
};

export function defaultHome() {
  return {
    name: 'Untitled double-wide',
    // Placeholder dimensions — replace with the W' x L' line off the spec sheet.
    dimensions: {
      widthFt: 27,
      lengthFt: 56,
      wallHeightFt: 8,
      floorHeightFt: 2.5,
      roofPitch: 4,          // rise per 12 of run
      eaveOverhangFt: 1.0,   // horizontal overhang past the long walls
      rakeOverhangFt: 0.75,  // horizontal overhang past the gable ends
      roofStyle: 'gable',
      dormerCount: 0,         // 0 (none), 1 (single), 2 (double)
      dormerStyle: 'gable',   // 'gable', 'shed', 'hip'
      dormerWidthFt: 10.0,
      dormerHeightFt: 4.5,
      dormerFalseEave: true,
      dormerInnerFalseEave: true,  // nested inner return band (double-wide)
      dormerConnected: false,      // merge double dormers into one continuous cap
      dormerWindow: true,
      dormerPositions: [],          // custom X offsets in ft; empty = auto-place
    },
    colors: {
      siding: '#8d9299',
      trim: '#f2f2f0',
      roof: '#3a3d42',
      skirting: '#e6e6e1',
      door: '#f2f2f0',
      glass: '#4d6070',
    },
    openings: [
      { id: nextId('d'), type: 'door',   wall: 'front', offsetFt: 14, widthFt: 3, heightFt: 6.67, sillFt: 0, label: 'Main entry' },
      { id: nextId('d'), type: 'door',   wall: 'back',  offsetFt: 38, widthFt: 3, heightFt: 6.67, sillFt: 0, label: 'Rear / utility door' },
      { id: nextId('w'), type: 'window', wall: 'front', offsetFt: 5,  widthFt: 4, heightFt: 3.5, sillFt: 3.5, label: 'Living room' },
      { id: nextId('w'), type: 'window', wall: 'front', offsetFt: 24, widthFt: 4, heightFt: 3.5, sillFt: 3.5, label: 'Kitchen' },
      { id: nextId('w'), type: 'window', wall: 'front', offsetFt: 44, widthFt: 4, heightFt: 3.5, sillFt: 3.5, label: 'Bedroom 2' },
      { id: nextId('w'), type: 'window', wall: 'left',  offsetFt: 9,  widthFt: 4, heightFt: 3.5, sillFt: 3.5, label: 'Primary bedroom' },
      { id: nextId('w'), type: 'window', wall: 'right', offsetFt: 9,  widthFt: 3, heightFt: 3.5, sillFt: 3.5, label: 'Bedroom 3' },
    ],
    plan: { src: null, widthFt: 56, offsetX: 0, offsetZ: 0, rotation: 0, opacity: 0.65, show: true },
    // natW/natH are the photo's own pixel size, read on load. They are what the
    // export is matched to, so a transparent plate lands on the untouched photo
    // pixel-for-pixel in Photoshop / Affinity.
    sitePhoto: { src: null, show: true, fitMode: 'contain', opacity: 0.85, scale: 1.0, panX: 0, panY: 0, rotation: 0, baselineY: 0, camDist: 60, posX: 0, posZ: 0, rotY: 0, natW: 0, natH: 0 },
  };
}

export function defaultScene() {
  return {
    sunAz: 135,
    sunEl: 42,
    flat: 0.6,        // 0 = hard directional sun, 1 = flat overcast
    focal: 35,        // mm, 35mm-equivalent
    eye: 5.5,         // eye height in ft for the "Eye level" preset
    bg: '#20242a',
    grid: true,
    shadow: true,
    steps: true,
    stepLanding: true,
    landingDepthFt: 3.5,
    stepRailings: 'both', // 'none', 'left', 'right', 'both'
    railMat: 'pressure_treated', // 'pressure_treated', 'white_trim', 'black_metal', 'matching_trim'
    balusterStyle: 'balusters', // 'balusters', 'horizontal_cables', 'open'
    wireframe: false,
    blockLandscape: false,
    labels: false,
    dims: false,
    horizon: false,   // draw the ground-plane horizon guide for camera matching
  };
}

export function defaultExport() {
  // lockFrame letterboxes the viewport to the export's aspect ratio, so what you
  // align on screen is what the PNG contains. Off, the photo re-fits and the
  // camera's horizontal field changes at export time, and the overlay drifts.
  return { w: 2400, h: 1600, alpha: false, burn: true, lockFrame: true };
}

export function migrate(home) {
  const base = defaultHome();
  const out = {
    name: home.name || base.name,
    dimensions: { ...base.dimensions, ...(home.dimensions || {}) },
    colors: { ...base.colors, ...(home.colors || {}) },
    openings: (home.openings || []).map((o) => ({
      id: o.id || nextId('o'),
      type: o.type || 'window',
      wall: o.wall || 'front',
      offsetFt: +o.offsetFt || 0,
      widthFt: +o.widthFt || 3,
      heightFt: +o.heightFt || 3,
      sillFt: +o.sillFt || 0,
      label: o.label || '',
      stepMat: o.stepMat,
      stepEgress: o.stepEgress,
      railMat: o.railMat,
      balusterStyle: o.balusterStyle,
    })),
    plan: { ...base.plan, ...(home.plan || {}) },
    sitePhoto: { ...base.sitePhoto, ...(home.sitePhoto || {}) },
  };
  return out;
}
