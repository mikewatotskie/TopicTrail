import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

export type FeedbackKind = 'status' | 'alert' | 'off';
interface FeedbackProps {
  kind?: FeedbackKind;
  testID?: string;
  nativeID?: string;
}

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** Client-only mounts start empty; SSR/hydration keep the readable initial content. */
function usePrimedRegion(kind: FeedbackKind) {
  const client = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const [ready, setReady] = useState(!client);
  useEffect(() => {
    // A committed empty outlet precedes its text update. Cancel StrictMode/unmount replays.
    let active = true;
    if (!ready) queueMicrotask(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [ready]);
  return kind === 'off' || !client || ready;
}

function feedbackKind(value: FeedbackKind): FeedbackKind {
  return value === 'status' || value === 'alert' ? value : 'off';
}

/** Role intent is owned here; raw native/ARIA role props are deliberately not forwarded. */
export function TTFeedback({ kind = 'status', ...props }: FeedbackProps & {
  message: string;
  style?: StyleProp<TextStyle>;
  visuallyHidden?: boolean;
}) {
  const intent = feedbackKind(kind);
  return <FeedbackText key={intent} kind={intent} message={props.message} style={props.style}
    visuallyHidden={props.visuallyHidden} testID={props.testID} nativeID={props.nativeID} />;
}

function FeedbackText({ kind = 'status', message, style, visuallyHidden, testID, nativeID }: FeedbackProps & {
  message: string; style?: StyleProp<TextStyle>; visuallyHidden?: boolean;
}) {
  const ready = usePrimedRegion(kind);
  const content = ready ? message : '';
  const web = Platform.OS === 'web';
  const live = kind === 'alert' ? 'assertive' : kind === 'status' ? 'polite' : undefined;
  return <Text testID={testID} nativeID={nativeID} accessible={!!content}
    accessibilityRole={!web && kind === 'alert' ? 'alert' : undefined}
    accessibilityLiveRegion={Platform.OS === 'android' ? live : undefined}
    role={web ? kind === 'alert' ? 'alert' : kind === 'status' ? 'status' : undefined : undefined} aria-live={web ? live : undefined}
    style={[style, (visuallyHidden || !content) && styles.outlet]}>{content}</Text>;
}

/** Message-only region: callers keep action/dismiss controls outside it. */
export function TTFeedbackRegion({ kind = 'off', children, style, testID, nativeID }: FeedbackProps & {
  children: React.ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const intent = feedbackKind(kind);
  return <FeedbackRegion key={intent} kind={intent} style={style} testID={testID} nativeID={nativeID}>{children}</FeedbackRegion>;
}

function FeedbackRegion({ kind = 'off', children, style, testID, nativeID }: FeedbackProps & {
  children: React.ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const ready = usePrimedRegion(kind);
  const web = Platform.OS === 'web';
  const live = kind === 'alert' ? 'assertive' : kind === 'status' ? 'polite' : undefined;
  return <View testID={testID} nativeID={nativeID} style={style} accessible={!web && kind !== 'off' ? true : undefined}
    accessibilityRole={!web && kind === 'alert' ? 'alert' : undefined}
    accessibilityLiveRegion={Platform.OS === 'android' ? live : undefined}
    role={web ? kind === 'alert' ? 'alert' : kind === 'status' ? 'status' : undefined : undefined} aria-live={web ? live : undefined}>
    {ready ? children : null}
  </View>;
}

// Out of flex flow, but not display:none/aria-hidden: the empty/hidden region stays observable.
const styles = StyleSheet.create({ outlet: { position: 'absolute', width: 1, height: 1, overflow: 'hidden' } });
