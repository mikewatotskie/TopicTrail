import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { connectWebReader, type ReaderConnection } from './reader_channel';
import type { ReaderMessage } from './selection';
export function ReaderFrame({ html, onConnect, onMessage, onFailure }: {
  html: string; onConnect(connection: ReaderConnection): void; onMessage(message: ReaderMessage): void; onFailure(): void;
}) {
  const [session] = useState(() => crypto.randomUUID());
  const callbacks = useRef({ onConnect, onMessage, onFailure });
  useLayoutEffect(() => { callbacks.current = { onConnect, onMessage, onFailure }; }, [onConnect, onMessage, onFailure]);
  const connection = useRef<ReaderConnection | undefined>(undefined);
  const loaded = useRef(false);
  useEffect(() => () => connection.current?.dispose(), []);
  const origin = window.location.origin.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const source = useMemo(() => html.replace('<html', `<html data-reader-session="${session}" data-parent-origin="${origin}"`), [html, session, origin]);
  return <iframe title="Syllabus document" sandbox="allow-scripts" referrerPolicy="no-referrer"
    data-reader-session={session} srcDoc={source}
    style={{ flex: 1, minHeight: 0, minWidth: 0, width: '100%', border: 0 }}
    onLoad={event => {
      if (loaded.current) { connection.current?.dispose(); callbacks.current.onFailure(); return; }
      loaded.current = true;
      connection.current = connectWebReader(event.currentTarget, message => callbacks.current.onMessage(message));
      callbacks.current.onConnect(connection.current);
    }} onError={() => callbacks.current.onFailure()} />;
}
