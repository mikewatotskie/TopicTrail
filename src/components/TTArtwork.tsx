import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useTheme } from '../core/theme/ThemeContext';

// Exact exports from the approved file. Root SVG dimensions are retained, including blur bounds.
const artwork = {
  logo: [require('../assets/figma/4117e.svg'), require('../assets/figma/726ad.svg'), 80, 80],
  trail: [require('../assets/figma/69b08.svg'), require('../assets/figma/26756.svg'), 82, 94],
  mark: [require('../assets/figma/6a0a6.svg'), require('../assets/figma/9364e.svg'), 24, 24],
  feature: [require('../assets/figma/52a20.svg'), require('../assets/figma/f95b0.svg'), 416, 322],
  quiet: [require('../assets/figma/97848.svg'), require('../assets/figma/4cb43.svg'), 368, 272],
  header: [require('../assets/figma/a85e1.svg'), require('../assets/figma/9cdc2.svg'), 272, 184],
  splashUpper: [require('../assets/figma/380ec.svg'), require('../assets/figma/e1135.svg'), 416, 322],
  splashLower: [require('../assets/figma/8af13.svg'), require('../assets/figma/47e6e.svg'), 416, 322],
  switchOff: [require('../assets/figma/83a20.svg'), require('../assets/figma/83a20.svg'), 52, 32],
  switchOn: [require('../assets/figma/24098.svg'), require('../assets/figma/24098.svg'), 52, 32],
} as const;
export function TTArtwork({ name, style }: { name: keyof typeof artwork; style?: StyleProp<ViewStyle> }) {
  const { colorScheme } = useTheme();
  const [light, dark, width, height] = artwork[name];
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={style}>
    <Image source={colorScheme === 'dark' ? dark : light} style={{ width, height }} contentFit="contain" />
  </View>;
}
export function TTAura({ kind = 'feature', style }: { kind?: 'feature' | 'quiet' | 'header'; style?: StyleProp<ViewStyle> }) {
  const bounds = kind === 'feature' ? { width: 340, height: 280, left: -48, top: -32 }
    : kind === 'quiet' ? { width: 300, height: 224, left: -36, top: -28 }
    : { width: 180, height: 80, left: -36, top: -56 };
  return <View pointerEvents="none" style={[{ position: 'absolute', width: bounds.width, height: bounds.height, overflow: 'hidden' }, style]}>
    <TTArtwork name={kind} style={{ position: 'absolute', left: bounds.left, top: bounds.top }} />
  </View>;
}

const icons = {
  home: [require('../assets/figma/67dba.svg'), require('../assets/figma/f8a25.svg')],
  homeMuted: [require('../assets/figma/faa41.svg'), require('../assets/figma/5569a.svg')],
  book: [require('../assets/figma/97b40.svg'), require('../assets/figma/d7d4a.svg')],
  bookMuted: [require('../assets/figma/bc30c.svg'), require('../assets/figma/980cc.svg')],
  bookmark: [require('../assets/figma/26a9e.svg'), require('../assets/figma/13345.svg')],
  bookmarkMuted: [require('../assets/figma/7a860.svg'), require('../assets/figma/8e384.svg')],
  settings: [require('../assets/figma/9b66b.svg'), require('../assets/figma/29dd9.svg')],
  settingsMuted: [require('../assets/figma/fd2d4.svg'), require('../assets/figma/05615.svg')],
  file: [require('../assets/figma/864ce.svg'), require('../assets/figma/4e7c1.svg')],
  more: [require('../assets/figma/419aa.svg'), require('../assets/figma/b1d9a.svg')],
  search: [require('../assets/figma/0de34.svg'), require('../assets/figma/64236.svg')],
  upload: [require('../assets/figma/10bf8.svg'), require('../assets/figma/a3722.svg')],
  study: [require('../assets/figma/bb3b3.svg'), require('../assets/figma/17566.svg')],
  studyAccent: [require('../assets/figma/db7e2.svg'), require('../assets/figma/8198b.svg')],
  copy: [require('../assets/figma/547ad.svg'), require('../assets/figma/eb7ae.svg')],
  back: [require('../assets/figma/760a8.svg'), require('../assets/figma/842d8.svg')],
  next: [require('../assets/figma/0e849.svg'), require('../assets/figma/99c17.svg')],
  minus: [require('../assets/figma/37006.svg'), require('../assets/figma/3098f.svg')],
  plus: [require('../assets/figma/02d18.svg'), require('../assets/figma/69daf.svg')],
  shield: [require('../assets/figma/dee25.svg'), require('../assets/figma/87427.svg')],
  close: [require('../assets/figma/c60cc.svg'), require('../assets/figma/a3a16.svg')],
} as const;
export function TTFigmaIcon({ name, slot = 24 }: { name: keyof typeof icons; slot?: number }) {
  const { colorScheme } = useTheme();
  return <View pointerEvents="none" accessible={false} style={{ width: slot, height: slot, alignItems: 'center', justifyContent: 'center' }}>
    <Image source={icons[name][colorScheme === 'dark' ? 1 : 0]} style={{ width: 24, height: 24 }} contentFit="contain" />
  </View>;
}
