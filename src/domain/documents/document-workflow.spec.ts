import { describe, expect, it } from 'vitest';

import {
  assertDocumentItemTransition,
  deriveDocumentRequestStatus,
  validateDocumentUpload,
} from './document-workflow';

describe('document workflow', () => {
  it('accepts only explicit item transitions', () => {
    expect(() =>
      assertDocumentItemTransition('pending-upload', 'submitted'),
    ).not.toThrow();
    expect(() =>
      assertDocumentItemTransition('pending-upload', 'approved'),
    ).toThrow(/Transição documental inválida/);
    expect(() =>
      assertDocumentItemTransition('automatic-validation', 'approved'),
    ).toThrow();
  });

  it('never derives approval while a required item awaits human review', () => {
    expect(
      deriveDocumentRequestStatus([
        { requirement: 'required', status: 'approved' },
        { requirement: 'required', status: 'pending-human-review' },
      ]),
    ).toBe('pending-human-review');
  });

  it('validates real signatures and front/back requirements', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const files = validateDocumentUpload(
      [
        {
          originalName: '../frente.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: jpeg.byteLength,
          content: jpeg,
          side: 'front',
          pageNumber: 1,
        },
        {
          originalName: 'verso.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: jpeg.byteLength,
          content: jpeg,
          side: 'back',
          pageNumber: 1,
        },
      ],
      {
        acceptedMimeTypes: ['image/jpeg'],
        maxFileSizeBytes: 1024,
        minFiles: 2,
        maxFiles: 2,
        allowsMultiplePages: false,
        requiresFrontBack: true,
      },
    );
    expect(files[0]?.originalName).toBe('.._frente.jpg');
    expect(files[0]?.sha256).toHaveLength(64);
  });

  it('groups a complete front/back pair for each child', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const file = (side: 'front' | 'back', pageNumber: number) => ({
      originalName: `filho-${pageNumber}-${side}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: jpeg.byteLength,
      content: jpeg,
      side,
      pageNumber,
    });
    const policy = {
      acceptedMimeTypes: ['image/jpeg'],
      maxFileSizeBytes: 1024,
      minFiles: 2,
      maxFiles: 24,
      allowsMultiplePages: true,
      requiresFrontBack: true,
    };

    expect(() =>
      validateDocumentUpload(
        [file('front', 1), file('back', 1), file('front', 2), file('back', 2)],
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      validateDocumentUpload(
        [file('front', 1), file('back', 1), file('front', 2)],
        policy,
      ),
    ).toThrow(/par completo de frente e verso/);
  });
});
