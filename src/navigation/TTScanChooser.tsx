import React, { useRef, useState } from 'react';
import {
  AccessibilityInfo, findNodeHandle, Modal, Platform, Pressable, ScrollView, StyleSheet,
  Text, useWindowDimensions, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TTFigmaIcon } from '../components/TTArtwork';
import { TTTypography } from '../core/design/tokens';
import { useTheme } from '../core/theme/ThemeContext';

export type ScanEntryHandler = (entry: 'pick' | 'capture') => void;

const options = [
  { entry: 'pick', label: 'Scan a photo', hint: 'Choose an existing JPG or PNG from your device', icon: 'scanPhoto' },
  { entry: 'capture', label: 'Take a photo', hint: 'Use the camera to photograph a document', icon: 'scanCamera' },
] as const;

type ScanControl = React.ComponentRef<typeof Pressable>;

function focusControl(node: ScanControl | null) {
  if (!node) return;
  if (Platform.OS === 'web') node.focus();
  else {
    const handle = findNodeHandle(node);
    if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
  }
}

export function TTScanChooser({ rail = false, onChoose }: { rail?: boolean; onChoose: ScanEntryHandler }) {
  const { colors, colorScheme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const [visible, setVisible] = useState(false);
  const open = useRef(false);
  const trigger = useRef<ScanControl>(null);
  const closeButton = useRef<ScanControl>(null);
  const restoreOnDismiss = useRef(false);

  function show() {
    open.current = true;
    restoreOnDismiss.current = false;
    setVisible(true);
  }
  function restoreFocus() {
    if (!restoreOnDismiss.current) return;
    restoreOnDismiss.current = false;
    focusControl(trigger.current);
  }
  function dismiss() {
    if (!open.current) return;
    open.current = false;
    restoreOnDismiss.current = true;
    setVisible(false);
    // Native Android and some web renderers do not emit onDismiss.
    if (Platform.OS !== 'ios') requestAnimationFrame(restoreFocus);
  }
  function choose(entry: 'pick' | 'capture') {
    if (!open.current) return;
    open.current = false;
    setVisible(false);
    // Start the picker/camera within this press to preserve browser user activation.
    onChoose(entry);
  }
  const bottomIndicator = Platform.OS === 'web' && width < 768;
  return <>
    <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel="Scan"
      accessibilityHint="Choose a photo or take one" accessibilityState={{ expanded: visible }}
      onPress={show} style={({ pressed }) => [rail ? styles.rail : styles.dock,
        { backgroundColor: pressed ? colors.highlight : 'transparent' }]}>
      <View style={[styles.scanTile, { backgroundColor: colorScheme === 'dark' ? colors.highlight : '#E4EEFF' }]}>
        <TTFigmaIcon name="dockScan" slot={23} size={23} tintColor={colors.link} />
      </View>
      <Text style={[rail ? TTTypography.bodyStrong : styles.scanLabel, { color: colors.link }]}>Scan</Text>
    </Pressable>
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent navigationBarTranslucent
      onShow={() => focusControl(closeButton.current)} onRequestClose={dismiss} onDismiss={restoreFocus}>
      <View style={styles.overlay} accessibilityViewIsModal onAccessibilityEscape={dismiss}>
        <Pressable accessible={false} importantForAccessibility="no" tabIndex={-1} focusable={false}
          aria-hidden onPress={dismiss} style={StyleSheet.absoluteFill} />
        <View style={[styles.sheet, { backgroundColor: colors.surface, maxHeight: Math.max(1, height - insets.top - 12) }]}>
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled" style={styles.scroll}
            contentContainerStyle={{ paddingTop: 10, paddingHorizontal: 20, paddingBottom: Math.max(16, insets.bottom + 10) }}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
            <View style={styles.header}>
              <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>Scan a document</Text>
              <Pressable ref={closeButton} accessibilityRole="button" accessibilityLabel="Close scan chooser"
                onPress={dismiss} style={({ pressed }) => [styles.close, { backgroundColor: pressed ? colors.highlight : 'transparent' }]}>
                <TTFigmaIcon name="scanClose" slot={20} size={20} tintColor={colors.muted} />
              </Pressable>
            </View>
            <View style={styles.options}>
              {options.map(option => <Pressable key={option.entry} accessibilityRole="button"
                accessibilityLabel={option.label} accessibilityHint={option.hint} onPress={() => choose(option.entry)}
                style={({ pressed }) => [styles.option, { borderColor: colors.border, backgroundColor: pressed ? colors.highlight : colors.canvas }]}>
                <View style={[styles.optionTile, { backgroundColor: colorScheme === 'dark' ? colors.highlight : '#E8EFFF' }]}>
                  <TTFigmaIcon name={option.icon} tintColor={colors.link} />
                </View>
                <View style={styles.description}>
                  <Text style={[TTTypography.bodyStrong, { color: colors.ink, lineHeight: 20 }]}>{option.label}</Text>
                  <Text style={[styles.hint, { color: colors.muted }]}>{option.hint}</Text>
                </View>
                <TTFigmaIcon name="scanChevron" slot={18} size={18} tintColor={colors.muted} />
              </Pressable>)}
            </View>
            {bottomIndicator && <View style={[styles.gesture, { backgroundColor: colors.ink }]} />}
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  dock: { flex: 1, minWidth: 0, minHeight: 56, paddingVertical: 4, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: 12 },
  rail: { minHeight: 56, padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12 },
  scanTile: { width: 36, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  scanLabel: { ...TTTypography.caption, fontFamily: 'InterSemiBold', fontWeight: '600', textAlign: 'center' },
  overlay: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', backgroundColor: 'rgba(17,27,48,0.48)' },
  sheet: { width: '100%', maxWidth: 520, borderTopLeftRadius: 22, borderTopRightRadius: 22, overflow: 'hidden' },
  scroll: { flexGrow: 0 },
  handle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center' },
  header: { marginTop: 11, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  title: { ...TTTypography.heading, fontSize: 21, lineHeight: 28, flex: 1, minWidth: 0, paddingLeft: 2 },
  close: { minWidth: 44, minHeight: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  options: { gap: 8, marginTop: 15, marginBottom: 12 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 70, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  optionTile: { width: 42, height: 42, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  description: { flex: 1, minWidth: 0, gap: 2 },
  hint: { fontFamily: 'Inter', fontSize: 12, lineHeight: 16 },
  gesture: { width: 108, height: 4, alignSelf: 'center', borderRadius: 2, marginTop: 28 },
});
