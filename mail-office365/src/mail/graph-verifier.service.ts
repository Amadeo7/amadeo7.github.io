import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Verifica que un correo exista en la carpeta "Elementos enviados" del buzón
 * remitente, consultando Microsoft Graph por su Message-ID.
 * Requiere un registro de aplicación en Entra ID con el permiso de aplicación Mail.Read.
 * Confirma que Exchange aceptó y envió el mensaje; no confirma lectura ni entrega en el buzón destino.
 */
@Injectable()
export class GraphVerifierService {
  private readonly logger = new Logger(GraphVerifierService.name);
  private token?: { value: string; expiresAt: number };

  private readonly authUrl: string;
  private readonly baseUrl: string;
  private readonly scope: string;
  private readonly sentFolder: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.authUrl = config.get('AZURE_AUTH_URL', 'https://login.microsoftonline.com');
    this.baseUrl = config.get('GRAPH_BASE_URL', 'https://graph.microsoft.com/v1.0');
    this.scope = config.get('GRAPH_SCOPE', 'https://graph.microsoft.com/.default');
    this.sentFolder = config.get('GRAPH_SENT_FOLDER', 'sentitems');
    this.timeoutMs = Number(config.get('GRAPH_TIMEOUT_MS', 20000));
  }

  get enabled(): boolean {
    return ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'].every((k) => !!this.config.get(k));
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const tenant = this.config.getOrThrow<string>('AZURE_TENANT_ID');
    const res = await fetch(`${this.authUrl}/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.getOrThrow('AZURE_CLIENT_ID'),
        client_secret: this.config.getOrThrow('AZURE_CLIENT_SECRET'),
        scope: this.scope,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Entra ID respondió ${res.status} al pedir el token`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  async isInSentItems(messageId: string): Promise<boolean> {
    const mailbox = this.config.get<string>('GRAPH_MAILBOX') ?? this.config.getOrThrow<string>('SMTP_USER');
    const filter = `internetMessageId eq '${messageId.replace(/'/g, "''")}'`;
    const url =
      `${this.baseUrl}/users/${encodeURIComponent(mailbox)}/mailFolders/${encodeURIComponent(this.sentFolder)}/messages` +
      `?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.getToken()}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Graph respondió ${res.status}`);
    const json = (await res.json()) as { value: unknown[] };
    return json.value.length > 0;
  }
}
