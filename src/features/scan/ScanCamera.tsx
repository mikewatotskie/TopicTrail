import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View } from 'react-native';
import { TTButton } from '../../components/TTButton';
import { TTFeedback } from '../../components/TTFeedback';
import { useColors } from '../../core/theme/ThemeContext';
import type { ScanPhoto } from './photo_contract';
import { captureNativePhoto } from './native_ocr';
import { releasePhoto } from './photo_platform';

interface ScanCameraProps {
  onPhoto: (photo: ScanPhoto) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  label?: string;
  onActiveChange?: (active: boolean) => void;
  openRef?: React.Ref<() => void>;
}

/** Android delegates full-resolution capture to the system camera after an explicit tap. */
export function ScanCamera({ onPhoto, onError, disabled = false, label = 'Take photo', onActiveChange, openRef }: ScanCameraProps) {
  const { colors } = useColors();
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('');
  const request = useRef<AbortController | null>(null);
  const callbacks = useRef({ onPhoto, onError, onActiveChange });
  useEffect(() => { callbacks.current = { onPhoto, onError, onActiveChange }; }, [onPhoto, onError, onActiveChange]);

  useEffect(() => () => {
    const pending = request.current;
    request.current = null;
    pending?.abort();
    if (pending) callbacks.current.onActiveChange?.(false);
  }, []);

  async function capture() {
    if (disabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setActive(true);
    setStatus('Camera open. Take a photo, or go back to choose a photo.');
    callbacks.current.onActiveChange?.(true);
    try {
      const photo = await captureNativePhoto(controller.signal);
      if (controller.signal.aborted || request.current !== controller) { if (photo) releasePhoto(photo); return; }
      if (photo) { setStatus('Photo ready for review.'); callbacks.current.onPhoto(photo); }
      else setStatus('Camera closed. You can take a photo or choose a photo.');
    } catch {
      if (request.current === controller && !controller.signal.aborted) {
        setStatus('');
        callbacks.current.onError('The camera is unavailable or the photo could not be prepared. Choose a photo instead.');
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setActive(false);
        callbacks.current.onActiveChange?.(false);
      }
    }
  }
  useImperativeHandle(openRef, () => () => { void capture(); });
  function cancel() {
    const pending = request.current;
    if (!pending) return;
    request.current = null;
    pending.abort();
    setActive(false);
    setStatus('Camera closed. You can take a photo or choose a photo.');
    callbacks.current.onActiveChange?.(false);
  }
  return <View style={{ gap: 8 }}>
    <TTButton label={label} variant="secondary" icon="camera-outline" disabled={disabled} isLoading={active}
      accessibilityHint="Opens the system camera. Review the photo before recognizing or saving it."
      onPress={() => { void capture(); }} />
    {active && <TTButton label="Cancel camera" variant="ghost" onPress={cancel}
      accessibilityHint="Discards this capture. You can still choose a photo." />}
    <TTFeedback message={status} style={{ color: colors.muted }} />
  </View>;
}

export default ScanCamera;
