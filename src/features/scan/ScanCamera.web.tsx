import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TTButton } from '../../components/TTButton';
import { TTFeedback } from '../../components/TTFeedback';
import { TTRadius, TTSpacing, TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import type { ScanPhoto } from './photo_contract';
import { bindCameraPageLifetime, createBrowserCamera, type BrowserCamera, type BrowserCameraState } from './browser_camera';
import { preloadPhotoOcr } from './photo_platform.web';

interface Props {
  onPhoto: (photo: ScanPhoto) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  label?: string;
  onActiveChange?: (active: boolean) => void;
  openRef?: React.Ref<() => void>;
}

export function ScanCamera({ onPhoto, onError, disabled, label = 'Take photo', onActiveChange, openRef }: Props) {
  const { colors } = useColors();
  const [state, setState] = useState<BrowserCameraState>('idle');
  const video = useRef<HTMLVideoElement>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const previous = useRef<BrowserCameraState>('idle');
  const camera = useRef<BrowserCamera | null>(null);
  const callbacks = useRef({ onPhoto, onError, onActiveChange });
  useEffect(() => { callbacks.current = { onPhoto, onError, onActiveChange }; }, [onPhoto, onError, onActiveChange]);
  useEffect(() => {
    // Public bundled bytes only. Recognition reports a load failure on an explicit attempt.
    void preloadPhotoOcr().catch(() => {});
  }, []);
  useEffect(() => {
    const controller = createBrowserCamera({ video: () => video.current, onState: setState,
      onPhoto: photo => callbacks.current.onPhoto(photo), onError: message => callbacks.current.onError(message),
      onActiveChange: active => callbacks.current.onActiveChange?.(active) });
    camera.current = controller;
    const unbind = bindCameraPageLifetime(controller);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') controller.close(); };
    window.addEventListener('keydown', escape);
    return () => { unbind(); window.removeEventListener('keydown', escape); controller.dispose(); camera.current = null; };
  }, []);
  useEffect(() => { if (disabled) camera.current?.close(); }, [disabled]);
  useEffect(() => {
    if (state === 'requesting') actions.current?.querySelectorAll<HTMLElement>('[role="button"]')[1]?.focus();
    if (state === 'ready') actions.current?.querySelector<HTMLElement>('[role="button"]')?.focus();
    if (state === 'idle' && previous.current !== 'idle' && document.visibilityState !== 'hidden') trigger.current?.querySelector<HTMLElement>('[role="button"]')?.focus();
    previous.current = state;
  }, [state]);
  useImperativeHandle(openRef, () => () => { if (!disabled) void camera.current?.open(); });
  const active = state !== 'idle';
  return <View style={styles.container}>
    <div ref={trigger} style={{ display: active ? 'none' : 'contents' }}>
      <TTButton label={label} variant="secondary" icon="camera-outline" disabled={disabled}
        onPress={() => { void camera.current?.open(); }} widthPolicy="responsiveAction" />
    </div>
    <View style={!active ? styles.hidden : styles.preview}>
      <Text style={[TTTypography.body, { color: colors.ink }]}>Camera preview · no audio</Text>
      <video ref={video} muted playsInline aria-label="Live camera preview" tabIndex={-1}
        style={{ display: 'block', width: '100%', maxHeight: '50vh', objectFit: 'contain', borderRadius: TTRadius.radiusMd, background: colors.canvas }} />
      {state !== 'ready' && <TTFeedback message={state === 'requesting' ? 'Waiting for camera permission and preview…' : state === 'capturing' ? 'Preparing photo…' : ''}
        style={[TTTypography.caption, { color: colors.muted }]} />}
      <div ref={actions} style={{ display: 'contents' }}><View style={styles.actions}>
        <TTButton label="Capture photo" disabled={disabled || state !== 'ready'} onPress={() => { void camera.current?.capture(); }} />
        <TTButton label="Close camera" variant="secondary" onPress={() => camera.current?.close()} />
      </View></div>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: TTSpacing.space12 }, preview: { gap: TTSpacing.space12 }, hidden: { display: 'none' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: TTSpacing.space8 },
});
export default ScanCamera;
