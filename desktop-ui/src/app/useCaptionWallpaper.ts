import { useEffect, useRef } from 'react';
import { hostClient, type NativeCaptionBackdrop } from '../bridge/typed-client';
import type { AppearancePreferences } from '../theme/appearance';
import { renderCaptionStrip, validCaptionFrame } from '../theme/caption-backdrop';
import type { ThemeMode } from '../stores/ui';

/** Keep image decoding/canvas work in the renderer; the native host gets pixels. */
export function useCaptionWallpaper(native: boolean, projection: NativeCaptionBackdrop | null, appearance: AppearancePreferences, theme: ThemeMode) {
  const generation = useRef(0), canSend = useRef(false);
  const loaded = useRef<{ source: string; image: Promise<HTMLImageElement> } | null>(null);
  canSend.current = !!(native && projection?.enabled);
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const contrast = window.matchMedia('(forced-colors: active)');
    const transparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
    let disposed = false, pending = 0;
    const clear = () => {
      root.removeAttribute('data-caption-wallpaper'); root.style.removeProperty('--native-caption-height');
      if (canSend.current) void hostClient.captionBackdrop(null).catch(() => {});
    };
    const update = async () => {
      pending = 0;
      const ticket = ++generation.current;
      if (!native || !projection?.enabled || !validCaptionFrame(projection.frame) || !appearance.image || contrast.matches || transparency.matches) {
        loaded.current = null; clear(); return;
      }
      try {
        const source = appearance.image;
        if (loaded.current?.source !== source) {
          const image = new Image();
          const decoded = new Promise<HTMLImageElement>((resolve, reject) => { image.onload = () => resolve(image); image.onerror = () => reject(new Error('Wallpaper decode failed')); });
          image.src = source; loaded.current = { source, image: decoded };
        }
        const image = await loaded.current.image;
        if (disposed || ticket !== generation.current) return;
        const frame = projection.frame, viewport = { width: innerWidth, height: innerHeight };
        const style = getComputedStyle(root);
        const surface = renderCaptionStrip(image, frame, viewport, appearance, {
          background: style.getPropertyValue('--background-soft').trim(), tint: style.getPropertyValue('--background-soft').trim()
        });
        const result = await hostClient.captionBackdrop(surface);
        if (disposed || ticket !== generation.current) return;
        if (result.applied) {
          root.style.setProperty('--native-caption-height', `${frame.captionHeight * viewport.width / frame.width}px`);
          root.dataset.captionWallpaper = 'active';
        } else clear();
      } catch {
        if (!disposed && ticket === generation.current) clear();
      }
    };
    const schedule = () => { ++generation.current; if (!pending) pending = requestAnimationFrame(() => void update()); };
    // Parent layout effects apply palette tokens before this scheduled paint.
    schedule(); media.addEventListener('change', schedule); contrast.addEventListener('change', schedule); transparency.addEventListener('change', schedule);
    return () => {
      disposed = true; ++generation.current; cancelAnimationFrame(pending);
      media.removeEventListener('change', schedule); contrast.removeEventListener('change', schedule); transparency.removeEventListener('change', schedule);
    };
  }, [native, projection?.enabled, projection?.frame.id, appearance, theme]);
  useEffect(() => () => {
    ++generation.current; loaded.current = null;
    document.documentElement.removeAttribute('data-caption-wallpaper'); document.documentElement.style.removeProperty('--native-caption-height');
    if (canSend.current) void hostClient.captionBackdrop(null).catch(() => {});
  }, []);
}
