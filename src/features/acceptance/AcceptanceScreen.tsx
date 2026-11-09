import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Platform, ScrollView, Text, UIManager, View } from 'react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { WebView } from 'react-native-webview';
import { TTButton, TTCard, TTScreen } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { ResourceBrowser } from '../resources/ResourceBrowser';
import {
  ACCEPTANCE_PACKAGE, FIXTURES, FIXTURE_ORIGIN, acceptanceGate, appendNativeEvent, isFixtureUrl,
  makeNativeEvent, nativeConstants, nativeErrorMessage,
  type AcceptanceNativeEvent, type NativeEventKind,
} from './policy';

const PRODUCTION_CASES = [
  { label: 'Wikipedia Photosynthesis', url: 'https://en.wikipedia.org/wiki/Photosynthesis' },
  { label: 'Blocked HTTP initial', url: 'http://en.wikipedia.org/wiki/Photosynthesis' },
  { label: 'Blocked local IP initial', url: 'http://127.0.0.1:8765/page/one' },
  { label: 'Unknown host initial', url: 'https://blocked.invalid/' },
  { label: 'Blocked scheme initial', url: 'topictrail-test://denied' },
] as const;

function readNativeConfig(): unknown {
  try { return UIManager.getViewManagerConfig('RNCWebView'); }
  catch { return undefined; }
}

function constantsText(config: unknown): string {
  try { return JSON.stringify(nativeConstants(config)) ?? 'unavailable'; }
  catch { return 'Actual native constants could not be serialized.'; }
}

type RecordEvent = (kind: NativeEventKind, data: Record<string, unknown>) => void;

export function AcceptanceScreen() {
  if (!__DEV__ || Platform.OS !== 'android' || Constants.expoConfig?.android?.package !== ACCEPTANCE_PACKAGE)
    return <AcceptanceUnavailable />;
  return <AcceptanceDiagnostics />;
}

function AcceptanceUnavailable() {
  const { colors } = useColors();
  return <TTScreen><View style={{ padding: 16, gap: 16 }}>
    <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink }]}>Acceptance unavailable</Text>
    <TTButton label="Exit acceptance" onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/home')} />
  </View></TTScreen>;
}

function AcceptanceDiagnostics() {
  const { colors } = useColors();
  // This is a read from the running binary, never a JS fallback or test marker.
  const [config] = useState(readNativeConfig);
  const gate = acceptanceGate({ development: __DEV__, platform: Platform.OS,
    packageName: Constants.expoConfig?.android?.package, nativeConfig: config });
  const [fixture, setFixture] = useState<string | null>(null);
  const [productionCase, setProductionCase] = useState<(typeof PRODUCTION_CASES)[number] | null>(null);
  const [events, setEvents] = useState<AcceptanceNativeEvent[]>([]);
  const sequence = useRef(0);
  const record = useCallback<RecordEvent>((kind, data) => {
    const event = makeNativeEvent(++sequence.current, kind, data);
    setEvents(previous => appendNativeEvent(previous, event));
    console.info('TOPICTRAIL_ACCEPTANCE', JSON.stringify(event));
  }, []);
  useEffect(() => {
    console.info('TOPICTRAIL_ACCEPTANCE', JSON.stringify({ kind: 'native-constants',
      packageName: Constants.expoConfig?.android?.package, constants: nativeConstants(config) ?? null }));
  }, [config]);
  return <TTScreen><ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
    <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink }]}>Android debug acceptance</Text>
    <Text style={[TTTypography.body, { color: colors.muted }]}>Separate component diagnostics. Local fixtures do not establish production Link Shield or document → Study → provider acceptance.</Text>
    <TTCard style={{ gap: 8 }}>
      <Text selectable testID="acceptance-package" style={[TTTypography.caption, { color: colors.ink }]}>{Constants.expoConfig?.android?.package ?? 'Package unavailable'}</Text>
      <Text selectable testID="acceptance-native-constants" style={[TTTypography.smallStrong, { color: colors.ink }]}>Actual UIManager RNCWebView.Constants: {constantsText(config)}</Text>
      <Text accessibilityRole={gate.enabled ? undefined : 'alert'} style={[TTTypography.body, { color: colors.muted }]}>{gate.reason}</Text>
    </TTCard>
    {gate.enabled && <>
      <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink }]}>Local fixture component cases</Text>
      <Text style={[TTTypography.caption, { color: colors.muted }]}>Only {FIXTURE_ORIGIN} and the listed exact paths. JavaScript off. No document bridge or automatic external opening.</Text>
      <View style={{ gap: 8 }}>
        {FIXTURES.map(item => <TTButton key={item.path} variant="secondary" label={`${item.label} · ${item.path}`}
          semanticLabel={`Open fixture ${item.path}`} onPress={() => {
            const url = FIXTURE_ORIGIN + item.path;
            if (gate.enabled && isFixtureUrl(url)) setFixture(url);
          }} />)}
      </View>
      <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink }]}>Real production browser entry gates</Text>
      <Text style={[TTTypography.body, { color: colors.muted }]}>These buttons launch the unchanged ResourceBrowser directly with fixed inputs. They do not create search results or substitute for the natural Study flow.</Text>
      {PRODUCTION_CASES.map(item => <TTButton key={item.label} variant="secondary" label={item.label}
        semanticLabel={`Production browser: ${item.label}`} onPress={() => setProductionCase(item)} />)}
    </>}
    <EventJournal events={events} />
    <TTButton label="Exit acceptance" variant="ghost" onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/home')} />
  </ScrollView>
    {gate.enabled && fixture && <FixtureSession key={fixture} url={fixture} enabled={gate.enabled}
      constants={constantsText(config)} events={events} record={record} onClose={() => setFixture(null)} />}
    {gate.enabled && productionCase && <ResourceBrowser url={productionCase.url}
      title={`Direct production component: ${productionCase.label}`} onClose={() => setProductionCase(null)} />}
  </TTScreen>;
}

