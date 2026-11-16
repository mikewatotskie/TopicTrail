import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useTheme } from '../core/theme/ThemeContext';

// Exact exports from the approved file. Root SVG dimensions are retained, including blur bounds.
const artwork = {
  logo: [require('../assets/figma/4117e.svg'), require('../assets/figma/e5746.svg'), 80, 80],
  trail: [require('../assets/figma/69b08.svg'), require('../assets/figma/26756.svg'), 82, 94],
  mark: [require('../assets/figma/ffe52.svg'), require('../assets/figma/fe30e.svg'), 24, 24],
  feature: [require('../assets/figma/52a20.svg'), require('../assets/figma/f95b0.svg'), 416, 322],
  quiet: [require('../assets/figma/97848.svg'), require('../assets/figma/4cb43.svg'), 368, 272],
  header: [require('../assets/figma/60f36.svg'), require('../assets/figma/86731.svg'), 272, 184],
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
  dockHome: [require('../assets/figma/47ca2.svg'), require('../assets/figma/47ca2.svg')],
  dockLibrary: [require('../assets/figma/bc30c.svg'), require('../assets/figma/bc30c.svg')],
  dockSaved: [require('../assets/figma/7a860.svg'), require('../assets/figma/7a860.svg')],
  dockSettings: [require('../assets/figma/fd2d4.svg'), require('../assets/figma/fd2d4.svg')],
  dockScan: [require('../assets/figma/a9fac.svg'), require('../assets/figma/a9fac.svg')],
  scanPhoto: [require('../assets/figma/f0972.svg'), require('../assets/figma/f0972.svg')],
  scanCamera: [require('../assets/figma/f8d07.svg'), require('../assets/figma/f8d07.svg')],
  scanChevron: [require('../assets/figma/3637e.svg'), require('../assets/figma/3637e.svg')],
  scanClose: [require('../assets/figma/c2fcd.svg'), require('../assets/figma/c2fcd.svg')],
  settingsTab: [require('../assets/figma/c840a.svg'), require('../assets/figma/9448a.svg')],
  savedTab: [require('../assets/figma/5b83f.svg'), require('../assets/figma/81f9c.svg')],
  libraryTab: [require('../assets/figma/73f67.svg'), require('../assets/figma/05330.svg')],
  homeTab: [require('../assets/figma/e71bb.svg'), require('../assets/figma/a4d32.svg')],
  home: [require('../assets/figma/67dba.svg'), require('../assets/figma/f8a25.svg')],
  homeMuted: [require('../assets/figma/91de4.svg'), require('../assets/figma/a6484.svg')],
  book: [require('../assets/figma/97b40.svg'), require('../assets/figma/d7d4a.svg')],
  bookMuted: [require('../assets/figma/71181.svg'), require('../assets/figma/894d1.svg')],
  bookmark: [require('../assets/figma/26a9e.svg'), require('../assets/figma/13345.svg')],
  bookmarkMuted: [require('../assets/figma/1e20b.svg'), require('../assets/figma/3382e.svg')],
  settings: [require('../assets/figma/9b66b.svg'), require('../assets/figma/29dd9.svg')],
  settingsMuted: [require('../assets/figma/84291.svg'), require('../assets/figma/21d2f.svg')],
  file: [require('../assets/figma/1378b.svg'), require('../assets/figma/ab455.svg')],
  more: [require('../assets/figma/06832.svg'), require('../assets/figma/47b75.svg')],
  search: [require('../assets/figma/0de34.svg'), require('../assets/figma/64236.svg')],
  upload: [require('../assets/figma/ab932.svg'), require('../assets/figma/e284d.svg')],
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
export function TTFigmaIcon({ name, slot = 24, size = 24, tintColor }: { name: keyof typeof icons; slot?: number; size?: number; tintColor?: string }) {
  const { colorScheme } = useTheme();
  return <View pointerEvents="none" accessible={false} style={{ width: slot, height: slot, alignItems: 'center', justifyContent: 'center' }}>
    <Image source={icons[name][colorScheme === 'dark' ? 1 : 0]} tintColor={tintColor} style={{ width: size, height: size }} contentFit="contain" />
  </View>;
}
