import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeMode, TTLightColors, TTDarkColors } from '../design/tokens';

const STORAGE_KEY = 'topic_trail_theme_mode';
export type ThemeColors = Record<string, string>;
export interface ThemeContextType {
  themeMode: ThemeMode;
  colorScheme: 'light' | 'dark';
  colors: ThemeColors;
  semanticColors: ThemeColors;
  componentColors: ThemeColors;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  isInitialized: boolean;
}
const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [themeMode, setMode] = useState(ThemeMode.SYSTEM);
  const [isInitialized, setInitialized] = useState(false);
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY).then(stored => {
      if (active && Object.values(ThemeMode).includes(stored as ThemeMode)) setMode(stored as ThemeMode);
    }).catch(() => undefined).finally(() => { if (active) setInitialized(true); });
    return () => { active = false; };
  }, []);
  const setThemeMode = useCallback(async (mode: ThemeMode) => {
    await AsyncStorage.setItem(STORAGE_KEY, mode);
    setMode(mode);
  }, []);
  const colorScheme = themeMode === ThemeMode.SYSTEM ? (system === 'dark' ? 'dark' : 'light')
    : themeMode === ThemeMode.DARK ? 'dark' : 'light';
  const light: ThemeColors = Object.fromEntries(Object.entries(TTLightColors)
    .filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, String(value)]));
  const colors: ThemeColors = colorScheme === 'dark'
    ? { ...light, ...TTDarkColors, soft: TTDarkColors.highlight, link: '#8DB2FF',
        danger: '#FFB4BE', dangerSoft: '#3B1822', warningSoft: '#342B13' }
    : light;
  return <ThemeContext.Provider value={{ themeMode, colorScheme, colors, semanticColors: colors,
    componentColors: colors, setThemeMode, isInitialized }}>{children}</ThemeContext.Provider>;
}
export function useTheme(): ThemeContextType {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used within a ThemeProvider');
  return value;
}
export function useColorSchemeValue() { return useTheme().colorScheme; }
export function useColors() {
  const { colors, semanticColors, componentColors } = useTheme();
  return { colors, semanticColors, componentColors };
}
export function useThemeMode() {
  const { themeMode, setThemeMode, isInitialized } = useTheme();
  return { themeMode, setThemeMode, isInitialized };
}