function EventJournal({ events }: { events: readonly AcceptanceNativeEvent[] }) {
  const { colors } = useColors();
  return <View style={{ gap: 4 }}>
    <Text style={[TTTypography.smallStrong, { color: colors.ink }]}>Last 20 live native callbacks ({events.length})</Text>
    <ScrollView testID="acceptance-native-events" style={{ maxHeight: 180 }} contentContainerStyle={{ gap: 4 }}>
      {events.length === 0 && <Text style={[TTTypography.caption, { color: colors.muted }]}>No fixture callbacks received.</Text>}
      {events.map(event => <Text selectable key={event.sequence} style={[TTTypography.caption, { color: colors.ink }]}>{JSON.stringify(event)}</Text>)}
    </ScrollView>
  </View>;
}

function FixtureSession({ url, enabled, constants, events, record, onClose }: {
  url: string; enabled: boolean; constants: string; events: readonly AcceptanceNativeEvent[]; record: RecordEvent; onClose: () => void;
}) {
  const { colors } = useColors();
  const [source, setSource] = useState(url);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'halted'>('loading');
  const [message, setMessage] = useState('Loading fixture');
  const [canGoBack, setCanGoBack] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const web = useRef<WebView<object>>(null);
  const generation = useRef(0);
  const stopped = useRef(false);
  const alive = useRef(true);
  const topLevelUrl = useRef(url);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const halt = useCallback((copy: string) => {
    stopped.current = true; clearTimer(); web.current?.stopLoading(); setMessage(copy); setPhase('halted');
  }, [clearTimer]);
  const startTimer = useCallback(() => {
    clearTimer(); timer.current = setTimeout(() => halt('App timeout after 20 seconds. Native stall fixture waits 30 seconds.'), 20000);
  }, [clearTimer, halt]);
  useEffect(() => {
    alive.current = true;
    if (enabled && isFixtureUrl(source)) startTimer();
    return () => { alive.current = false; clearTimer(); };
  }, [attempt, enabled, source, startTimer, clearTimer]);
  const live = () => alive.current && !stopped.current && generation.current === attempt;
  function screen(destination: string, popup = false) {
    if (!live()) return false;
    if (isFixtureUrl(destination) && !popup) return true;
    // On Android a late callback may follow a request already sent. Stop/unmount
    // cannot retroactively prevent that request; this is not pre-request proof.
    halt(popup ? 'Popup blocked. No external app was opened.' : 'Blocked destination. No external app was opened. A late callback may follow a request already sent.');
    return false;
  }
  function close() { stopped.current = true; clearTimer(); web.current?.stopLoading(); onClose(); }
  function back() { if (live() && canGoBack) web.current?.goBack(); else close(); }
  function reload() {
    if (!enabled || !isFixtureUrl(topLevelUrl.current)) return;
    generation.current += 1; stopped.current = false; setCanGoBack(false);
    setSource(topLevelUrl.current); setMessage('Loading fixture'); setPhase('loading'); setAttempt(value => value + 1);
  }
  // Check again immediately before source construction; Android skips the first shouldStart callback.
  const mayMount = enabled && isFixtureUrl(source) && phase !== 'halted';
  return <Modal visible animationType="slide" onRequestClose={back}><TTScreen>
    <View style={{ padding: 12, gap: 8, backgroundColor: colors.surface }}>
      <Text accessibilityRole="header" style={[TTTypography.smallStrong, { color: colors.ink }]}>LOCAL FIXTURE · component acceptance</Text>
      <Text selectable style={[TTTypography.caption, { color: colors.muted }]}>{ACCEPTANCE_PACKAGE} · UIManager.Constants {constants}</Text>
      <Text selectable testID="acceptance-current-url" style={[TTTypography.caption, { color: colors.ink }]}>Current: {currentUrl}</Text>
      <Text accessibilityLiveRegion="polite" testID="acceptance-status" style={[TTTypography.smallStrong, { color: colors.ink }]}>{phase === 'ready' ? 'Ready' : message} · back={String(canGoBack)}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <TTButton label="Back" semanticLabel="Fixture back" disabled={!canGoBack || phase === 'halted'} onPress={back} />
        <TTButton label="Stop" semanticLabel="Stop fixture" disabled={phase === 'halted'} onPress={() => halt('Stopped by operator. WebView unmounted.')} />
        <TTButton label="Reload" semanticLabel="Reload fixture" onPress={reload} />
        <TTButton label="Close" semanticLabel="Close fixture" onPress={close} />
      </View>
    </View>
    <View style={{ flex: 1, minHeight: 180, borderWidth: 1, borderColor: colors.border }}>
      {mayMount && <WebView<object> key={attempt} ref={web} testID="acceptance-fixture-webview"
        source={{ uri: source }} style={{ flex: 1, backgroundColor: colors.surface }}
        // '*' suppresses the wrapper's automatic Linking.openURL fallback.
        // The strict callback below is the only navigation allow decision.
        originWhitelist={['*']}
        javaScriptEnabled={false} javaScriptCanOpenWindowsAutomatically={false} domStorageEnabled={false}
        allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never" thirdPartyCookiesEnabled={false} sharedCookiesEnabled={false}
        geolocationEnabled={false} mediaPlaybackRequiresUserAction allowsInlineMediaPlayback={false}
        allowsFullscreenVideo={false} saveFormDataDisabled incognito cacheEnabled={false} cacheMode="LOAD_NO_CACHE"
        setSupportMultipleWindows allowsLinkPreview={false} dataDetectorTypes={['none']} webviewDebuggingEnabled={false}
        renderError={() => <View />}
        onShouldStartLoadWithRequest={request => {
          if (!live()) return false;
          const popup = 'hasTargetFrame' in request && request.hasTargetFrame === false;
          const allowed = isFixtureUrl(request.url) && !popup;
          record('request', { url: request.url, popup, allowed });
          return screen(request.url, popup);
        }}
        onOpenWindow={event => {
          if (!live()) return;
          record('open-window', { url: event.nativeEvent.targetUrl, popup: true, allowed: false });
          screen(event.nativeEvent.targetUrl, true);
        }}
        onNavigationStateChange={event => {
          if (!live()) return;
          record('navigation', { url: event.url, canGoBack: event.canGoBack, loading: event.loading });
          if (screen(event.url)) { topLevelUrl.current = event.url; setCurrentUrl(event.url); setCanGoBack(event.canGoBack); }
        }}
        onLoadStart={event => {
          if (!live()) return;
          record('load-start', { url: event.nativeEvent.url });
          if (screen(event.nativeEvent.url)) {
            topLevelUrl.current = event.nativeEvent.url; setCurrentUrl(event.nativeEvent.url);
            setPhase('loading'); setMessage('Loading fixture'); startTimer();
          }
        }}
        onLoadProgress={event => {
          if (!live()) return;
          record('progress', { url: event.nativeEvent.url, progress: event.nativeEvent.progress });
          screen(event.nativeEvent.url);
        }}
        onLoad={event => {
          if (!live()) return;
          record('load', { url: event.nativeEvent.url });
          if (screen(event.nativeEvent.url)) {
            topLevelUrl.current = event.nativeEvent.url; setCurrentUrl(event.nativeEvent.url); clearTimer(); setPhase('ready');
          }
        }}
        onLoadEnd={event => {
          if (!live()) return;
          record('load-end', { url: event.nativeEvent.url }); screen(event.nativeEvent.url);
        }}
        onError={event => {
          if (!live()) return;
          record('error', { url: event.nativeEvent.url, code: event.nativeEvent.code }); halt(nativeErrorMessage(event.nativeEvent.code));
        }}
        onHttpError={event => {
          if (!live()) return;
          record('http-error', { url: event.nativeEvent.url, statusCode: event.nativeEvent.statusCode });
          if (!screen(event.nativeEvent.url)) return;
          if (event.nativeEvent.url === topLevelUrl.current) halt(`HTTP ${event.nativeEvent.statusCode}: fixture response failed.`);
        }}
        onRenderProcessGone={() => {
          if (!live()) return;
          record('render-process-gone', { url: topLevelUrl.current }); halt('Native WebView render process stopped.');
        }} />}
    </View>
    <View style={{ padding: 12, gap: 8 }}><EventJournal events={events} />
      <Text style={[TTTypography.caption, { color: colors.muted }]}>Callbacks are observations, not proof a blocked redirect made no request. Check server and public-download evidence separately.</Text>
    </View>
  </TTScreen></Modal>;
}
