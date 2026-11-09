import { useMemo } from 'react';
import type { ViewStyle, TextStyle, ImageStyle } from 'react-native';
import { useColors } from './ThemeContext';

/** Retains the existing screen geometry while applying the shared theme and bundled font weights. */
export function useScreenStyles<T extends Record<string, ViewStyle | TextStyle | ImageStyle>>(base: T): T {
  const { colors } = useColors();
  return useMemo(() => {
    const palette: Record<string, string> = { '#F7F9FC': colors.canvas, '#FFFFFF': colors.surface,
      '#13213B': colors.ink, '#52627A': colors.muted, '#718096': colors.border, '#111D32': colors.surface,
      '#627897': colors.border, '#B8C5D8': colors.muted, '#F5F7FC': colors.ink, '#E7EEFF': colors.soft };
    return Object.fromEntries(Object.entries(base).map(([name, style]) => {
      const themed = { ...style } as Record<string, unknown>;
      for (const key of ['color', 'backgroundColor', 'borderColor', 'borderTopColor', 'borderBottomColor']) {
        const value = themed[key]; if (typeof value === 'string' && palette[value]) themed[key] = palette[value];
      }
      if (themed.fontFamily === 'Inter') themed.fontFamily = themed.fontWeight === '700' ? 'InterBold'
        : themed.fontWeight === '600' ? 'InterSemiBold' : themed.fontWeight === '500' ? 'InterMedium' : 'Inter';
      return [name, themed];
    })) as T;
  }, [base, colors]);
}
