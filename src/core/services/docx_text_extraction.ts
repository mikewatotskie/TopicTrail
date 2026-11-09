import { File } from 'expo-file-system';
import { Document } from '../models/document';
import { parseDocx } from './document_validation';

export class DocxTextExtraction {
  static readonly instance = new DocxTextExtraction();
  async extractParagraphs(document: Document): Promise<string[]> { return parseDocx(await new File(document.filePath).bytes()); }
  async extractAllText(document: Document): Promise<string> { return (await this.extractParagraphs(document)).join('\n'); }
  async extractSectionText(document: Document, sectionIndex: number): Promise<string> {
    return (await this.extractParagraphs(document)).slice(sectionIndex * 20, (sectionIndex + 1) * 20).join('\n');
  }
  async getParagraphCount(document: Document): Promise<number> { return (await this.extractParagraphs(document)).length; }
  async searchText(document: Document, query: string): Promise<{ paragraphIndex: number; text: string }[]> {
    if (!query.trim()) return [];
    return (await this.extractParagraphs(document)).map((text, paragraphIndex) => ({ text, paragraphIndex }))
      .filter(result => result.text.toLowerCase().includes(query.toLowerCase()));
  }
}
