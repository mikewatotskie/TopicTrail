import React, { useState } from 'react';
import { View } from 'react-native';
import { useResponsiveLayout } from '../core/layout/useResponsiveLayout';
export function TTResponsiveGrid<T>({ items, keyExtractor, renderItem }: {
  items: readonly T[]; keyExtractor: (item: T) => string; renderItem: (item: T) => React.ReactNode;
}) {
  const layout = useResponsiveLayout(); const [measuredWidth, setMeasuredWidth] = useState<number>();
  const width = measuredWidth ?? layout.contentWidth;
  const columns = Math.max(1, Math.min(layout.columns, Math.floor((width + 16) / 296)));
  return <View onLayout={event => setMeasuredWidth(event.nativeEvent.layout.width)} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, minWidth: 0 }}>
    {items.map(item => <View key={keyExtractor(item)} style={{ minWidth: 0, flexGrow: 0, flexShrink: 0,
      width: columns === 1 ? '100%' : `${100 / columns - (16 * (columns - 1) / columns) / width * 100}%` }}>
      {renderItem(item)}
    </View>)}
  </View>;
}
