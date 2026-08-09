// Frame geometry shared by the live viewport and the PNG export.
//
// The site photo is a CSS background behind the canvas; the export redraws it
// with a 2D context. Those two paths only agree if they are handed the same
// aspect ratio, so every rule about how the photo lands in the frame lives here
// and is used by both. See `docs` in README: "Why the frame is locked".

/** Largest edge an export is allowed to reach when matched to a photo. */
export const MAX_EXPORT_PX = 6000;

/**
 * Centre a box of `aspect` (w/h) inside `boxW x boxH`, letterboxing the
 * leftover. Returns integer pixels — the canvas is sized from this, and a
 * fractional canvas size costs you a blurry half-pixel of resampling.
 */
export function letterbox(boxW, boxH, aspect) {
  const bw = Math.max(1, Math.floor(boxW));
  const bh = Math.max(1, Math.floor(boxH));
  if (!isFinite(aspect) || aspect <= 0) return { x: 0, y: 0, w: bw, h: bh };

  let w = bw;
  let h = Math.round(bw / aspect);
  if (h > bh) {
    h = bh;
    w = Math.round(bh * aspect);
  }
  w = Math.max(1, Math.min(bw, w));
  h = Math.max(1, Math.min(bh, h));
  return { x: Math.floor((bw - w) / 2), y: Math.floor((bh - h) / 2), w, h };
}

/**
 * The size the site photo is drawn at inside a `frameW x frameH` frame, before
 * the user's pan/zoom/rotate is applied. Mirrors CSS `background-size` exactly:
 * `contain` fits the whole photo, `cover` fills the frame, anything else
 * stretches. Position is always centred, matching `background-position: center`.
 */
export function photoDrawRect(fitMode, imgW, imgH, frameW, frameH) {
  const imgAspect = (imgW || 1) / (imgH || 1);
  const frameAspect = (frameW || 1) / (frameH || 1);
  let w = frameW;
  let h = frameH;
  if (fitMode === 'cover') {
    if (imgAspect > frameAspect) w = frameH * imgAspect;
    else h = frameW / imgAspect;
  } else if (fitMode === 'contain') {
    if (imgAspect > frameAspect) h = frameW / imgAspect;
    else w = frameH * imgAspect;
  }
  return { w, h };
}

/**
 * Has the photo been moved inside the frame — panned, zoomed, or rotated?
 *
 * This is the one state where a transparent "cutout" export no longer registers
 * against the original photo file: the plate was composed against the photo as
 * transformed here, so dropping it onto the untouched original in Photoshop puts
 * the home in the wrong place. Callers use this to warn at the moment it matters.
 */
export function photoIsTransformed(sp) {
  if (!sp) return false;
  const near = (v, target) => Math.abs((v ?? target) - target) < 1e-6;
  return !(near(sp.scale, 1) && near(sp.panX, 0) && near(sp.panY, 0) && near(sp.rotation, 0));
}

/**
 * Export pixel size that matches a site photo's own pixels, so a transparent
 * export drops onto the untouched photo in Photoshop/Affinity without any
 * scaling. Only oversized photos are reduced, and then proportionally — a
 * rounded-off aspect ratio is exactly the drift this whole module exists to
 * prevent.
 */
export function matchExportToPhoto(natW, natH, maxPx = MAX_EXPORT_PX) {
  const w = Math.round(natW);
  const h = Math.round(natH);
  if (!(w > 0) || !(h > 0)) return null;
  const longest = Math.max(w, h);
  if (longest <= maxPx) return { w, h };
  const k = maxPx / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
