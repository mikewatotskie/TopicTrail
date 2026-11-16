import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationPayload } from '../../core/services/annotations/types';
import { useOcrCache } from '../reader/useOcrCache';
import { createOcrPlacementCheck, ocrPlacementKey, type OcrNotePlacement, type OcrPlacementOwner, type OcrPlacementTarget, type OcrRenderPlacements } from './ocrPlacement';

const readWarning = 'Saved OCR text could not be read. Your notes, saved passages and original files are preserved. Placement will be checked when the page is opened.';

function activeOwner(owner: OcrPlacementOwner | undefined): boolean {
  if (!owner) return false;
  try { owner.checkActive(); return true; } catch { return false; }
}

/** Read-only device-local checks. No transcript, status or map is stored globally or synchronized. */
export function useOcrNotePlacements(payloads: readonly AnnotationPayload[], owner: OcrPlacementOwner | undefined, rendered?: OcrRenderPlacements) {
  const cache = useOcrCache();
  // Body/color/filter edits and the fresh functions returned by useOcrCache must
  // not restart reads. Only a changed anchor/document/page/account creates work.
  const requestKey = JSON.stringify([...new Set(payloads.map(ocrPlacementKey).filter((key): key is string => key !== null))].sort());
  const requests = useMemo(() => (JSON.parse(requestKey) as string[]).map(key => ({ key, target: JSON.parse(key) as OcrPlacementTarget })), [requestKey]);
  const latest = useRef({ cache, owner, requests });
  useLayoutEffect(() => { latest.current = { cache, owner, requests }; });
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ owner: OcrPlacementOwner; requests: typeof requests; statuses: Map<string, OcrNotePlacement>; warning: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = latest.current.cache;
    const current = () => !cancelled && latest.current.owner === owner && latest.current.requests === requests && activeOwner(owner) && api.isCurrent();
    if (!owner || !requests.length || !current()) return;
    void (async () => {
      const statuses = new Map<string, OcrNotePlacement>();
      const pages = new Map<string, typeof requests>();
      let warning = '';
      for (const request of requests) {
        const { documentId, documentHash, format, location } = request.target;
        if (!documentId || !documentHash || !/^[a-f0-9]{64}$/.test(documentHash) || format !== 'pdf' ||
            location?.unit !== 'page' || !Number.isSafeInteger(location.index) || location.index < 1 || location.index > 100_000) {
          statuses.set(request.key, 'needs-review');
          continue;
        }
        const key = `${documentHash}/${location.index}`;
        const group = pages.get(key) ?? [];
        group.push(request); pages.set(key, group);
      }
      // Deduplicate same-page notes and bound storage IO instead of launching one
      // request per note. Check both the account epoch and input lifetime after IO.
      for (const group of pages.values()) {
        if (!current()) return;
        try {
          const { documentHash, location } = group[0].target;
          const result = await api.read(documentHash!, location!.index);
          if (!current()) return;
          const check = createOcrPlacementCheck(result?.text ?? null);
          for (const { key, target } of group) if (target.anchor?.kind === 'text') statuses.set(key, check(target.anchor));
        } catch {
          if (!current()) return;
          warning = readWarning;
          for (const { key } of group) statuses.set(key, 'check-on-open');
        }
      }
      if (current()) setSnapshot({ owner, requests, statuses, warning });
    })();
    return () => { cancelled = true; };
  }, [owner, requests, revision]);

  const current = activeOwner(owner) && cache.isCurrent();
  const saved = current && snapshot && snapshot.owner === owner && snapshot.requests === requests ? snapshot : null;
  const warning = requests.length && current ? cache.warning || saved?.warning || '' : '';
  const live = useMemo(() => new Map(rendered?.checks.map(check => [check.key, check.status])), [rendered]);
  function placement(payload: AnnotationPayload): OcrNotePlacement | undefined {
    const key = ocrPlacementKey(payload);
    if (key === null) return undefined;
    if (!current) return 'check-on-open';
    const renderedStatus = rendered?.owner === owner ? live.get(key) : undefined;
    if (renderedStatus === 'needs-review' || renderedStatus === 'placed') return renderedStatus;
    const cachedStatus = saved?.statuses.get(key);
    if (cachedStatus === 'needs-review') return cachedStatus;
    if (renderedStatus === 'recognize-page') return renderedStatus;
    if (cachedStatus === 'recognize-page' && warning) return 'check-on-open';
    return cachedStatus ?? 'check-on-open';
  }
  return { placement, warning, recheck: () => setRevision(value => value + 1) };
}
