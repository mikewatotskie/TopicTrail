import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { useColors } from '../core/theme/ThemeContext';
import { TTTypography } from '../core/design/tokens';
import { TTIconButton } from './TTIconButton';
import { TTFigmaIcon } from './TTArtwork';

export function TTReaderControls({ page, pages, zoom, busy, onPage, onZoom, section = false, slide = false }: {
  page: number; pages: number; zoom: number; busy: boolean; section?: boolean; slide?: boolean;
  onPage: (page: number) => void; onZoom: (zoom: number) => void;
}) {
  const unit = slide ? 'slide' : section ? 'section' : 'page';
  const { colors } = useColors();
  const [expanded, setExpanded] = useState(false);
  const [destination,setDestination]=useState(''),[invalid,setInvalid]=useState(false);
  const jump=()=>{const value=Number(destination);if(!/^\d+$/.test(destination)||!Number.isSafeInteger(value)||value<1||value>pages){setInvalid(true);return;}setInvalid(false);setExpanded(false);onPage(value);};
  const textStyle = [TTTypography.small, { color: colors.ink }];
  return <View style={{ backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>
    {expanded && <View style={{ flexDirection: 'row', justifyContent: 'space-around', flexWrap: 'wrap' }}>
      <TextInput accessibilityLabel={'Go to '+unit} value={destination} onChangeText={value=>{setDestination(value);setInvalid(false);}} inputMode="numeric" returnKeyType="go" onSubmitEditing={jump} placeholder={String(page)} placeholderTextColor={colors.muted} style={{minHeight:48,minWidth:72,padding:12,color:colors.ink,borderWidth:1,borderColor:colors.border}}/>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={'Go to entered '+unit} disabled={busy} onPress={jump} style={{minHeight:48,padding:12}}><Text style={textStyle}>Go</Text></TouchableOpacity>
      {[{ label: 'First ' + unit, value: 1 }, { label: 'Last ' + unit, value: pages }].map(item =>
        <TouchableOpacity key={item.label} accessibilityRole="button" accessibilityLabel={item.label}
          accessibilityState={{ disabled: busy || page === item.value }} disabled={busy || page === item.value}
          onPress={() => { onPage(item.value); setExpanded(false); }} style={{ minHeight: 48, padding: 12, opacity: busy || page === item.value ? 0.45 : 1 }}>
          <Text style={textStyle}>{item.label}</Text>
        </TouchableOpacity>)}
    </View>}
    {invalid&&<Text accessibilityLiveRegion="polite" style={[textStyle,{padding:8}]}>Enter a {unit} from 1 to {pages}.</Text>}
    <View style={{ minHeight: 64, paddingHorizontal: 8, paddingVertical: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
      <TTIconButton icon={<TTFigmaIcon name="back" tintColor={colors.link} />} semanticLabel={'Previous ' + unit} disabled={busy || page <= 1} onPress={() => onPage(page - 1)} />
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={'Page navigation, ' + page + ' of ' + pages}
        accessibilityHint="Enter a location or go to the first or last" accessibilityState={{ expanded }} onPress={() => {setDestination(String(page));setExpanded(value => !value);}}
        style={{ minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={textStyle}>{page} / {pages}</Text>
      </TouchableOpacity>
      <TTIconButton icon={<TTFigmaIcon name="next" tintColor={colors.link} />} semanticLabel={'Next ' + unit} disabled={busy || page >= pages} onPress={() => onPage(page + 1)} />
      <TTIconButton icon={<TTFigmaIcon name="minus" tintColor={colors.link} />} semanticLabel="Zoom out" disabled={busy || zoom <= 0.5} onPress={() => onZoom(Math.max(0.5, zoom - 0.25))} />
      <Text style={[...textStyle, { minWidth: 48, textAlign: 'center' }]}>{Math.round(zoom * 100)}%</Text>
      <TTIconButton icon={<TTFigmaIcon name="plus" tintColor={colors.link} />} semanticLabel="Zoom in" disabled={busy || zoom >= 3} onPress={() => onZoom(Math.min(3, zoom + 0.25))} />
    </View>
  </View>;
}
