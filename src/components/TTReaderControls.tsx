import React, { useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useColors } from '../core/theme/ThemeContext';
import { TTTypography } from '../core/design/tokens';
import { TTIconButton } from './TTIconButton';
import { TTFigmaIcon } from './TTArtwork';

export function TTReaderControls({ page, pages, zoom, busy, onPage, onZoom, section = false }: {
  page: number; pages: number; zoom: number; busy: boolean; section?: boolean;
  onPage: (page: number) => void; onZoom: (zoom: number) => void;
}) {
  const { colors } = useColors();
  const [expanded, setExpanded] = useState(false);
  const textStyle = [TTTypography.small, { color: colors.onBrand }];
  return <View style={{ backgroundColor: colors.brand }}>
    {expanded && <View style={{ flexDirection: 'row', justifyContent: 'space-around', flexWrap: 'wrap' }}>
      {[{ label: 'First ' + (section ? 'section' : 'page'), value: 1 }, { label: 'Last ' + (section ? 'section' : 'page'), value: pages }].map(item =>
        <TouchableOpacity key={item.label} accessibilityRole="button" accessibilityLabel={item.label}
          accessibilityState={{ disabled: busy || page === item.value }} disabled={busy || page === item.value}
          onPress={() => { onPage(item.value); setExpanded(false); }} style={{ minHeight: 48, padding: 12, opacity: busy || page === item.value ? 0.45 : 1 }}>
          <Text style={textStyle}>{item.label}</Text>
        </TouchableOpacity>)}
    </View>}
    <View style={{ minHeight: 104, paddingHorizontal: 16, paddingVertical: 16, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
      <TTIconButton icon={<TTFigmaIcon name="back" />} semanticLabel="Previous page" disabled={busy || page <= 1} onPress={() => onPage(page - 1)} />
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={'Page navigation, ' + page + ' of ' + pages}
        accessibilityHint="Show first and last page actions" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)}
        style={{ minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={textStyle}>{page} / {pages}</Text>
      </TouchableOpacity>
      <TTIconButton icon={<TTFigmaIcon name="next" />} semanticLabel="Next page" disabled={busy || page >= pages} onPress={() => onPage(page + 1)} />
      <TTIconButton icon={<TTFigmaIcon name="minus" />} semanticLabel="Zoom out" disabled={busy || zoom <= 0.5} onPress={() => onZoom(Math.max(0.5, zoom - 0.25))} />
      <Text style={[...textStyle, { minWidth: 48, textAlign: 'center' }]}>{Math.round(zoom * 100)}%</Text>
      <TTIconButton icon={<TTFigmaIcon name="plus" />} semanticLabel="Zoom in" disabled={busy || zoom >= 3} onPress={() => onZoom(Math.min(3, zoom + 0.25))} />
    </View>
  </View>;
}
