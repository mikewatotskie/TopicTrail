/** Plain text insertion deliberately avoids parsing document text as HTML. */
export function renderDocxParagraphs(root: HTMLElement, paragraphs: string[], startIndex = 0,
  surface: 'docx-text' | 'pptx-text' = 'docx-text', prefix = 'docx-p-') {
  root.replaceChildren();
  for (const [index, paragraph] of paragraphs.entries()) {
    const node = root.ownerDocument.createElement('p');
    node.textContent = paragraph || '\u00a0';
    node.dataset.annotationBlock = prefix + (startIndex + index);
    node.dataset.annotationSurface = surface;
    node.dataset.annotationText = paragraph;
    root.appendChild(node);
  }
}
export function renderPptxSlide(root:HTMLElement,slide:import('../../core/services/pptx_parser').PptxSlide){
  renderDocxParagraphs(root,slide.paragraphs,0,'pptx-text','pptx-p-');
  const doc=root.ownerDocument;
  for(const [tableIndex,rows] of slide.tables.entries()){const table=doc.createElement('table');table.style.borderCollapse='collapse';table.style.width='100%';
    for(const [rowIndex,cells] of rows.entries()){const row=doc.createElement('tr');for(const [cellIndex,text] of cells.entries()){const cell=doc.createElement('td');cell.textContent=text;cell.dataset.annotationBlock=`pptx-table-${tableIndex}-row-${rowIndex}-cell-${cellIndex}`;cell.dataset.annotationSurface='pptx-text';cell.dataset.annotationText=text;cell.style.border='1px solid #718096';cell.style.padding='8px';row.append(cell);}table.append(row);}root.append(table);}
  for(const image of slide.images){const node=doc.createElement('img');node.src='data:'+image.mime+';base64,'+image.base64;node.alt=image.alt;node.style.maxWidth='100%';node.style.height='auto';root.append(node);}
  if(slide.notes.length){const details=doc.createElement('details');const summary=doc.createElement('summary');summary.textContent='Speaker notes';details.append(summary);const body=doc.createElement('section');renderDocxParagraphs(body,slide.notes,0,'pptx-text','pptx-note-');details.append(body);root.append(details);}
}
