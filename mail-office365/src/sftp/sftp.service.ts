import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import SftpClient from 'ssh2-sftp-client';

export interface RemoteFile {
  name: string;
  size: number;
}

/** Sesión SFTP abierta; se obtiene con SftpService.open() y se cierra con close(). */
export class SftpSession {
  constructor(
    private readonly client: SftpClient,
    private readonly dir: string,
    private readonly processedDir: string,
  ) {}


  async listFiles(): Promise<RemoteFile[]> {
    const entries = await this.client.list(this.dir);
    return entries
      .filter((e) => e.type === '-')
      .map((e) => ({ name: e.name, size: e.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async download(name: string): Promise<Buffer> {
    return (await this.client.get(`${this.dir}/${name}`)) as Buffer;
  }

  /**
   * Mueve el archivo a <procesados>/<AAAA-MM-DD>/<nombre>_<AAAAMMDD-HHmmss>_<hash8>.pdf
   * (fecha en la zona TZ). La fecha y el hash hacen único cada destino, así dos envíos
   * del mismo empleado con el mismo nombre de archivo nunca se sobrescriben.
   * Devuelve la ruta final en el SFTP.
   */
  async archive(name: string, sha256: string): Promise<string> {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const folder = `${this.processedDir}/${day}`;
    if (!(await this.client.exists(folder))) await this.client.mkdir(folder, true);

    const base = name.replace(/\.pdf$/i, '');
    let target = `${folder}/${base}_${day.replace(/-/g, '')}-${time}_${sha256.slice(0, 8)}.pdf`;
    for (let i = 2; await this.client.exists(target); i++) {
      target = `${folder}/${base}_${day.replace(/-/g, '')}-${time}_${sha256.slice(0, 8)}_${i}.pdf`;
    }
    await this.client.rename(`${this.dir}/${name}`, target);
    return target;
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => undefined);
  }
}

@Injectable()
export class SftpService {
  constructor(private readonly config: ConfigService) {}

  async open(): Promise<SftpSession> {
    const client = new SftpClient();
    const expectedHash = this.config.get<string>('SFTP_HOST_SHA256');

    const privateKeyPath = this.config.get<string>('SFTP_PRIVATE_KEY_PATH');
    await client.connect({
      host: this.config.getOrThrow('SFTP_HOST'),
      port: Number(this.config.get('SFTP_PORT', 22)),
      username: this.config.getOrThrow('SFTP_USER'),
      password: this.config.get('SFTP_PASSWORD'),
      privateKey: privateKeyPath ? readFileSync(privateKeyPath) : undefined,
      passphrase: this.config.get('SFTP_PASSPHRASE'),
      readyTimeout: Number(this.config.get('SFTP_READY_TIMEOUT_MS', 20000)),
      // Si se configura la huella del servidor, se rechaza cualquier otra
      hostHash: expectedHash ? 'sha256' : undefined,
      hostVerifier: expectedHash
        ? (hash: string) => hash.toLowerCase() === expectedHash.toLowerCase()
        : undefined,
    });

    const dir = this.config.getOrThrow<string>('SFTP_DIR').replace(/\/+$/, '');
    const processedDir = (this.config.get<string>('SFTP_PROCESSED_DIR') || `${dir}/procesados`).replace(/\/+$/, '');
    return new SftpSession(client, dir, processedDir);
  }
}
