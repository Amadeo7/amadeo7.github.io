import { ReceiptRow } from './receipts.repository';
import { RunCounters } from './receipts.types';

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ReportInput {
  runId: string;
  title: string;
  company?: string;
  startedAt: Date;
  finishedAt?: Date | null;
  timeZone?: string;
  counters: Partial<RunCounters>;
  rows: ReceiptRow[];
  includeEmail: boolean;
}

const fmt = (d: Date | null | undefined, tz?: string) =>
  d ? new Date(d).toLocaleString('es-MX', { timeZone: tz || undefined, dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** Reporte de una ejecución, con los nombres de los empleados. */
export function buildRunReport(i: ReportInput) {
  const sent = i.rows.filter((r) => r.status === 'sent');
  const failed = i.rows.filter((r) => r.status === 'failed');
  // "sending" o "pending" al terminar la ejecución significa que no se sabe qué pasó
  const review = i.rows.filter((r) => ['uncertain', 'sending', 'pending'].includes(r.status));
  const c = i.counters;
  const problems = failed.length + review.length + (c.unrecorded?.length ?? 0);
  const verified = sent.filter((r) => r.verified).length;

  const subject = `${i.title} ${fmt(i.startedAt, i.timeZone)}: ${sent.length} enviados${problems ? `, ${problems} con problemas` : ''}`;

  // ---- HTML
  const th = 'text-align:left;padding:6px 10px;border-bottom:2px solid #d9dfea;font-size:12px;color:#556073';
  const td = 'padding:6px 10px;border-bottom:1px solid #e8ecf3;font-size:13px;vertical-align:top';
  const table = (heads: string[], body: string) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:8px 0 20px"><tr>${heads
      .map((h) => `<th style="${th}">${h}</th>`)
      .join('')}</tr>${body}</table>`;
  const tr = (cells: unknown[]) => `<tr>${cells.map((x) => `<td style="${td}">${esc(x)}</td>`).join('')}</tr>`;
  const h3 = (t: string, n: number, color = '#18202f') => `<h3 style="margin:18px 0 0;font-size:15px;color:${color}">${esc(t)} (${n})</h3>`;

  let html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#18202f;max-width:760px">
  <h2 style="margin:0 0 4px;font-size:20px">${esc(i.title)}</h2>
  <p style="margin:0 0 14px;color:#556073;font-size:13px">${i.company ? esc(i.company) + ' · ' : ''}Inicio: ${esc(fmt(i.startedAt, i.timeZone))} · Fin: ${esc(fmt(i.finishedAt, i.timeZone))}<br>Ejecución: ${esc(i.runId)}</p>`;
  if (c.fatalError) {
    html += `<p style="background:#fde8e8;border:1px solid #a3262a;border-radius:6px;padding:8px 12px;font-size:13px"><b>La ejecución se detuvo:</b> ${esc(c.fatalError)}</p>`;
  }
  html += `<p style="font-size:14px;margin:0 0 6px"><b>${sent.length}</b> enviados (${verified} verificados en Elementos enviados) · <b>${failed.length + (c.unrecorded?.length ?? 0)}</b> no enviados · <b>${review.length}</b> por revisar · ${c.skippedAlreadySent ?? 0} omitidos por haberse enviado antes · archivos ignorados: ${(c.ignoredNames ?? []).length}.</p>`;

  const emailCol = i.includeEmail;
  html += h3('Enviados', sent.length, '#12703c');
  html += sent.length
    ? table(['Empleado', 'Código', ...(emailCol ? ['Correo'] : []), 'Archivo', 'Verificado'], sent.map((r) => tr([r.employee_name || '—', r.employee_code, ...(emailCol ? [r.to_email] : []), r.file_name, r.verified ? 'Sí' : 'No'])).join(''))
    : '<p style="font-size:13px;color:#556073;margin:6px 0 16px">Ninguno.</p>';

  if (failed.length || c.unrecorded?.length) {
    html += h3('No enviados', failed.length + (c.unrecorded?.length ?? 0), '#a3262a');
    html += table(
      ['Empleado', 'Código', 'Archivo', 'Motivo'],
      failed.map((r) => tr([r.employee_name || '—', r.employee_code, r.file_name, r.error])).join('') +
        (c.unrecorded ?? []).map((u) => tr(['—', '—', u.file, u.error])).join(''),
    );
  }
  if (review.length) {
    html += h3('Por revisar: no se sabe si salieron', review.length, '#8a4b00');
    html += `<p style="font-size:13px;margin:4px 0 0">Revisa la carpeta Elementos enviados antes de reenviar, para no duplicar un recibo. Se resuelven con <code>POST /receipts/&lt;id&gt;/resolve</code> (<code>resend</code> o <code>mark_sent</code>).</p>`;
    html += table(['Id', 'Empleado', 'Código', ...(emailCol ? ['Correo'] : []), 'Archivo'], review.map((r) => tr([r.id, r.employee_name || '—', r.employee_code, ...(emailCol ? [r.to_email] : []), r.file_name])).join(''));
  }
  if (c.ignoredNames?.length) {
    html += `<p style="font-size:12px;color:#556073">Archivos ignorados por no cumplir el formato de nombre: ${c.ignoredNames.map(esc).join(', ')}</p>`;
  }
  html += `<p style="font-size:11px;color:#556073;margin-top:20px">Este reporte contiene datos personales. No lo reenvíes fuera de las personas autorizadas.</p></div>`;

  // ---- texto plano
  const line = (r: ReceiptRow) => `- ${r.employee_name || '(sin nombre)'} [${r.employee_code}]${emailCol && r.to_email ? ` <${r.to_email}>` : ''} — ${r.file_name}`;
  let text = `${i.title}\n${fmt(i.startedAt, i.timeZone)} — ${fmt(i.finishedAt, i.timeZone)}\nEjecución: ${i.runId}\n\n`;
  if (c.fatalError) text += `LA EJECUCIÓN SE DETUVO: ${c.fatalError}\n\n`;
  text += `Enviados: ${sent.length} (verificados: ${verified}) | No enviados: ${failed.length + (c.unrecorded?.length ?? 0)} | Por revisar: ${review.length} | Omitidos: ${c.skippedAlreadySent ?? 0}\n\nENVIADOS\n${sent.map(line).join('\n') || '(ninguno)'}\n`;
  if (failed.length || c.unrecorded?.length) {
    text += `\nNO ENVIADOS\n${failed.map((r) => `${line(r)} — ${r.error}`).join('\n')}${(c.unrecorded ?? []).map((u) => `\n- ${u.file} — ${u.error}`).join('')}\n`;
  }
  if (review.length) text += `\nPOR REVISAR (id)\n${review.map((r) => `${line(r)} (id ${r.id})`).join('\n')}\n`;
  if (c.ignoredNames?.length) text += `\nIgnorados: ${c.ignoredNames.join(', ')}\n`;

  return { subject, html, text };
}
