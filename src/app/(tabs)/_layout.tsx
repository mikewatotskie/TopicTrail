import React from 'react';
import { Tabs, usePathname, useRouter } from 'expo-router';
import { TopicTrailTabBar } from '../../navigation';
import { View } from 'react-native';
import { useResponsiveLayout } from '../../core/layout/useResponsiveLayout';
import { TTNavigationRail } from '../../navigation/TTNavigationRail';
import { beginDockScan } from '../../features/scan/scan_entry';
import { useCloudLibrary } from '../../features/library/CloudLibraryContext';

export default function TabLayout() {
  const router = useRouter();
  const { state: { epoch } } = useCloudLibrary();
  function openScan(entry: 'pick' | 'capture') {
    const request = beginDockScan(entry, epoch);
    router.push({ pathname: '/scan', params: { entry, request } });
  }
  const { mode } = useResponsiveLayout();
  const pathname = usePathname();
  const routeName = pathname.split('/').filter(Boolean).at(-1) ?? 'home';
  return <View style={{ flex: 1, minHeight: 0, minWidth: 0, flexDirection: 'row' }}>
    {mode === 'wide' && <TTNavigationRail key={epoch} routeName={routeName} onScanEntry={openScan} />}
    <View key="tabs" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
    <Tabs screenOptions={{ headerShown: false }} tabBar={({ state }) => mode === 'wide' ? null : <TopicTrailTabBar key={epoch} routeName={state.routes[state.index].name} onScanEntry={openScan} />}>
    <Tabs.Screen name="home" /><Tabs.Screen name="library" /><Tabs.Screen name="saved" /><Tabs.Screen name="settings" />
    </Tabs>
    </View>
  </View>;
}
