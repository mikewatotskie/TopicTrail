import React from 'react';
import { Tabs, usePathname } from 'expo-router';
import { TopicTrailTabBar } from '../../navigation';
import { View } from 'react-native';
import { useResponsiveLayout } from '../../core/layout/useResponsiveLayout';
import { TTNavigationRail } from '../../navigation/TTNavigationRail';
export default function TabLayout() {
  const { mode } = useResponsiveLayout();
  const pathname = usePathname();
  const routeName = pathname.split('/').filter(Boolean).at(-1) ?? 'home';
  return <View style={{ flex: 1, minHeight: 0, minWidth: 0, flexDirection: 'row' }}>
    {mode === 'wide' && <TTNavigationRail key="rail" routeName={routeName} />}
    <View key="tabs" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
    <Tabs screenOptions={{ headerShown: false }} tabBar={({ state }) => mode === 'wide' ? null : <TopicTrailTabBar routeName={state.routes[state.index].name} />}>
    <Tabs.Screen name="home" /><Tabs.Screen name="library" /><Tabs.Screen name="saved" /><Tabs.Screen name="settings" />
    </Tabs>
    </View>
  </View>;
}
