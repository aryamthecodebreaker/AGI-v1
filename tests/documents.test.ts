// Document generation.
//
// The point of these tests is that the bytes are real: an OOXML file is a ZIP
// with a specific internal layout, so a stub that returned an empty buffer or a
// text blob would fail here rather than only failing when someone opens it.

import { describe, expect, it } from 'vitest';
import {
  documentRequestSchema,
  generateDocument,
  safeFilename,
} from '../src/documents/generate.js';

/** OOXML files are ZIP archives: they begin with the local file header "PK\x03\x04". */
function isZip(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Crude but effective: OOXML part names appear literally in the archive. */
function contains(bytes: Buffer, needle: string): boolean {
  return bytes.includes(Buffer.from(needle, 'utf8'));
}

describe('document generation', () => {
  it('builds a real .pptx', async () => {
    const spec = documentRequestSchema.parse({
      kind: 'presentation',
      title: 'AGI Command',
      subtitle: 'Voice-first device control',
      slides: [
        { title: 'The rule', bullets: ['Never claim success without a real result'], notes: 'Say it plainly' },
        { title: 'How it works', bullets: ['Model interprets', 'App decides', 'Devices report'] },
      ],
    });
    const out = await generateDocument(spec);

    expect(out.filename).toBe('AGI-Command.pptx');
    expect(out.mimeType).toContain('presentationml');
    expect(isZip(out.bytes)).toBe(true);
    // A presentation with a title slide plus two content slides is not tiny.
    expect(out.bytes.length).toBeGreaterThan(10_000);
    expect(contains(out.bytes, 'ppt/presentation.xml')).toBe(true);
    expect(contains(out.bytes, 'ppt/slides/slide3.xml')).toBe(true);
  });

  it('builds a real .docx including a table', async () => {
    const spec = documentRequestSchema.parse({
      kind: 'document',
      title: 'Weekly Report',
      sections: [
        {
          heading: 'Summary',
          paragraphs: ['Shipped the device layer.'],
          bullets: ['233 tests passing'],
          table: { headers: ['Item', 'Status'], rows: [['Gateway', 'done'], ['Voice', 'done']] },
        },
      ],
    });
    const out = await generateDocument(spec);

    expect(out.filename).toBe('Weekly-Report.docx');
    expect(isZip(out.bytes)).toBe(true);
    expect(out.bytes.length).toBeGreaterThan(5_000);
    expect(contains(out.bytes, 'word/document.xml')).toBe(true);
  });

  it('builds a real .xlsx with multiple sheets', async () => {
    const spec = documentRequestSchema.parse({
      kind: 'spreadsheet',
      title: 'Q3 Numbers',
      sheets: [
        { name: 'Revenue', headers: ['Month', 'Amount'], rows: [['Jan', 1200], ['Feb', 1500]] },
        { name: 'Costs', headers: ['Month', 'Amount'], rows: [['Jan', 400]] },
      ],
    });
    const out = await generateDocument(spec);

    expect(out.filename).toBe('Q3-Numbers.xlsx');
    expect(isZip(out.bytes)).toBe(true);
    expect(out.bytes.length).toBeGreaterThan(3_000);
    expect(contains(out.bytes, 'xl/workbook.xml')).toBe(true);
  });

  it('sanitises the filename rather than escaping it', () => {
    expect(safeFilename('../../etc/passwd', 'document')).toBe('etcpasswd.docx');
    expect(safeFilename('Report: Q3 <2026>', 'spreadsheet')).toBe('Report-Q3-2026.xlsx');
    expect(safeFilename('***', 'presentation')).toBe('document.pptx');
    expect(safeFilename('a'.repeat(200), 'document')).toMatch(/^a{60}\.docx$/);
  });

  it('rejects a sheet name Excel would refuse, without failing the build', async () => {
    const spec = documentRequestSchema.parse({
      kind: 'spreadsheet',
      title: 'Odd Names',
      sheets: [{ name: 'A/B:C*D?', headers: ['x'], rows: [['y']] }],
    });
    const out = await generateDocument(spec);
    expect(isZip(out.bytes)).toBe(true);
  });

  it('refuses a malformed or oversized outline', () => {
    expect(documentRequestSchema.safeParse({ kind: 'presentation', title: 'x' }).success).toBe(false);
    expect(documentRequestSchema.safeParse({ kind: 'nope', title: 'x' }).success).toBe(false);
    const tooManySlides = {
      kind: 'presentation',
      title: 'Huge',
      slides: Array.from({ length: 100 }, () => ({ title: 's', bullets: [] })),
    };
    expect(documentRequestSchema.safeParse(tooManySlides).success).toBe(false);
  });
});
