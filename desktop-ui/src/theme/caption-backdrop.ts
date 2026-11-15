import type { AppearancePreferences } from './appearance';
import type { CaptionFrame, CaptionSurface } from '../bridge/typed-client';

export const WALLPAPER_OVERSCAN = 24;
export const CHROME_GLASS_TINT = .68;
export const CHROME_GLASS_BLUR = 16;
const MAX_WIDTH = 1024, MAX_HEIGHT = 96;
const positive = (value: number) => Number.isFinite(value) && value > 0;

/** The content pseudo-element and the native strip use the same cover plane. */
export function wallpaperCover(width: number, height: number, imageWidth: number, imageHeight: number, overscan = WALLPAPER_OVERSCAN) {
  if (![width, height, imageWidth, imageHeight].every(positive) || !Number.isFinite(overscan) || overscan < 0) throw new Error('Invalid wallpaper geometry');
  const planeWidth = width + overscan * 2, planeHeight = height + overscan * 2;
  const scale = Math.max(planeWidth / imageWidth, planeHeight / imageHeight);
  const drawnWidth = imageWidth * scale, drawnHeight = imageHeight * scale;
  return { x: (width - drawnWidth) / 2, y: (height - drawnHeight) / 2, width: drawnWidth, height: drawnHeight };
}

export function captionSampleSize(width: number, height: number) {
  if (![width, height].every(positive)) throw new Error('Invalid caption geometry');
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function validCaptionFrame(value: unknown): value is CaptionFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as CaptionFrame;
  return typeof frame.id === 'string' && /^[a-zA-Z0-9-]{1,96}$/.test(frame.id)
    && [frame.width, frame.height, frame.captionHeight].every(n => Number.isInteger(n) && n > 0 && n <= 16384)
    && frame.captionHeight <= 768 && frame.captionHeight < frame.height;
}

export function encodeCaptionPixels(bytes: Uint8ClampedArray): string {
  if (!bytes.length || bytes.length % 4) throw new Error('Invalid caption pixel data');
  if (bytes.length > MAX_WIDTH * MAX_HEIGHT * 4) throw new Error('Caption pixel budget exceeded');
  for (let i = 3; i < bytes.length; i += 4) if (bytes[i] !== 255) throw new Error('Caption pixels must be opaque');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/** Only the small, precomposited strip crosses the Host bridge. */
export function renderCaptionStrip(image: HTMLImageElement, frame: CaptionFrame, viewport: { width: number; height: number }, appearance: AppearancePreferences, colors: { background: string; tint: string }): CaptionSurface {
  if (!validCaptionFrame(frame) || ![viewport.width, viewport.height].every(positive)) throw new Error('Invalid caption frame');
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40000000) throw new Error('Invalid wallpaper dimensions');
  const captionHeight = frame.captionHeight * viewport.width / frame.width;
  const cover = wallpaperCover(viewport.width, viewport.height + captionHeight, image.naturalWidth, image.naturalHeight);
  const sample = captionSampleSize(frame.width, frame.captionHeight);
  const scaleX = sample.width / viewport.width, scaleY = sample.height / captionHeight;
  const blur = Math.hypot(CHROME_GLASS_BLUR, appearance.blur), padding = Math.ceil(blur * Math.max(scaleX, scaleY) * 3) + 2;
  const padded = document.createElement('canvas'); padded.width = sample.width + padding * 2; padded.height = sample.height + padding * 2;
  const ctx = padded.getContext('2d'); if (!ctx) throw new Error('Caption canvas unavailable');
  ctx.fillStyle = colors.background; ctx.fillRect(0, 0, padded.width, padded.height);
  ctx.save();
  ctx.filter = `blur(${blur * Math.max(scaleX, scaleY)}px)`; ctx.globalAlpha = appearance.strength / 100;
  ctx.drawImage(image, padding + cover.x * scaleX, padding + cover.y * scaleY, cover.width * scaleX, cover.height * scaleY); ctx.restore();
  ctx.globalAlpha = CHROME_GLASS_TINT; ctx.fillStyle = colors.tint; ctx.fillRect(0, 0, padded.width, padded.height); ctx.globalAlpha = 1;
  const pixels = ctx.getImageData(padding, padding, sample.width, sample.height).data;
  // The parent HWND owns a narrow resize border outside WebView. Send only its
  // three sampled wallpaper edges, not a full frame or a filesystem image path.
  const edgeSize = 1024;
  const fullHeight = viewport.height + captionHeight;
  const planeScale = Math.min(1, edgeSize / Math.max(viewport.width, fullHeight));
  const plane = document.createElement('canvas'); plane.width = Math.max(1, Math.round(viewport.width * planeScale)); plane.height = Math.max(1, Math.round(fullHeight * planeScale));
  const edgeCtx = plane.getContext('2d'); if (!edgeCtx) throw new Error('Perimeter canvas unavailable');
  const sx = plane.width / viewport.width, sy = plane.height / fullHeight;
  edgeCtx.fillStyle = colors.background; edgeCtx.fillRect(0, 0, plane.width, plane.height);
  edgeCtx.save(); edgeCtx.globalAlpha = appearance.strength / 100;
  edgeCtx.filter = `blur(${appearance.blur * Math.max(sx, sy)}px)`;
  edgeCtx.drawImage(image, cover.x * sx, cover.y * sy, cover.width * sx, cover.height * sy); edgeCtx.restore();
  const atlas = document.createElement('canvas'); atlas.width = edgeSize; atlas.height = 3;
  const atlasCtx = atlas.getContext('2d'); if (!atlasCtx) throw new Error('Perimeter atlas unavailable');
  // Right and bottom meet the bare wallpaper in the panel's 2px outer gutter.
  atlasCtx.save(); atlasCtx.translate(0, 2); atlasCtx.rotate(-Math.PI / 2);
  atlasCtx.drawImage(plane, plane.width - 1, 0, 1, plane.height, 0, 0, 1, edgeSize); atlasCtx.restore();
  atlasCtx.drawImage(plane, 0, plane.height - 1, plane.width, 1, 0, 2, edgeSize, 1);
  // Left meets the frosted rail, not the bare wallpaper. Match both its blur
  // and tint to the caption so no saturated strip appears along that seam.
  edgeCtx.fillStyle = colors.background; edgeCtx.fillRect(0, 0, plane.width, plane.height);
  edgeCtx.save(); edgeCtx.globalAlpha = appearance.strength / 100;
  edgeCtx.filter = `blur(${blur * Math.max(sx, sy)}px)`;
  edgeCtx.drawImage(image, cover.x * sx, cover.y * sy, cover.width * sx, cover.height * sy); edgeCtx.restore();
  edgeCtx.globalAlpha = CHROME_GLASS_TINT; edgeCtx.fillStyle = colors.tint; edgeCtx.fillRect(0, 0, plane.width, plane.height); edgeCtx.globalAlpha = 1;
  atlasCtx.save(); atlasCtx.translate(0, 1); atlasCtx.rotate(-Math.PI / 2);
  atlasCtx.drawImage(plane, 0, 0, 1, plane.height, 0, 0, 1, edgeSize); atlasCtx.restore();
  const railWidth = document.querySelector('.navigation-rail')?.getBoundingClientRect().width ?? 0;
  if (railWidth > 0) atlasCtx.drawImage(plane, 0, plane.height - 1, railWidth * sx, 1, 0, 2, railWidth / viewport.width * edgeSize, 1);
  const edges = atlasCtx.getImageData(0, 0, edgeSize, 3).data;
  return { frame: frame.id, ...sample, pixels: encodeCaptionPixels(pixels), edges: encodeCaptionPixels(edges) };
}
