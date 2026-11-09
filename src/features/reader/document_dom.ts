/** Plain text insertion deliberately avoids parsing document text as HTML. */
export function renderDocxParagraphs(root: HTMLElement, paragraphs: string[]) {
  root.replaceChildren();
  for (const paragraph of paragraphs) {
    const node = root.ownerDocument.createElement('p');
    node.textContent = paragraph || '\u00a0';
    root.appendChild(node);
  }
}
