import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

// Acepta "a@x.com" o "a@x.com,b@x.com" (multipart/form-data solo envía texto)
const toList = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value.split(',').map((v) => v.trim()).filter(Boolean)
    : value;

export class SendMailDto {
  @Transform(toList)
  @IsArray()
  @ArrayNotEmpty()
  @IsEmail({}, { each: true })
  to: string[];

  @IsString()
  @IsNotEmpty()
  subject: string;

  @IsString()
  @IsNotEmpty()
  body: string;

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsEmail({}, { each: true })
  cc?: string[];
}
