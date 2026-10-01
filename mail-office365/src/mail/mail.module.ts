import { Module } from '@nestjs/common';
import { GraphVerifierService } from './graph-verifier.service';
import { MailService } from './mail.service';
import { ReceiptEmailTemplate } from './receipt-email.template';

@Module({
  providers: [MailService, GraphVerifierService, ReceiptEmailTemplate],
  exports: [MailService, GraphVerifierService, ReceiptEmailTemplate],
})
export class MailModule {}
