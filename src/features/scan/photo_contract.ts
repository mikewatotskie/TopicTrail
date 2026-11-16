/** Only platform-normalized JPEG previews may cross the scan UI boundary. */
export interface ScanPhoto { uri: string; width: number; height: number }
export interface ScanTranscript { text: string; confidence: number | null; truncated: boolean }
