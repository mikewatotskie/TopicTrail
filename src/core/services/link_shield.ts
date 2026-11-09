/** Local address screening only: no DNS, certificate inspection or reputation API. */
export interface LinkAssessment {
  status: 'recognized' | 'unrecognized' | 'blocked' | 'unable_to_verify';
  connection: 'https' | 'unsupported' | 'unknown';
  recognition: 'educational' | 'reference' | 'unknown';
  normalizedUrl?: string;
  hostname?: string;
  sourceName?: string;
  reasons: readonly string[];
  warnings: readonly string[];
  canOpenInApp: boolean;
  canOpenExternal: boolean;
  reputation: 'not_checked';
}

interface Source { name: string; group: string; kind: 'educational' | 'reference' }
// Exact parsed hostnames, never raw string prefixes or implicit subdomains.
const sources: Readonly<Record<string, Source>> = Object.freeze({
  'en.wikipedia.org': { name: 'Wikipedia', group: 'wikipedia-en', kind: 'educational' },
  'en.m.wikipedia.org': { name: 'Wikipedia', group: 'wikipedia-en', kind: 'educational' },
  'en.wikibooks.org': { name: 'Wikibooks', group: 'wikibooks-en', kind: 'educational' },
  'docs.python.org': { name: 'Python documentation', group: 'python', kind: 'educational' },
  'developer.mozilla.org': { name: 'MDN Web Docs', group: 'mdn', kind: 'educational' },
  'openstax.org': { name: 'OpenStax', group: 'openstax', kind: 'educational' },
  'www.openstax.org': { name: 'OpenStax', group: 'openstax', kind: 'educational' },
  'ocw.mit.edu': { name: 'MIT OpenCourseWare', group: 'mit-ocw', kind: 'educational' },
  'creativecommons.org': { name: 'Creative Commons', group: 'creative-commons', kind: 'reference' },
});
const reputationNotice = 'Reputation check unavailable. HTTPS and source recognition do not guarantee safety or accuracy.';
const localSuffixes = ['localhost', 'local', 'localdomain', 'internal', 'lan', 'home', 'home.arpa'];
const familiarDomains = ['wikipedia.org', 'wikibooks.org', 'python.org', 'mozilla.org', 'openstax.org', 'mit.edu', 'creativecommons.org'];
const controls = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/;

function refused(reason: string, connection: LinkAssessment['connection'] = 'unknown', unavailable = false): LinkAssessment {
  return { status: unavailable ? 'unable_to_verify' : 'blocked', connection, recognition: 'unknown',
    reasons: [reason], warnings: [reputationNotice], canOpenInApp: false, canOpenExternal: false, reputation: 'not_checked' };
}

// RFC3986 unreserved encodings are equivalent. Keep reserved characters encoded,
// and preserve query order, fragments, path case and trailing slash distinctions.
function canonicalEscapes(url: string): string {
  return url.replace(/%[\da-f]{2}/gi, encoded => {
    const character = String.fromCharCode(parseInt(encoded.slice(1), 16));
    return /^[A-Za-z0-9._~-]$/.test(character) ? character : encoded.toUpperCase();
  });
}

export function evaluateUrl(value: unknown): LinkAssessment {
  if (typeof value !== 'string' || !value.trim()) return refused('No usable destination was supplied.', 'unknown', true);
  if (value.length > 2048 || controls.test(value)) return refused('The destination contains unsupported characters or is too long.');
  const input = value.trim();
  if (/[\s\\]/u.test(input) || /%(?![\da-f]{2})/i.test(input) || /%(?:0[\da-f]|1[\da-f]|7f|5c)/i.test(input)) {
    return refused('The destination has malformed escapes, whitespace or unsupported characters.');
  }
  let parsed: URL;
  try { parsed = new URL(input); } catch { return refused('This destination is not a valid absolute URL.'); }
  if (parsed.protocol !== 'https:') return refused('Only HTTPS website destinations are supported.', 'unsupported');
  // WHATWG URL repairs forms such as https:///host; reject that ambiguity.
  const authority = /^https:\/\/([^/?#]+)/i.exec(input)?.[1];
  if (!authority) return refused('A complete HTTPS website address is required.', 'https');
  if (authority.includes('@') || parsed.username || parsed.password) return refused('URLs containing sign-in credentials are blocked.', 'https');
  if (parsed.port) return refused('This destination uses an unsupported port. Only the default HTTPS port is allowed.', 'https');
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  // URL canonicalizes alternative IPv4 representations (integer, octal, hex,
  // shortened forms). Conservatively rejecting ALL literals also covers IPv6,
  // mapped and translated private ranges without a fragile hand-written CIDR parser.
  if (hostname.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return refused('IP-address destinations are unsupported, including local and private addresses.', 'https');
  }
  if (!hostname.includes('.') || localSuffixes.some(suffix => hostname === suffix || hostname.endsWith('.' + suffix))) {
    return refused('Local or private-network hostnames are blocked.', 'https');
  }
  if (hostname.length > 253 || hostname.split('.').some(label =>
    label.length < 1 || label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(label))) {
    return refused('This destination has an invalid hostname.', 'https');
  }
  parsed.hostname = hostname;
  const normalizedUrl = canonicalEscapes(parsed.href);
  if (normalizedUrl.length > 2048) return refused('The normalized destination is too long.', 'https');
  const source = Object.hasOwn(sources, hostname) ? sources[hostname] : undefined;
  const warnings = [reputationNotice];
  if (hostname.split('.').some(label => label.startsWith('xn--'))) {
    warnings.push('This is an internationalized hostname. Check the displayed domain carefully; lookalikes are not comprehensively detected.');
  }
  if (!source && familiarDomains.some(domain => hostname.includes(domain))) {
    warnings.push('This hostname contains or resembles a familiar source name but is not a configured source domain.');
  }
  return {
    status: source ? 'recognized' : 'unrecognized', connection: 'https',
    recognition: source?.kind ?? 'unknown', normalizedUrl, hostname, sourceName: source?.name,
    reasons: [source ? `The parsed hostname matches the configured ${source.name} source.` :
      'This source is not in the configured list. Review the domain before opening it in your system browser.'],
    warnings, canOpenInApp: source?.kind === 'educational', canOpenExternal: true, reputation: 'not_checked',
  };
}

export function canonicalBookmarkUrl(value: unknown): string | null {
  return evaluateUrl(value).normalizedUrl ?? null;
}

export function decideNavigation(initialUrl: string, destination: unknown): { action: 'allow' | 'review' | 'block'; assessment: LinkAssessment } {
  const initial = evaluateUrl(initialUrl);
  const assessment = evaluateUrl(destination);
  if (!initial.canOpenInApp || !assessment.canOpenExternal) return { action: 'block', assessment };
  const initialSource = initial.hostname ? sources[initial.hostname] : undefined;
  const nextSource = assessment.hostname && Object.hasOwn(sources, assessment.hostname) ? sources[assessment.hostname] : undefined;
  return { action: assessment.canOpenInApp && initialSource?.group === nextSource?.group ? 'allow' : 'review', assessment };
}
