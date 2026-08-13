// Document generation: presentations, documents and spreadsheets.
//
// The model supplies a structured outline — titles, bullets, rows — and this
// module turns that outline into a real file. The model never emits file bytes,
// never emits markup, and never emits code: it fills in a schema, and the
// schema is what gets rendered. That keeps a bad or adversarial generation to
// "the slides say something silly" rather than "the file does something".
//
// Everything here is pure JavaScript. No native modules, no headless browser,
// no shelling out to Office.

import PptxGenJSImport from 'pptxgenjs';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import { z } from 'zod';

/**
 * pptxgenjs declares both `export default` and `export as namespace`, which
 * makes TypeScript resolve the default import to the namespace under NodeNext
 * even though at runtime it is the constructor (verified). Only the handful of
 * members used here are described, so a wrong call is still a type error.
 */
interface PptxSlide {
  addText(text: unknown, options?: Record<string, unknown>): void;
  addNotes(notes: string): void;
}
interface PptxDeck {
  layout: string;
  title: string;
  addSlide(): PptxSlide;
  write(options: { outputType: 'nodebuffer' }): Promise<Buffer>;
}
const PptxGenJS = PptxGenJSImport as unknown as new () => PptxDeck;

/** Bounds, so a runaway generation cannot produce a 500 MB file. */
const LIMITS = {
  slides: 40,
  bulletsPerSlide: 12,
  sections: 60,
  paragraphsPerSection: 30,
  sheets: 12,
  rows: 5000,
  columns: 60,
  text: 4000,
};

const shortText = z.string().min(1).max(300);
const bodyText = z.string().min(1).max(LIMITS.text);

export const presentationSchema = z.object({
  kind: z.literal('presentation'),
  title: shortText,
  subtitle: shortText.optional(),
  slides: z
    .array(
      z.object({
        title: shortText,
        bullets: z.array(bodyText).max(LIMITS.bulletsPerSlide).default([]),
        notes: bodyText.optional(),
      }),
    )
    .min(1)
    .max(LIMITS.slides),
});

export const documentSchema = z.object({
  kind: z.literal('document'),
  title: shortText,
  subtitle: shortText.optional(),
  sections: z
    .array(
      z.object({
        heading: shortText.optional(),
        paragraphs: z.array(bodyText).max(LIMITS.paragraphsPerSection).default([]),
        bullets: z.array(bodyText).max(LIMITS.paragraphsPerSection).default([]),
        table: z
          .object({
            headers: z.array(shortText).min(1).max(LIMITS.columns),
            rows: z.array(z.array(shortText).max(LIMITS.columns)).max(200),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(LIMITS.sections),
});

export const spreadsheetSchema = z.object({
  kind: z.literal('spreadsheet'),
  title: shortText,
  sheets: z
    .array(
      z.object({
        name: z.string().min(1).max(31),
        headers: z.array(shortText).min(1).max(LIMITS.columns),
        rows: z
          .array(z.array(z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])))
          .max(LIMITS.rows),
      }),
    )
    .min(1)
    .max(LIMITS.sheets),
});

export const documentRequestSchema = z.discriminatedUnion('kind', [
  presentationSchema,
  documentSchema,
  spreadsheetSchema,
]);

export type DocumentRequest = z.infer<typeof documentRequestSchema>;
export type DocumentKind = DocumentRequest['kind'];

export interface GeneratedDocument {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

const MIME: Record<DocumentKind, string> = {
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const EXTENSION: Record<DocumentKind, string> = {
  presentation: 'pptx',
  document: 'docx',
  spreadsheet: 'xlsx',
};

/**
 * Safe, readable filename. Everything outside a small allowlist is dropped
 * rather than escaped: the name reaches a Content-Disposition header and a
 * user's filesystem, and neither is a place to be clever.
 */
export function safeFilename(title: string, kind: DocumentKind): string {
  const base =
    title
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60)
      .replace(/^-+|-+$/g, '') || 'document';
  return `${base}.${EXTENSION[kind]}`;
}

async function buildPresentation(spec: z.infer<typeof presentationSchema>): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = spec.title;

  const title = pptx.addSlide();
  title.addText(spec.title, {
    x: 0.6,
    y: 2.1,
    w: 8.8,
    h: 1.2,
    fontSize: 40,
    bold: true,
    color: '1F2937',
  });
  if (spec.subtitle) {
    title.addText(spec.subtitle, {
      x: 0.6,
      y: 3.3,
      w: 8.8,
      h: 0.8,
      fontSize: 20,
      color: '6B7280',
    });
  }

  for (const slide of spec.slides) {
    const s = pptx.addSlide();
    s.addText(slide.title, {
      x: 0.6,
      y: 0.4,
      w: 8.8,
      h: 0.9,
      fontSize: 28,
      bold: true,
      color: '1F2937',
    });
    if (slide.bullets.length > 0) {
      s.addText(
        slide.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
        { x: 0.8, y: 1.5, w: 8.4, h: 3.6, fontSize: 16, color: '374151', valign: 'top' },
      );
    }
    if (slide.notes) s.addNotes(slide.notes);
  }

  // pptxgenjs types the nodebuffer case loosely; it does return a Buffer here.
  const out = (await pptx.write({ outputType: 'nodebuffer' })) as unknown as Buffer;
  return out;
}

async function buildDocument(spec: z.infer<typeof documentSchema>): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      text: spec.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
    }),
  ];
  if (spec.subtitle) {
    children.push(
      new Paragraph({ children: [new TextRun({ text: spec.subtitle, italics: true })] }),
    );
  }

  for (const section of spec.sections) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    }
    for (const paragraph of section.paragraphs) {
      children.push(new Paragraph({ text: paragraph }));
    }
    for (const bullet of section.bullets) {
      children.push(new Paragraph({ text: bullet, bullet: { level: 0 } }));
    }
    if (section.table) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: section.table.headers.map(
                (header) =>
                  new TableCell({
                    children: [
                      new Paragraph({ children: [new TextRun({ text: header, bold: true })] }),
                    ],
                  }),
              ),
            }),
            ...section.table.rows.map(
              (row) =>
                new TableRow({
                  children: row.map(
                    (cell) => new TableCell({ children: [new Paragraph({ text: cell })] }),
                  ),
                }),
            ),
          ],
        }),
      );
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

async function buildSpreadsheet(spec: z.infer<typeof spreadsheetSchema>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AGI-v1';
  workbook.created = new Date();

  for (const sheetSpec of spec.sheets) {
    // Excel rejects these characters in a sheet name and errors on save.
    const sheet = workbook.addWorksheet(sheetSpec.name.replace(/[\\/*?:[\]]/g, '-'));
    sheet.addRow(sheetSpec.headers);
    sheet.getRow(1).font = { bold: true };
    for (const row of sheetSpec.rows) sheet.addRow(row);

    sheet.columns.forEach((column, index) => {
      const header = sheetSpec.headers[index] ?? '';
      let widest = header.length;
      for (const row of sheetSpec.rows) {
        const value = row[index];
        if (value !== null && value !== undefined) {
          widest = Math.max(widest, String(value).length);
        }
      }
      column.width = Math.min(Math.max(widest + 2, 10), 60);
    });
  }

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

/** Render a validated request into real file bytes. */
export async function generateDocument(request: DocumentRequest): Promise<GeneratedDocument> {
  const bytes =
    request.kind === 'presentation'
      ? await buildPresentation(request)
      : request.kind === 'document'
        ? await buildDocument(request)
        : await buildSpreadsheet(request);

  return {
    filename: safeFilename(request.title, request.kind),
    mimeType: MIME[request.kind],
    bytes,
  };
}
