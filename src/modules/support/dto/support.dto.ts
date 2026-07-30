import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSupportRequestDto {
  @ApiProperty({ minLength: 5, maxLength: 120 })
  @IsString()
  @MinLength(5)
  @MaxLength(120)
  subject!: string;

  @ApiProperty({ minLength: 20, maxLength: 4000 })
  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  message!: string;
}
