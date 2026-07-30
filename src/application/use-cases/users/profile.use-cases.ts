import { notFound, validationError } from '../../../core/errors/app-error';
import {
  inspectProfileImage,
  MAX_PROFILE_PICTURE_BYTES,
  MAX_PROFILE_PICTURE_DIMENSION,
  MIN_PROFILE_PICTURE_DIMENSION,
} from '../../../domain/profile/profile-image';
import {
  TenantAuditLogsRepository,
  type UserProfileRecord,
  UsersRepository,
} from '../../contracts/repositories';

const ALLOWED_PROFILE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function profileOutput(record: UserProfileRecord | null) {
  if (!record) throw notFound('Usuário');
  const picture = record.profilePicture;

  return {
    id: record.id,
    name: record.name,
    username: record.username,
    email: record.email,
    profilePictureDataUrl:
      picture && record.profilePictureMime
        ? `data:${record.profilePictureMime};base64,${Buffer.from(picture).toString('base64')}`
        : null,
  };
}

export class GetProfileUseCase {
  constructor(private readonly users: UsersRepository) {}

  async execute(companyId: string, userId: string) {
    return profileOutput(await this.users.findProfileById(companyId, userId));
  }
}

export class UpdateProfilePictureUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly auditLogs?: TenantAuditLogsRepository,
  ) {}

  async execute(input: {
    companyId: string;
    userId: string;
    dataUrl: string | null;
  }) {
    let picture: Uint8Array<ArrayBuffer> | null = null;
    let mimeType: string | null = null;

    if (input.dataUrl) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        input.dataUrl,
      );
      if (!match || !ALLOWED_PROFILE_MIME_TYPES.has(match[1])) {
        throw validationError('Envie uma imagem JPEG, PNG ou WebP válida.');
      }
      picture = new Uint8Array(Buffer.from(match[2], 'base64'));
      if (
        picture.byteLength === 0 ||
        picture.byteLength > MAX_PROFILE_PICTURE_BYTES
      ) {
        throw validationError(
          'A foto de perfil deve possuir no máximo 512 KB.',
        );
      }
      const metadata = inspectProfileImage(picture);
      if (!metadata || metadata.mimeType !== match[1]) {
        throw validationError(
          'O conteúdo da imagem não corresponde a um JPEG, PNG ou WebP válido.',
        );
      }
      if (
        metadata.width < MIN_PROFILE_PICTURE_DIMENSION ||
        metadata.height < MIN_PROFILE_PICTURE_DIMENSION ||
        metadata.width > MAX_PROFILE_PICTURE_DIMENSION ||
        metadata.height > MAX_PROFILE_PICTURE_DIMENSION
      ) {
        throw validationError(
          'A foto de perfil deve possuir largura e altura entre 128 e 2048 pixels.',
        );
      }
      mimeType = metadata.mimeType;
    }

    const updated = await this.users.updateProfilePicture(
      input.companyId,
      input.userId,
      picture,
      mimeType,
    );
    await this.auditLogs?.create({
      companyId: input.companyId,
      actorUserId: input.userId,
      action: picture ? 'PROFILE_PICTURE_UPDATED' : 'PROFILE_PICTURE_REMOVED',
      targetType: 'user',
      targetId: input.userId,
      metadata: picture ? { mimeType, bytes: picture.byteLength } : {},
    });
    return profileOutput(updated);
  }
}
