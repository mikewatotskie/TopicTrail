const READER_ORIGIN = 'https://appassets.androidplatform.net/topictrail/reader/';

export function packagedReaderSource(format: 'pdf' | 'docx' | 'pptx') {
  return {
    uri: READER_ORIGIN + (format === 'pdf' ? 'pdf.html' : 'office.html'),
    headers: { 'X-TopicTrail-Reader': '1' },
  };
}

// Older native clients and Expo Go use the same offline Metro asset without a network navigation.
export function nativeReaderSource(html: string, platform: string) {
  return platform === 'android' ? { html, baseUrl: READER_ORIGIN } : { html };
}
