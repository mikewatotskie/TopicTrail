/** PDF.js runs in the isolated reader WebView, not in the React Native JS runtime. */
export interface PdfTextPage {
  getTextContent(): Promise<{ items: ({ str: string; hasEOL?: boolean } | object)[] }>;
}
export async function extractPdfPageText(page: PdfTextPage): Promise<string> {
  const content = await page.getTextContent();
  return content.items.map(item => 'str' in item
    ? String(item.str) + ('hasEOL' in item && item.hasEOL ? '\n' : ' ') : '').join('').trim();
}
