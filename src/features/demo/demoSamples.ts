import { strToU8, zipSync } from 'fflate';

export type DemoSampleKind = 'pdf' | 'docx';
export interface DemoSample {
  readonly kind: DemoSampleKind;
  readonly title: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly detail: string;
  createBytes(): Uint8Array;
}

const pdfLessons = [
  {
    title: 'Variables and values',
    tag: 'STORE INFORMATION',
    lines: [
      'A variable gives a value a name so a program can use it again.',
      'A name like totalMinutes is easier to read than a mystery number.',
      'Choose names that explain what the values represent.',
      '',
      'Try it',
      'Give a study session a length of 25 minutes.',
      'Add a 5-minute break and predict the new total.',
      '',
      'Study prompt',
      'Select the heading above, then choose Study to explore the topic.',
    ],
  },
  {
    title: 'Loops and iteration',
    tag: 'REPEAT A STEP',
    lines: [
      'Iteration means repeating a step for each item or until a condition is met.',
      'Use a counted loop when you know how many times to repeat.',
      'Use a conditional loop when a result tells you when to stop.',
      '',
      'Try it',
      'Write a plan for reading five pages each day for four days.',
      'Describe what changes on each repetition and when the loop ends.',
      '',
      'Study prompt',
      'Highlight Loops and iteration, then choose Study to explore the topic.',
    ],
  },
  {
    title: 'Functions and reuse',
    tag: 'NAME A REUSABLE TASK',
    lines: [
      'A function bundles a task under a name you can call again.',
      'Inputs let the same function work with different values.',
      'A return value lets another part of the program use the result.',
      '',
      'Try it',
      'Describe a function that converts a number of hours to minutes.',
      'Test your plan with one hour, two hours, and zero hours.',
      '',
      'Study prompt',
      'Close the reader and reopen this syllabus to check your saved place.',
    ],
  },
];

function escapePdf(value: string): string {
  return value.replace(/[\\()]/g, '\\$&');
}

function makePdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [5 0 R 7 0 R 9 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  for (const [index, lesson] of pdfLessons.entries()) {
    const pageObject = objects.length + 1;
    const lines = [
      '0.89 0.92 0.99 rg 48 670 516 72 re f',
      '0.0 0.20 0.60 rg',
      'BT /F2 11 Tf 1 0 0 1 66 716 Tm (TOPICTRAIL PRACTICE SYLLABUS) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 66 693 Tm (INTRO TO PROGRAMMING) Tj ET',
      '0.07 0.13 0.23 rg',
      'BT /F2 25 Tf 1 0 0 1 56 616 Tm (' + escapePdf(lesson.title) + ') Tj ET',
      '0.0 0.20 0.60 rg',
      'BT /F2 11 Tf 1 0 0 1 56 585 Tm (' + lesson.tag + ') Tj ET',
      '0.07 0.13 0.23 rg',
      ...lesson.lines.map((line, i) => {
        const font = line === 'Try it' || line === 'Study prompt' ? '/F2' : '/F1';
        return 'BT ' + font + ' 12 Tf 1 0 0 1 56 ' + (545 - i * 25) + ' Tm (' + escapePdf(line) + ') Tj ET';
      }),
      '0.78 0.83 0.91 RG 56 100 m 556 100 l S',
      '0.32 0.38 0.48 rg',
      'BT /F1 10 Tf 1 0 0 1 56 76 Tm (ORIGINAL SYNTHETIC PRACTICE MATERIAL) Tj ET',
      'BT /F2 10 Tf 1 0 0 1 506 76 Tm (PAGE ' + (index + 1) + ' / 3) Tj ET',
    ].join('\n');
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + (pageObject + 1) + ' 0 R >>',
      '<< /Length ' + lines.length + ' >>\nstream\n' + lines + '\nendstream',
    );
  }
  // The PDF body is ASCII, so string offsets are also byte offsets.
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    return String(offset).padStart(10, '0') + ' 00000 n \n';
  });
  const start = pdf.length;
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.join('');
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF\n';
  return strToU8(pdf);
}

