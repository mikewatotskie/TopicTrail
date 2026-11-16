import type { Document } from '../models/document';

// Only the native app uses external file paths for legacy Guest entries.
export async function relinkGuestFile(_document: Document, _checkActive: () => void): Promise<boolean> {
  throw new Error('File relinking is available in the native app.');
}
