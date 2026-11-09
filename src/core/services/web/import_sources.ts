const sources = new Map<string, { file: Blob; pickerUri: string }>();
export function registerWebImportSource(file: globalThis.File, pickerUri: string): string {
  const uri = 'topictrail-pick://' + crypto.randomUUID();
  sources.set(uri, { file, pickerUri }); return uri;
}
export function getWebImportSource(uri: string): Blob {
  const source = sources.get(uri);
  if (!source) throw Error('The selected file is no longer available. Choose the file again.');
  return source.file;
}
export function releaseWebImportSource(uri: string): void {
  const source = sources.get(uri);
  if (source?.pickerUri.startsWith('blob:')) URL.revokeObjectURL(source.pickerUri);
  sources.delete(uri);
}
