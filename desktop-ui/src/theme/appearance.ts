export const APPEARANCE_SCHEMES = [
  { id: 'original', label: '原色', color: '#75937b' },
  { id: 'white', label: '纯白', color: '#ffffff' },
  { id: 'black', label: '纯黑', color: '#171717' },
  { id: 'blue', label: '雾蓝', color: '#6286a4' },
  { id: 'sand', label: '暖沙', color: '#ac8964' },
  { id: 'lavender', label: '淡紫', color: '#8e7eac' },
  { id: 'rose', label: '玫瑰', color: '#ae7f8b' },
  { id: 'graphite', label: '石墨', color: '#73818e' }
] as const;
export type AppearanceScheme = typeof APPEARANCE_SCHEMES[number]['id'];
export interface AppearancePreferences { scheme: AppearanceScheme; accent: string | null; image: string | null; strength: number; blur: number }
export const DEFAULT_APPEARANCE: AppearancePreferences = { scheme: 'original', accent: null, image: null, strength: 20, blur: 0 };
const KEY = 'cetamesh.appearance.v1';
const hex = (value: unknown): value is string => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
const background = (value: unknown): value is string => typeof value === 'string' && value.length <= 1400000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
function storage(): Storage | null { return typeof window === 'undefined' ? null : window.localStorage; }
export function normalizeAppearance(value: unknown): AppearancePreferences {
  const row = value && typeof value === 'object' ? value as Partial<AppearancePreferences> : {};
  return { scheme: APPEARANCE_SCHEMES.some(item => item.id === row.scheme) ? row.scheme! : 'original',
    accent: hex(row.accent) ? row.accent.toLowerCase() : null, image: background(row.image) ? row.image : null,
    strength: typeof row.strength === 'number' && Number.isFinite(row.strength) ? Math.min(60, Math.max(0, Math.round(row.strength))) : 20,
    blur: typeof row.blur === 'number' && Number.isFinite(row.blur) ? Math.min(16, Math.max(0, Math.round(row.blur))) : 0 };
}
export function readAppearance(target?: Pick<Storage, 'getItem'> | null): AppearancePreferences {
  try { return normalizeAppearance(JSON.parse((target === undefined ? storage() : target)?.getItem(KEY) || 'null')); }
  catch { return { ...DEFAULT_APPEARANCE }; }
}
export function writeAppearance(value: AppearancePreferences, target?: Pick<Storage, 'setItem'> | null): AppearancePreferences {
  const next = normalizeAppearance(value);
  if (value.image !== next.image) throw new Error('背景图片格式或大小无效。');
  const destination = target === undefined ? storage() : target;
  if (!destination && typeof window !== 'undefined') throw new Error('当前窗口无法保存外观设置，请检查本机存储。');
  destination?.setItem(KEY, JSON.stringify(next));
  return next;
}
export function mixColor(left: string, right: string, weight: number): string {
  return '#' + [1, 3, 5].map(offset => Math.round(parseInt(left.slice(offset, offset + 2), 16) * (1 - weight) + parseInt(right.slice(offset, offset + 2), 16) * weight).toString(16).padStart(2, '0')).join('');
}
// Only resolved color tokens cross the native boundary, never CSS, paths or images.
export function captionPalette(colors: Record<string, string>, modal: boolean): [string, string, string, string, string, string, string] {
  const names = ['--background-soft', '--surface-hover', '--accent-soft', '--text-primary', '--text-secondary', '--accent-hover', '--surface-hover'];
  const fallback = ['#f7f6f1', '#f0f2eb', '#e7eee7', '#2e3630', '#59645c', '#5e8067', '#f0f2eb'];
  return names.map((name, index) => {
    const color = colors[name]?.trim();
    const resolved = hex(color) ? color : fallback[index];
    return modal ? mixColor(resolved, '#141a15', .42) : resolved;
  }) as [string, string, string, string, string, string, string];
}
const tones = {
  blue: ['#eff4f8', '#6286a4', '#14212c', '#9bbfdd'], sand: ['#f6f1e9', '#9c7953', '#241e17', '#c9ad89'],
  lavender: ['#f3f0f8', '#8975a6', '#201b29', '#baa6d6'], rose: ['#f8f0f2', '#a16f7e', '#271d22', '#d3a2b2'],
  graphite: ['#f0f2f4', '#687985', '#191e23', '#afbdc8']
} as const;
export function appearanceColors(value: AppearancePreferences, dark: boolean): Record<string, string> {
  let colors: Record<string, string> = {};
  if (value.scheme !== 'original') {
    const tone = value.scheme in tones ? tones[value.scheme as keyof typeof tones] : null;
    const base = tone ? tone[dark ? 2 : 0] : dark ? '#000000' : '#ffffff';
    const accent = tone ? tone[dark ? 3 : 1] : dark ? '#c6cbd1' : '#59636e';
    colors = { '--background': base, '--background-soft': mixColor(base, dark ? '#ffffff' : '#000000', dark ? .035 : .015),
      '--surface': mixColor(base, dark ? '#ffffff' : '#ffffff', dark ? .055 : .55), '--surface-elevated': mixColor(base, '#ffffff', dark ? .085 : .82),
      '--surface-hover': mixColor(base, accent, .12), '--text-primary': dark ? '#eff1f3' : '#272d34', '--text-secondary': dark ? '#bdc5cd' : '#56616d',
      '--text-muted': dark ? '#94a0ac' : '#77838f', '--border': mixColor(base, dark ? '#ffffff' : '#000000', dark ? .16 : .11),
      '--border-strong': mixColor(base, dark ? '#ffffff' : '#000000', dark ? .26 : .2), '--accent': accent,
      '--accent-hover': mixColor(accent, dark ? '#ffffff' : '#000000', .15), '--accent-soft': mixColor(base, accent, dark ? .16 : .12), '--on-accent': dark ? '#11171d' : '#ffffff' };
  }
  if (value.accent) {
    const accent = value.accent, base = colors['--background'] || (dark ? '#171d1a' : '#f1f0ea');
    const brightness = [1, 3, 5].reduce((sum, offset, index) => sum + parseInt(accent.slice(offset, offset + 2), 16) * [299, 587, 114][index], 0) / 1000;
    Object.assign(colors, { '--accent': accent, '--accent-hover': mixColor(accent, dark ? '#ffffff' : '#000000', .15), '--accent-soft': mixColor(base, accent, .15), '--on-accent': brightness > 150 ? '#152018' : '#ffffff' });
  }
  return colors;
}
const properties = ['--background', '--background-soft', '--surface', '--surface-elevated', '--surface-hover', '--text-primary', '--text-secondary', '--text-muted', '--border', '--border-strong', '--accent', '--accent-hover', '--accent-soft', '--on-accent'];
export function applyAppearance(root: HTMLElement, value: AppearancePreferences, dark: boolean) {
  for (const name of properties) root.style.removeProperty(name);
  for (const [name, color] of Object.entries(appearanceColors(value, dark))) root.style.setProperty(name, color);
  root.dataset.colorScheme = value.scheme;
  root.dataset.customBackground = value.image ? 'true' : 'false';
  root.style.setProperty('--custom-background-image', value.image ? `url("${value.image}")` : 'none');
  root.style.setProperty('--custom-background-strength', String(value.strength / 100));
  root.style.setProperty('--custom-background-blur', `${value.blur}px`);
}
export async function importBackgroundFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
  if (file.size > 10 * 1024 * 1024) throw new Error('请选择不超过 10 MB 的背景图片。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('无法读取这张图片，请更换文件。')); image.src = url; });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40000000) throw new Error('图片尺寸过大，请使用较小的背景图片。');
    const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('当前窗口无法处理背景图片。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [.85, .65, .45]) { const result = canvas.toDataURL('image/webp', quality); if (background(result)) return result; }
    throw new Error('图片内容过大，请更换较小的背景图片。');
  } finally { URL.revokeObjectURL(url); }
}
