import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, ScrollView, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { TTButton, TTCard, TTScreen } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { decideNavigation, evaluateUrl } from '../../core/services/link_shield';
import { ExternalLinkReview } from './ExternalLinkReview';
import { LinkShieldNotice } from './LinkShieldNotice';
import { supportsResourceBrowser } from './nativeDownloadPolicy';

const LOAD_TIMEOUT_MS = 20000;

/** Separate lifetime for each source; Android does not screen its first load via shouldStart. */
export function ResourceBrowser(props: { url: string; title: string; onClose: () => void }) {
  return <BrowserSession key={props.url} {...props} />;
}

function BrowserSession({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const { colors } = useColors();
  const initial = evaluateUrl(url);
  const supported = supportsResourceBrowser();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'review'>('loading');
  const [message, setMessage] = useState('');
  const [review, setReview] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState(initial.normalizedUrl ?? url);
  const [canGoBack, setCanGoBack] = useState(false);
  const [progress, setProgress] = useState(0);
  const web = useRef<WebView<object>>(null);
  const topLevelUrl = useRef(initial.normalizedUrl ?? url);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);
  const generation = useRef(0);
  function clearTimer() { if (timer.current) clearTimeout(timer.current); timer.current = null; }
  function fail(copy: string) { stopped.current = true; clearTimer(); web.current?.stopLoading(); setMessage(copy); setState('error'); }
  function startTimer() {
    clearTimer(); timer.current = setTimeout(() => fail('The page took too long to respond. Check your connection and try again.'), LOAD_TIMEOUT_MS);
  }
  useEffect(() => {
    stopped.current = false;
    if (supported && initial.canOpenInApp) startTimer();
    return () => { clearTimer(); stopped.current = true; };
    // The URL has its own keyed lifetime; subsequent loads explicitly restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function retry() {
    generation.current += 1; stopped.current = false; setReview(null); setMessage(''); setState('loading');
    topLevelUrl.current = initial.normalizedUrl ?? url; setCurrentUrl(topLevelUrl.current); setCanGoBack(false); setProgress(0); setAttempt(value => value + 1); startTimer();
  }
  function screen(destination: string, popup = false) {
    if (stopped.current) return false;
    const decision = decideNavigation(url, destination);
    if (decision.action === 'allow' && !popup) return true;
    // Late callbacks can follow a redirect on Android. Stop AND remove the WebView;
    // this cannot promise that the redirected request was never sent by native code.
    stopped.current = true; clearTimer(); web.current?.stopLoading();
    if (decision.action === 'block') { setMessage('This destination is blocked. No external app was opened.'); setState('error'); }
    else { setReview(destination); setState('review'); }
    return false;
  }
  const live = (callback: () => void) => { if (!stopped.current && generation.current === attempt) callback(); };
  function back() { if (!stopped.current && canGoBack && web.current) web.current.goBack(); else onClose(); }
  return <Modal visible animationType="slide" onRequestClose={back}>
    <TTScreen>
      <View style={{ backgroundColor: colors.brand, padding: 12, gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <TTButton label={canGoBack && (state === 'loading' || state === 'ready') ? 'Back' : 'Resources'} semanticLabel="Browser back" onPress={back} />
          {supported && initial.canOpenInApp && <TTButton label="Reload" onPress={retry} />}
          <TTButton label="Close" semanticLabel="Close website" onPress={onClose} />
        </View>
        <Text numberOfLines={2} style={[TTTypography.smallStrong, { color: colors.onBrand }]}>{title}</Text>
        <Text selectable numberOfLines={2} style={[TTTypography.caption, { color: colors.onBrand }]}>{evaluateUrl(currentUrl).hostname ?? 'Unsupported destination'}</Text>
      </View>
      {!initial.canOpenInApp || !supported ? <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <TTCard style={{ gap: 12 }}>
          <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink }]}>{!initial.canOpenInApp ? 'Cannot open this link in TopicTrail' : Platform.OS === 'android' ? 'An updated TopicTrail viewer is required' : 'In-app browsing is unavailable on this platform'}</Text>
          {initial.canOpenInApp && Platform.OS === 'android' && <Text style={[TTTypography.body, { color: colors.muted }]}>This installed viewer cannot confirm that automatic downloads are blocked. Use an updated TopicTrail app, or explicitly review the external browser option below.</Text>}
          <Text style={[TTTypography.body, { color: colors.muted }]}>Review the link below. External opening is available only for supported HTTPS destinations.</Text>
        </TTCard>
        <LinkShieldNotice url={url} />
        {initial.canOpenExternal && <ExternalLinkReview url={url} onCancel={onClose} />}
      </ScrollView> : <>
        <View style={{ flex: 1, minHeight: 180, margin: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.surface }}>
          {state === 'loading' && <View style={{ padding: 16, gap: 12 }}>
            <Text accessibilityLiveRegion="polite" style={[TTTypography.title, { color: colors.ink }]}>Opening {initial.sourceName ?? title}…</Text>
            <ActivityIndicator color={colors.link} accessibilityLabel="Loading website" />
            <View accessibilityRole="progressbar" accessibilityLabel="Website load progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} style={{ height: 6, borderRadius: 3, backgroundColor: colors.soft }}>
              <View style={{ width: `${Math.round(progress * 100)}%`, height: 6, backgroundColor: colors.link }} />
            </View>
          </View>}
          {(state === 'loading' || state === 'ready') && <WebView<object> key={attempt} ref={web} testID="resource-webview"
            source={{ uri: initial.normalizedUrl! }} style={{ flex: 1, backgroundColor: colors.surface }}
            // '*' prevents the library's originWhitelist -> Linking.openURL fallback.
            // EVERY request is then evaluated by our strict custom callback.
            originWhitelist={['*']} onShouldStartLoadWithRequest={request => generation.current === attempt && !stopped.current && screen(request.url, 'hasTargetFrame' in request && request.hasTargetFrame === false)}
            javaScriptEnabled={false} javaScriptCanOpenWindowsAutomatically={false}
            domStorageEnabled={false} allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
            mixedContentMode="never" thirdPartyCookiesEnabled={false} sharedCookiesEnabled={false}
            geolocationEnabled={false} mediaPlaybackRequiresUserAction allowsInlineMediaPlayback={false}
            incognito cacheEnabled={false} cacheMode="LOAD_NO_CACHE" setSupportMultipleWindows
            allowsLinkPreview={false} dataDetectorTypes={['none']} webviewDebuggingEnabled={false}
            onOpenWindow={event => { live(() => { screen(event.nativeEvent.targetUrl, true); }); }}
            onNavigationStateChange={event => { live(() => { if (screen(event.url)) { topLevelUrl.current = event.url; setCurrentUrl(event.url); setCanGoBack(event.canGoBack); } }); }}
            onLoadStart={event => { live(() => { if (screen(event.nativeEvent.url)) { topLevelUrl.current = event.nativeEvent.url; setState('loading'); setProgress(0); startTimer(); } }); }}
            onLoadProgress={event => { live(() => setProgress(Math.min(1, Math.max(0, event.nativeEvent.progress)))); }}
            onLoad={event => { live(() => { if (screen(event.nativeEvent.url)) { clearTimer(); setCurrentUrl(event.nativeEvent.url); setState('ready'); setProgress(1); } }); }}
            onError={event => { live(() => fail(Platform.OS === 'android' && event.nativeEvent.code === -9001
              ? 'Downloads are not supported in this viewer. Review the external browser option.'
              : 'Couldn’t load this page. Check your connection and try again.')); }}
            onHttpError={event => { live(() => {
              // Native14.0.1 already filters main-frame HTTP errors. Keep this
              // defensive top-level check for callbacks without a main-frame flag.
              // Fragments distinguish bookmarks but are not part of an HTTP request.
              const failedPage = evaluateUrl(event.nativeEvent.url).normalizedUrl?.split('#')[0];
              const currentPage = evaluateUrl(topLevelUrl.current).normalizedUrl?.split('#')[0];
              if (failedPage && failedPage === currentPage)
                fail('The website returned an error. Try again or review the external browser option.');
            }); }}
            onRenderProcessGone={() => { live(() => fail('The website viewer stopped. Try again.')); }}
            onContentProcessDidTerminate={() => { live(() => fail('The website viewer stopped. Try again.')); }}
            // iOS only. Android uses the patched native listener and -9001 error above.
            onFileDownload={Platform.OS === 'ios' ? () => { live(() => fail('Downloads are not supported in this viewer. Review the external browser option.')); } : undefined} />}
          {(state === 'error' || state === 'review') && <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
            {state === 'error' && <><Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink }]}>Couldn’t load this page</Text>
              <Text accessibilityRole="alert" style={[TTTypography.body, { color: colors.muted }]}>{message}</Text></>}
            {review && <ExternalLinkReview key={review} url={review} onCancel={retry} />}
            <TTButton label="Try again" onPress={retry} />
          </ScrollView>}
        </View>
        <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 8 }}>
          <Text style={[TTTypography.caption, { color: colors.muted }]}>JavaScript is off. Some pages may not work. Website content is online and is not downloaded for offline reading.</Text>
          {state !== 'review' && <TTButton label="Open in browser" variant="study" onPress={() => {
            stopped.current = true; clearTimer(); web.current?.stopLoading(); setReview(currentUrl); setState('review');
          }} />}
        </View>
      </>}
    </TTScreen>
  </Modal>;
}
