import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColors } from '../core/theme/ThemeContext';
import { useResponsiveLayout } from '../core/layout/useResponsiveLayout';
import type { ScreenVariant } from '../core/layout/responsive';

export function TTScreen({ children, style, bottomInset = true, variant = 'standard' }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; bottomInset?: boolean; variant?: ScreenVariant }) {
  const { colors } = useColors();
  const { contentMaxWidth, mode } = useResponsiveLayout(variant);
  return <SafeAreaView edges={bottomInset ? ['top', 'left', 'right', 'bottom'] : ['top', 'left', 'right']} style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: colors.canvas }}>
    <View testID={'screen-content-' + mode} style={[{ flex: 1, minHeight: 0, minWidth: 0, width: '100%', maxWidth: contentMaxWidth, alignSelf: 'center', backgroundColor: colors.canvas }, style]}>
      {children}
    </View>
  </SafeAreaView>;
}
