import React from 'react';
import { View } from 'react-native';
export function AppViewport({ children }: { children: React.ReactNode }) {
  return <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{children}</View>;
}
