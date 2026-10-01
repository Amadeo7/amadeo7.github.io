import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = Buffer.from(config.getOrThrow<string>('API_KEY'));
  }

  canActivate(context: ExecutionContext): boolean {
    const provided = Buffer.from(String(context.switchToHttp().getRequest().headers['x-api-key'] ?? ''));
    if (provided.length !== this.key.length || !timingSafeEqual(provided, this.key)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
