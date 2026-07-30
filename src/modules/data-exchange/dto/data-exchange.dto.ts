import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import {
  DATA_EXCHANGE_FORMATS,
  type DataExchangeFormat,
} from '../../../domain/data-exchange/data-exchange-capabilities';

export class UploadDataExchangeArtifactDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  commandId!: string;

  @ApiPropertyOptional({
    maxLength: 120,
    description:
      'Finalidade funcional informativa, por exemplo importação de clientes.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  purpose?: string;
}

export class ConvertDataExchangeArtifactDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  commandId!: string;

  @ApiProperty({ enum: DATA_EXCHANGE_FORMATS })
  @IsIn(DATA_EXCHANGE_FORMATS)
  targetFormat!: DataExchangeFormat;

  @ApiPropertyOptional({
    maxLength: 120,
    description:
      'Aba a exportar quando um XLSX com múltiplas abas for convertido para CSV ou TSV.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  sheetName?: string;
}
