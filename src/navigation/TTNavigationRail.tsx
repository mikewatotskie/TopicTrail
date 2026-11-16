import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { navigationItems } from './index';
import { TTScanChooser, type ScanEntryHandler } from './TTScanChooser';
import { useColors } from '../core/theme/ThemeContext';
import { TTTypography } from '../core/design/tokens';
import { TTFigmaIcon } from '../components/TTArtwork';
export function TTNavigationRail({ routeName, onScanEntry }: { routeName: string; onScanEntry: ScanEntryHandler }) {
  const router = useRouter();
  const { colors } = useColors(); const inset = useSafeAreaInsets();
  return <View testID="primary-navigation-rail" accessibilityLabel="Primary navigation" style={{ width: 232, flexShrink: 0, paddingTop: inset.top + 24,
    paddingHorizontal: 16, backgroundColor: colors.surface, borderRightWidth: 1, borderColor: colors.border }}>
    <Text style={[TTTypography.title, { color: colors.link, marginBottom: 32, paddingHorizontal: 12 }]}>TopicTrail</Text>
    {navigationItems.map(destination => {
      if (destination.key === 'scan') return <TTScanChooser key="scan" rail onChoose={onScanEntry} />;
      const active = destination.path.endsWith('/' + routeName);
      return <TouchableOpacity key={destination.key} accessibilityRole="tab" accessibilityLabel={destination.label}
        accessibilityState={{ selected: active }} aria-selected={active} onPress={() => router.navigate(destination.path)}
        style={{ minHeight: 56, padding: 12, marginBottom: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 12,
          backgroundColor: active ? colors.brand : colors.surface }}>
        <TTFigmaIcon name={destination.icon} tintColor={active ? colors.onBrand : colors.muted} />
        <Text style={[TTTypography.bodyStrong, { color: active ? colors.onBrand : colors.muted }]}>{destination.label}</Text>
      </TouchableOpacity>;
    })}
  </View>;
}
