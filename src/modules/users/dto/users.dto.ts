import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { DEPARTMENTS } from '../../../domain/access/access.constants';
import { onlyDigits } from '../../../shared/utils/normalization';

export class CreateUserDto {
  @ApiProperty({ example: 'Carlos Oliveira' })
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'carlos.oliveira' })
  @Matches(/^[a-zA-Z0-9._-]{3,40}$/)
  username!: string;

  @ApiProperty({ example: 'carlos@empresa.com.br' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({ example: '52998224725' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? onlyDigits(value) : value,
  )
  @Matches(/^\d{11}$/)
  cpf?: string;

  @ApiProperty({ example: 'SenhaForte@2026', minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/)
  password!: string;

  @ApiProperty({ enum: DEPARTMENTS, isArray: true, default: [] })
  @IsArray()
  @ArrayUnique()
  @IsIn(DEPARTMENTS, { each: true })
  departments!: (typeof DEPARTMENTS)[number][];

  @ApiProperty({ type: String, format: 'uuid', isArray: true, default: [] })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  roleIds!: string[];
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

  @ApiPropertyOptional({ example: '52998224725', nullable: true })
  @ValidateIf(
    (_object, value: unknown) => value !== null && value !== undefined,
  )
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? onlyDigits(value) : value,
  )
  @Matches(/^\d{11}$/)
  cpf?: string | null;

  @ApiPropertyOptional({ enum: DEPARTMENTS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(DEPARTMENTS, { each: true })
  departments?: (typeof DEPARTMENTS)[number][];

  @ApiPropertyOptional({ type: String, format: 'uuid', isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  roleIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
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

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isActive?: boolean;
}
