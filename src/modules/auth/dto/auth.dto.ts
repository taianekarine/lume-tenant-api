import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'Usuário ou e-mail.', example: 'ana.souza' })
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

export class ForgotPasswordDto {
  @ApiProperty({
    description: 'Usuário ou e-mail. A resposta nunca confirma a conta.',
    example: 'ana.souza',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  identifier!: string;
}

export class CompletePasswordChangeDto {
  @ApiProperty({ description: 'Token opaco de uso único.' })
  @IsString()
  @MinLength(40)
  token!: string;

  @ApiProperty({ example: 'NovaSenhaForte@2026', minLength: 12 })
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/)
  newPassword!: string;
}