const docxSections = [
  {
    title: 'Observe the evidence',
    paragraphs: [
      'Begin with one question that can be answered by observing the same place more than once.',
      'Imagine a school garden after a short rain. What could you record without moving any objects?',
      'Write the time, weather, location, and anything you can count or describe directly.',
      'Choose a consistent unit for each count. Use centimeters for length and minutes for time.',
      'Keep an observation separate from an explanation. "Three leaves were wet" is an observation.',
      'Compare one detail you expected with one detail that surprised you.',
      'Use the same place as a reference point each time you observe.',
      'Draw a simple sketch if a shape or location is hard to describe in words.',
      'Write which direction you faced when you took a measurement.',
      'Record the unit beside every number to make comparisons easier.',
      'Read a measurement twice if the first reading is hard to see.',
      'List any tools you used, such as a ruler, clock, or notebook.',
      'Note how long you waited before taking a second measurement.',
      'Choose a place to stand where you can see the garden clearly.',
      'Describe any changes in light that might affect what you can see.',
      'Write down the time you plan to return for the next observation.',
      'Practice. Describe a small change you could observe over three days.',
    ],
  },
  {
    title: 'Organize your notes',
    paragraphs: [
      'Group observations by date so a reader can trace the order in which events happened.',
      'Give each entry a short label, such as weather, plant growth, or visitor activity.',
      'Create a record with a date, a measurement, and a brief description on the same line.',
      'Add a space for missing information so a blank value is easy to interpret.',
      'Look across the rows for a pattern before drawing a conclusion.',
      'If two entries disagree, return to your notes and check how the observations were made.',
      'Give each observation a short identifier such as Garden 01.',
      'Leave a column for a second measurement taken later the same day.',
      'Write the date in the same format throughout your notes.',
      'Use a separate row whenever you return at a different time.',
      'Group your notes by the question each observation helps answer.',
      'Mark an estimate so a reader can distinguish it from a measurement.',
      'Check whether a blank cell means the value was missing or never measured.',
      'Keep your original entry and write any correction beside it.',
      'Make a simple key for abbreviations used in your record.',
      'Put sketches and photos in the same order as the entries they illustrate.',
      'Review the notes with a partner and identify one unclear label.',
      'Create a brief summary of the data before comparing the entries.',
      'Practice. Sort four imaginary entries by date, then describe one change.',
    ],
  },
  {
    title: 'Explain your findings',
    paragraphs: [
      'Answer the original question in one clear sentence.',
      'Support the answer with two observations that a reader could find in your record.',
      'Name one detail that may have influenced the outcome, such as the time of day.',
      'Write a new question that someone could investigate using the same method.',
      'Share your explanation with a partner and ask which observation makes it clearest.',
      'Practice. Write a two-sentence conclusion and identify a detail you still want to measure.',
      'Reader check. Return to My Syllabi, then reopen this document to check your saved place.',
    ],
  },
];

function paragraph(text: string, heading = false): string {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const formatting = heading ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : '';
  return '<w:p><w:r>' + formatting + '<w:t xml:space="preserve">' + escaped + '</w:t></w:r></w:p>';
}

function makeDocx(): Uint8Array {
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const sections = docxSections.map(section =>
    paragraph(section.title, true) + section.paragraphs.map(text => paragraph(text)).join(''));
  return zipSync({
    '[Content_Types].xml': strToU8(xml +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'),
    '_rels/.rels': strToU8(xml +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>'),
    'word/document.xml': strToU8(xml +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      paragraph('Field Notes and Evidence', true) +
      paragraph('TopicTrail practice workbook. Original synthetic study material.') +
      sections.join('') + '<w:sectPr/></w:body></w:document>'),
  }, { mtime: new Date(1980, 0, 1) });
}

export const demoSamples = [
  {
    kind: 'pdf',
    title: 'Intro to Programming',
    filename: 'Intro to Programming.pdf',
    mimeType: 'application/pdf',
    detail: 'PDF · 3 pages · Selectable text',
    createBytes: makePdf,
  },
  {
    kind: 'docx',
    title: 'Field Notes and Evidence',
    filename: 'Field Notes and Evidence.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    detail: 'DOCX · 3 sections · Scrollable text',
    createBytes: makeDocx,
  },
] as const satisfies readonly DemoSample[];
