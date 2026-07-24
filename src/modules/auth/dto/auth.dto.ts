import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'Usuário, e-mail ou CPF.', example: 'ana.souza' })
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  identifier!: string;

  @ApiProperty({ example: 'SenhaForte@2026' })
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;

  @ApiProperty({ default: false })
  @Transform(({ value }: { value: unknown }) => value ?? false)
  @IsBoolean()
  remember = false;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token opaco devolvido no login.' })
  @IsString()
  @MinLength(40)
  refreshToken!: string;
}
