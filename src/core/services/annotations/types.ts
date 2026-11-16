/** Annotations use their own versioned storage/feed. Never add these to StudyKind. */
export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'purple';
export type AnnotationFormat = 'pdf' | 'docx' | 'pptx';
export interface AnnotationLocation { unit: 'page' | 'section' | 'slide'; index: number }
export interface TextAnchorV1 {
  kind: 'text'; version: 1; surface: 'pdf-text' | 'docx-text' | 'pptx-text' | 'ocr-text';
  textHash: string; ranges: { blockId: string; startUtf16: number; endUtf16: number }[];
  quote: string; prefix: string; suffix: string;
}
export interface RegionAnchorV1 {
  kind: 'region'; version: 1;
  /** Ordered [xMin,yMin,xMax,yMax] in unrotated PDF user space. */
  rect: [number, number, number, number]; pageBox: [number, number, number, number];
}
export interface AnnotationPayload {
  id: string; documentId: string | null; documentHash: string | null;
  format: AnnotationFormat | null; location: AnnotationLocation | null;
  anchor: TextAnchorV1 | RegionAnchorV1 | null;
  title: string; body: string; color: AnnotationColor; createdAt: string; updatedAt: string;
}
export interface AnnotationRecord { id: string; revision: number; deleted: boolean; payload: AnnotationPayload }
export interface AnnotationMutation {
  operationId: string; id: string; expectedRevision: number;
  action: 'put' | 'remove' | 'restore'; payload: AnnotationPayload;
}
export interface AnnotationReply {
  status: 'applied' | 'conflict'; record: AnnotationRecord; duplicate?: boolean;
  reason?: 'revision' | 'parent-trashed';
}
export interface AnnotationConflict {
  id: string; local: AnnotationMutation; cloud: AnnotationRecord; reason: 'revision' | 'parent-trashed';
}
export interface AnnotationDraft {
  id: string; payload: AnnotationPayload; updatedAt: string;
  /** Revision observed when the editor opened, retained across interruptions. */
  baseRevision?: number;
}
export interface AnnotationState {
  version: 1; scope: string; records: AnnotationRecord[]; pending: AnnotationMutation[];
  conflicts: AnnotationConflict[]; drafts: AnnotationDraft[];
  guestCopies: { sourceId: string; sourceHash: string; targetId: string }[];
}
export interface AnnotationPort {
  read(): Promise<{ json: string | null; revision: number }>;
  /** Compare-and-swap in one durable transaction. False means reread and retry. */
  commit(expectedRevision: number, json: string): Promise<boolean>;
}
export interface AnnotationParent { hash: string; format: AnnotationFormat; deleted: boolean }
export interface AnnotationListItem extends AnnotationRecord {
  parentDeleted: boolean; syncStatus: 'local' | 'pending' | 'synced' | 'conflict'; conflict?: AnnotationConflict;
}
export interface AnnotationDocumentMapping { documentId: string; documentHash: string; format: AnnotationFormat }
export interface AnnotationRemote {
  list(): Promise<AnnotationRecord[]>;
  apply(mutation: AnnotationMutation): Promise<AnnotationReply>;
}
