export const MAX_PROFILE_PICTURE_BYTES = 512 * 1024;
export const MIN_PROFILE_PICTURE_DIMENSION = 128;
export const MAX_PROFILE_PICTURE_DIMENSION = 2048;

export type ProfilePictureMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ProfileImageMetadata {
  mimeType: ProfilePictureMimeType;
  width: number;
  height: number;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function inspectPng(bytes: Uint8Array): ProfileImageMetadata | null {
  if (
    bytes.length < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    ) ||
    bytes[8] !== 0 ||
    bytes[9] !== 0 ||
    bytes[10] !== 0 ||
    bytes[11] !== 13 ||
    ascii(bytes, 12, 4) !== 'IHDR'
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    mimeType: 'image/png',
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
}

function inspectJpeg(bytes: Uint8Array): ProfileImageMetadata | null {
  if (bytes.length < 10 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return null;
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker) && segmentLength >= 7) {
      return {
        mimeType: 'image/jpeg',
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function inspectWebp(bytes: Uint8Array): ProfileImageMetadata | null {
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 4) !== 'WEBP'
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (dataOffset + chunkLength > bytes.length) return null;

    if (chunkType === 'VP8X' && chunkLength >= 10) {
      return {
        mimeType: 'image/webp',
        width:
          1 +
          bytes[dataOffset + 4] +
          (bytes[dataOffset + 5] << 8) +
          (bytes[dataOffset + 6] << 16),
        height:
          1 +
          bytes[dataOffset + 7] +
          (bytes[dataOffset + 8] << 8) +
          (bytes[dataOffset + 9] << 16),
      };
    }
    if (
      chunkType === 'VP8 ' &&
      chunkLength >= 10 &&
      bytes[dataOffset + 3] === 0x9d &&
      bytes[dataOffset + 4] === 0x01 &&
      bytes[dataOffset + 5] === 0x2a
    ) {
      return {
        mimeType: 'image/webp',
        width: view.getUint16(dataOffset + 6, true) & 0x3fff,
        height: view.getUint16(dataOffset + 8, true) & 0x3fff,
      };
    }
    if (
      chunkType === 'VP8L' &&
      chunkLength >= 5 &&
      bytes[dataOffset] === 0x2f
    ) {
      const bits = view.getUint32(dataOffset + 1, true);
      return {
        mimeType: 'image/webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }

    offset = dataOffset + chunkLength + (chunkLength % 2);
  }
  return null;
}

export function inspectProfileImage(
  bytes: Uint8Array,
): ProfileImageMetadata | null {
  return inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
}
