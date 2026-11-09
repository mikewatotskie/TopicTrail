/**
 * TopicTrail Document Model
 * 
 * Data model for imported syllabus documents (PDF/DOCX).
 */

export enum DocumentFormat {
  PDF = 'pdf',
  DOCX = 'docx',
}

export interface DocumentJson {
  id: string;
  title: string;
  format: string;
  filePath: string;
  importedAt: string;
  fileSize?: number;
  pageCount?: number;
  lastOpenedAt?: string;
}

/**
 * Document model representing an imported syllabus
 */
export class Document {
  constructor(
    public readonly id: string,
    public readonly title: string,
    public readonly format: DocumentFormat,
    public readonly filePath: string,
    public readonly importedAt: Date,
    public readonly fileSize?: number,
    public readonly pageCount?: number,
    public readonly lastOpenedAt?: Date
  ) {}

  copyWith({
    id,
    title,
    format,
    filePath,
    importedAt,
    fileSize,
    pageCount,
    lastOpenedAt,
  }: {
    id?: string;
    title?: string;
    format?: DocumentFormat;
    filePath?: string;
    importedAt?: Date;
    fileSize?: number;
    pageCount?: number;
    lastOpenedAt?: Date;
  } = {}): Document {
    return new Document(
      id ?? this.id,
      title ?? this.title,
      format ?? this.format,
      filePath ?? this.filePath,
      importedAt ?? this.importedAt,
      fileSize ?? this.fileSize,
      pageCount ?? this.pageCount,
      lastOpenedAt ?? this.lastOpenedAt,
    );
  }

  toJson(): DocumentJson {
    return {
      id: this.id,
      title: this.title,
      format: this.format,
      filePath: this.filePath,
      importedAt: this.importedAt.toISOString(),
      fileSize: this.fileSize,
      pageCount: this.pageCount,
      lastOpenedAt: this.lastOpenedAt?.toISOString(),
    };
  }

  static fromJson(value: unknown): Document {
    if (!value || typeof value !== 'object') throw new Error('Invalid document metadata');
    const json = value as DocumentJson;
    if (typeof json.id !== 'string' || !json.id || typeof json.title !== 'string' || !json.title.trim() ||
        !Object.values(DocumentFormat).includes(json.format as DocumentFormat) ||
        typeof json.filePath !== 'string' || !json.filePath ||
        typeof json.importedAt !== 'string' || !Number.isFinite(Date.parse(json.importedAt)) ||
        (json.lastOpenedAt !== undefined && !Number.isFinite(Date.parse(json.lastOpenedAt))) ||
        (json.fileSize !== undefined && (!Number.isFinite(json.fileSize) || json.fileSize < 0)) ||
        (json.pageCount !== undefined && (!Number.isInteger(json.pageCount) || json.pageCount < 1))) {
      throw new Error('Invalid document metadata');
    }
    return new Document(
      json.id,
      json.title,
      json.format as DocumentFormat,
      json.filePath,
      new Date(json.importedAt),
      json.fileSize,
      json.pageCount,
      json.lastOpenedAt ? new Date(json.lastOpenedAt) : undefined,
    );
  }
}
