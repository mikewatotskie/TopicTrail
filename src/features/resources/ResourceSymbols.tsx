import React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useTheme } from '../../core/theme/ThemeContext';

// Exact 24px SVG exports from approved Figma details/Saved Light and Dark nodes.
const symbols = {
  shield: [require('./assets/shield-light.svg'), require('./assets/shield-dark.svg')],
  saved: [require('./assets/bookmark-filled-light.svg'), require('./assets/bookmark-filled-dark.svg')],
} as const;
export function ResourceSymbol({ name }: { name: keyof typeof symbols }) {
  const { colorScheme } = useTheme();
  return <View accessible={false} pointerEvents="none" style={{ width: 24, height: 24 }}>
    <Image source={symbols[name][colorScheme === 'dark' ? 1 : 0]} style={{ width: 24, height: 24 }} contentFit="contain" />
  </View>;
}
