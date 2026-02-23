import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

import { EMAIL_CHANNEL, GMAIL_CREDENTIALS_DIR } from './config.js';
import { isEmailProcessed, markEmailProcessed, markEmailResponded } from './db.js';
import { logger } from './logger.js';

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  body: string;
  date: string;
}

function getGmailClient() {
  const keysPath = path.join(GMAIL_CREDENTIALS_DIR, 'gcp-oauth.keys.json');
  const tokenPath = path.join(GMAIL_CREDENTIALS_DIR, 'credentials.json');

  if (!fs.existsSync(keysPath) || !fs.existsSync(tokenPath)) {
    throw new Error('Gmail credentials not found. Run /add-gmail to set up.');
  }

  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));

  const clientId = keys.installed?.client_id || keys.web?.client_id;
  const clientSecret = keys.installed?.client_secret || keys.web?.client_secret;

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials(token);

  oauth2.on('tokens', (newTokens) => {
    const current = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    const updated = { ...current, ...newTokens };
    fs.writeFileSync(tokenPath, JSON.stringify(updated, null, 2));
    logger.debug('Gmail token refreshed');
  });

  return google.gmail({ version: 'v1', auth: oauth2 });
}

export function buildQuery(): string {
  switch (EMAIL_CHANNEL.triggerMode) {
    case 'label':
      return `label:${EMAIL_CHANNEL.triggerValue} is:unread`;
    case 'address':
      return `to:${EMAIL_CHANNEL.triggerValue} is:unread`;
    case 'subject':
      return `subject:${EMAIL_CHANNEL.triggerValue} is:unread`;
  }
}

export function extractBody(payload: any): string {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
        return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      }
    }
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }
  return '';
}

export async function checkForNewEmails(): Promise<EmailMessage[]> {
  const gmail = getGmailClient();
  const query = buildQuery();

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 10,
  });

  const messageIds = res.data.messages || [];
  const emails: EmailMessage[] = [];

  for (const { id, threadId } of messageIds) {
    if (!id || !threadId) continue;
    if (isEmailProcessed(id)) continue;

    const msg = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });

    const headers = msg.data.payload?.headers || [];
    const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || 'unknown';
    const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '(no subject)';
    const date = headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || '';

    const body = extractBody(msg.data.payload);
    emails.push({ id, threadId, from, subject, body, date });
  }

  return emails;
}

export async function sendEmailReply(
  threadId: string,
  to: string,
  subject: string,
  body: string,
  inReplyToMessageId: string,
): Promise<void> {
  const gmail = getGmailClient();

  const original = await gmail.users.messages.get({
    userId: 'me',
    id: inReplyToMessageId,
    format: 'metadata',
    metadataHeaders: ['Message-ID'],
  });
  const messageIdHeader = original.data.payload?.headers?.find(
    (h: any) => h.name?.toLowerCase() === 'message-id',
  )?.value;

  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  const headers = [
    `To: ${to}`,
    `Subject: ${replySubject}`,
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (messageIdHeader) {
    headers.push(`In-Reply-To: ${messageIdHeader}`);
    headers.push(`References: ${messageIdHeader}`);
  }

  const email = `${headers.join('\r\n')}\r\n\r\n${body}`;
  const encodedEmail = Buffer.from(email)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedEmail,
      threadId,
    },
  });
}

export async function markAsRead(messageId: string): Promise<void> {
  const gmail = getGmailClient();
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['UNREAD'],
    },
  });
}

export function getContextKey(email: EmailMessage): string {
  switch (EMAIL_CHANNEL.contextMode) {
    case 'thread':
      return `email-${email.threadId}`;
    case 'sender':
      return `email-${email.from.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    case 'single':
      return 'email-main';
  }
}
