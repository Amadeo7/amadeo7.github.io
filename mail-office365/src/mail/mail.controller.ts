import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { SendMailDto } from './dto/send-mail.dto';
import { MailService } from './mail.service';

const maxBytes = Number(process.env.MAX_PDF_MB ?? 10) * 1024 * 1024;

@Controller('mail')
export class MailController {
  constructor(private readonly mail: MailService) {}

  // POST /mail/send  (multipart/form-data: to, subject, body, cc?, file=<pdf>)
  @Post('send')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: maxBytes },
      fileFilter: (_req, file, cb) =>
        file.mimetype === 'application/pdf'
          ? cb(null, true)
          : cb(new BadRequestException('Solo se permiten archivos PDF'), false),
    }),
  )
  async send(@Body() dto: SendMailDto, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Adjunta un PDF en el campo "file"');
    // Verifica la firma real del PDF, no solo el mimetype declarado por el cliente
    if (file.buffer.subarray(0, 5).toString() !== '%PDF-') {
      throw new BadRequestException('El archivo no es un PDF válido');
    }
    return this.mail.sendWithPdf(dto, file);
  }
}
