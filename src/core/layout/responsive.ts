export type ScreenVariant = 'standard' | 'form' | 'reader';
export const TTContentWidths = { prose: 640, emptyCopy: 480 } as const;
export interface ResponsiveLayout {
  mode: 'compact' | 'medium' | 'wide'; gutter: number; railWidth: number;
  contentMaxWidth: number; contentWidth: number; columns: number; viewportHeight: number;
}
export function getResponsiveLayout(width: number, height: number, variant: ScreenVariant = 'standard'): ResponsiveLayout {
  width = Number.isFinite(width) ? Math.max(0, width) : 0;
  const mode = width >= 1024 ? 'wide' : width >= 768 ? 'medium' : 'compact';
  const gutter = mode === 'wide' ? 32 : mode === 'medium' ? 24 : 16;
  const railWidth = mode === 'wide' ? 232 : 0;
  const contentMaxWidth = variant === 'reader' ? 1600 : variant === 'form' ? 800 : 1440;
  const contentWidth = Math.max(0, Math.min(contentMaxWidth, width - railWidth) - gutter * 2);
  const desired = width >= 1280 ? 3 : width >= 768 ? 2 : 1;
  const columns = Math.max(1, Math.min(desired, Math.floor((contentWidth + 16) / 296)));
  return { mode, gutter, railWidth, contentMaxWidth, contentWidth, columns,
    viewportHeight: Number.isFinite(height) ? Math.max(0, height) : 0 };
}
