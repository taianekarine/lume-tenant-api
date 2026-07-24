import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ example: 'operations-supervisor' })
  @Matches(/^[a-z0-9][a-z0-9-]{2,59}$/)
  code!: string;

  @ApiProperty({ example: 'Supervisor de Operações' })
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiProperty({
    example: ['dashboard:view', 'operations:manage'],
    isArray: true,
  })
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions!: string[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional({ example: 'operations-supervisor' })
  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9-]{2,59}$/)
  code?: string;

  @ApiPropertyOptional({ example: 'Supervisor de Operações' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string | null;

  @ApiPropertyOptional({ example: ['dashboard:view'], isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions?: string[];
}
