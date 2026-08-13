import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  IsUUID,
  ValidateNested,
} from 'class-validator';

import {
  ASSIGNABLE_DEPARTMENTS,
  ALL_PERMISSION_CODES,
  type AssignableDepartment,
  type PermissionCode,
} from '../../../domain/access/access.constants';
import { USERNAME_PATTERN } from '../../../domain/entities/user';

export class UserDependentDto {
  @ApiProperty({ example: 'Maria Oliveira' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ format: 'date', example: '2018-04-20' })
  @IsDateString()
  birthDate!: string;

  @ApiPropertyOptional({ example: 'filho(a)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  relationship?: string;
}

const maritalStatuses = [
  'single',
  'married',
  'stable-union',
  'divorced',
  'widowed',
  'not-informed',
] as const;
const militaryDocumentStatuses = [
  'applicable',
  'not-applicable',
  'pending-confirmation',
] as const;
const userClassifications = ['Administrativo', 'Geral', 'Motorista'] as const;

export class CreateUserDto {
  @ApiProperty({ example: 'Carlos Oliveira' })
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'carlos.oliveira' })
  @Matches(USERNAME_PATTERN, {
    message:
      'O usuário deve possuir entre 3 e 40 caracteres permitidos e ao menos uma letra.',
  })
  username!: string;

  @ApiProperty({ example: 'carlos@empresa.com.br' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'SenhaForte@2026', minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/)
  password!: string;

  @ApiProperty({ enum: ASSIGNABLE_DEPARTMENTS, isArray: true, default: [] })
  @IsArray()
  @ArrayUnique()
  @IsIn(ASSIGNABLE_DEPARTMENTS, { each: true })
  departments!: AssignableDepartment[];

  @ApiProperty({ enum: ALL_PERMISSION_CODES, isArray: true, default: [] })
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSION_CODES, { each: true })
  permissionCodes!: PermissionCode[];

  @ApiPropertyOptional({
    default: false,
    description:
      'Administrador global com todos os departamentos e permissões atuais e futuras.',
  })
  @IsOptional()
  @IsBoolean()
  isAdministrator = false;

  @ApiPropertyOptional({
    enum: ['standard', 'document-portal'],
    default: 'standard',
  })
  @IsOptional()
  @IsIn(['standard', 'document-portal'])
  documentAccessMode: 'standard' | 'document-portal' = 'standard';

  @ApiPropertyOptional({
    default: false,
    description:
      'Cria a solicitação documental inicial. Obrigatório para candidatos.',
  })
  @IsOptional()
  @IsBoolean()
  requestDocuments?: boolean;

  @ApiProperty({
    enum: userClassifications,
    default: 'Geral',
    description: 'Classificação usada para calcular as exigências documentais.',
  })
  @IsIn(userClassifications)
  jobTitle: (typeof userClassifications)[number] = 'Geral';

  @ApiPropertyOptional({ enum: maritalStatuses, default: 'not-informed' })
  @IsOptional()
  @IsIn(maritalStatuses)
  maritalStatus?: (typeof maritalStatuses)[number];

  @ApiPropertyOptional({
    enum: militaryDocumentStatuses,
    default: 'pending-confirmation',
  })
  @IsOptional()
  @IsIn(militaryDocumentStatuses)
  militaryDocumentStatus?: (typeof militaryDocumentStatuses)[number];

  @ApiPropertyOptional({ type: [UserDependentDto], default: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => UserDependentDto)
  dependents?: UserDependentDto[];

  @ApiPropertyOptional({
    enum: ['admission-general', 'admission-administrative', 'admission-driver'],
    description: 'Lista documental criada automaticamente para o novo usuário.',
  })
  @IsOptional()
  @IsIn(['admission-general', 'admission-administrative', 'admission-driver'])
  initialDocumentChecklistCode?:
    'admission-general' | 'admission-administrative' | 'admission-driver';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  initialDocumentRequestCommandId?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Carlos Oliveira' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'carlos@empresa.com.br' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ enum: ASSIGNABLE_DEPARTMENTS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ASSIGNABLE_DEPARTMENTS, { each: true })
  departments?: AssignableDepartment[];

  @ApiPropertyOptional({ enum: ALL_PERMISSION_CODES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSION_CODES, { each: true })
  permissionCodes?: PermissionCode[];

  @ApiPropertyOptional({
    description:
      'Promoção ou rebaixamento permitido somente a outro administrador.',
  })
  @IsOptional()
  @IsBoolean()
  isAdministrator?: boolean;

  @ApiPropertyOptional({ enum: ['standard', 'document-portal'] })
  @IsOptional()
  @IsIn(['standard', 'document-portal'])
  documentAccessMode?: 'standard' | 'document-portal';

  @ApiPropertyOptional({ enum: userClassifications })
  @IsOptional()
  @IsIn(userClassifications)
  jobTitle?: (typeof userClassifications)[number];

  @ApiPropertyOptional({ enum: maritalStatuses, nullable: true })
  @IsOptional()
  @IsIn(maritalStatuses)
  maritalStatus?: (typeof maritalStatuses)[number] | null;

  @ApiPropertyOptional({ enum: militaryDocumentStatuses })
  @IsOptional()
  @IsIn(militaryDocumentStatuses)
  militaryDocumentStatus?: (typeof militaryDocumentStatuses)[number];

  @ApiPropertyOptional({ type: [UserDependentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => UserDependentDto)
  dependents?: UserDependentDto[];
}

export class DeleteUserDto {
  @ApiProperty({
    description: 'Senha atual do administrador que confirma a exclusão.',
    writeOnly: true,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;
}

export class ListUsersQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: ASSIGNABLE_DEPARTMENTS })
  @IsOptional()
  @IsIn(ASSIGNABLE_DEPARTMENTS)
  department?: AssignableDepartment;

  @ApiPropertyOptional({ enum: ALL_PERMISSION_CODES })
  @IsOptional()
  @IsIn(ALL_PERMISSION_CODES)
  permission?: PermissionCode;

  @ApiPropertyOptional({ enum: ['active', 'inactive', 'suspended'] })
  @IsOptional()
  @IsIn(['active', 'inactive', 'suspended'])
  status?: 'active' | 'inactive' | 'suspended';
}

export class UpdateUserStatusDto {
  @ApiProperty({ enum: ['active', 'inactive', 'suspended'] })
  @IsIn(['active', 'inactive', 'suspended'])
  status!: 'active' | 'inactive' | 'suspended';

  @ApiPropertyOptional({
    description: 'Data ISO futura obrigatória para status suspended.',
  })
  @IsOptional()
  @IsDateString()
  suspendedUntil?: string;

  @ApiPropertyOptional({
    description:
      'Alternativa a suspendedUntil: quantidade de dias de suspensão.',
    minimum: 1,
    maximum: 3650,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  suspensionDays?: number;

  @ApiPropertyOptional({
    description: 'Motivo obrigatório para status suspended.',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  suspensionReason?: string;
}

export class ChangeOwnPasswordDto {
  @ApiProperty({ description: 'Senha atual da conta.' })
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  currentPassword!: string;

  @ApiProperty({ example: 'NovaSenhaForte@2026', minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/)
  newPassword!: string;
}

export class UpdateProfilePictureDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Data URL JPEG, PNG ou WebP de até 512 KB e dimensões entre 128 e 2048 px; null remove a foto.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(700_000)
  dataUrl!: string | null;
}
