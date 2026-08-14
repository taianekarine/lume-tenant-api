import { describe, expect, it } from 'vitest';

import { inspectProfileImage } from './profile-image';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13], 0);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(19);
  bytes.set(
    [0xff, 0xd8, 0x00, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x07, 8],
    0,
  );
  const view = new DataView(bytes.buffer);
  view.setUint16(12, height);
  view.setUint16(14, width);
  return bytes;
}

function webp(
  chunk: 'VP8X' | 'VP8 ' | 'VP8L',
  payload: readonly number[],
): Uint8Array {
  const bytes = new Uint8Array(20 + payload.length);
  bytes.set(Buffer.from('RIFF'), 0);
  bytes.set(Buffer.from('WEBP'), 8);
  bytes.set(Buffer.from(chunk), 12);
  new DataView(bytes.buffer).setUint32(16, payload.length, true);
  bytes.set(payload, 20);
  return bytes;
}

describe('inspectProfileImage', () => {
  it('identifica PNG, JPEG e as trÃªs codificaÃ§Ãµes WebP suportadas', () => {
    expect(inspectProfileImage(png(640, 480))).toEqual({
      mimeType: 'image/png',
      width: 640,
      height: 480,
    });
    expect(inspectProfileImage(jpeg(800, 600))).toEqual({
      mimeType: 'image/jpeg',
      width: 800,
      height: 600,
    });

    const vp8x = webp('VP8X', [0, 0, 0, 0, 0xff, 0x01, 0, 0x7f, 0x02, 0]);
    expect(inspectProfileImage(vp8x)).toEqual({
      mimeType: 'image/webp',
      width: 512,
      height: 640,
    });

    const vp8 = webp(
      'VP8 ',
      [0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0x58, 0x02],
    );
    expect(inspectProfileImage(vp8)).toEqual({
      mimeType: 'image/webp',
      width: 800,
      height: 600,
    });

    const width = 321;
    const height = 123;
    const bits = (width - 1) | ((height - 1) << 14);
    const vp8lPayload = [
      0x2f,
      bits & 0xff,
      (bits >> 8) & 0xff,
      (bits >> 16) & 0xff,
      0,
      0,
      0,
      0,
      0,
      0,
    ];
    expect(inspectProfileImage(webp('VP8L', vp8lPayload))).toEqual({
      mimeType: 'image/webp',
      width,
      height,
    });
  });

  it('rejeita assinaturas, segmentos e chunks truncados ou inconsistentes', () => {
    expect(inspectProfileImage(new Uint8Array())).toBeNull();
    expect(
      inspectProfileImage(
        png(1, 1).map((value, index) => (index === 12 ? 0 : value)),
      ),
    ).toBeNull();
    expect(
      inspectProfileImage(
        new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBeNull();
    expect(
      inspectProfileImage(
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 0, 0, 0, 0]),
      ),
    ).toBeNull();

    const invalidWebp = webp('VP8X', [0, 0, 0]);
    expect(inspectProfileImage(invalidWebp)).toBeNull();
    const truncated = webp('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    new DataView(truncated.buffer).setUint32(16, 100, true);
    expect(inspectProfileImage(truncated)).toBeNull();
  });
});
