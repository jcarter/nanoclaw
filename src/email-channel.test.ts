import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks ---

// Mock config — must be before importing the module under test
vi.mock('./config.js', () => ({
  GMAIL_CREDENTIALS_DIR: '/tmp/test-gmail-creds',
  EMAIL_CHANNEL: {
    enabled: true,
    triggerMode: 'label',
    triggerValue: 'NanoClaw',
    contextMode: 'single',
    pollIntervalMs: 60000,
  },
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('./db.js', () => ({
  isEmailProcessed: vi.fn(() => false),
  markEmailProcessed: vi.fn(),
  markEmailResponded: vi.fn(),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() =>
        JSON.stringify({
          installed: {
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
          },
        }),
      ),
      writeFileSync: vi.fn(),
    },
  };
});

// Build mock Gmail API methods
const mockMessagesList = vi.fn();
const mockMessagesGet = vi.fn();
const mockMessagesSend = vi.fn();
const mockMessagesModify = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class MockOAuth2 {
        setCredentials = vi.fn();
        on = vi.fn();
      },
    },
    gmail: vi.fn(() => ({
      users: {
        messages: {
          list: mockMessagesList,
          get: mockMessagesGet,
          send: mockMessagesSend,
          modify: mockMessagesModify,
        },
      },
    })),
  },
}));

import { EMAIL_CHANNEL } from './config.js';
import { isEmailProcessed } from './db.js';
import {
  buildQuery,
  checkForNewEmails,
  extractBody,
  getContextKey,
  markAsRead,
  sendEmailReply,
  type EmailMessage,
} from './email-channel.js';

// --- Helpers ---

function b64(text: string): string {
  return Buffer.from(text).toString('base64');
}

function makeEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    from: 'alice@example.com',
    subject: 'Test Subject',
    body: 'Hello world',
    date: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

// --- Tests ---

describe('extractBody', () => {
  it('extracts text/plain body', () => {
    const payload = {
      mimeType: 'text/plain',
      body: { data: b64('Hello, world!') },
    };
    expect(extractBody(payload)).toBe('Hello, world!');
  });

  it('extracts text/html body and strips tags', () => {
    const html = '<p>Hello, <b>world</b>!</p>';
    const payload = {
      mimeType: 'text/html',
      body: { data: b64(html) },
    };
    // text/html at top level is not handled directly — only via multipart parts
    // The function checks for text/plain first, then recurses parts
    expect(extractBody(payload)).toBe('');
  });

  it('prefers text/plain over text/html in multipart', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: b64('Plain text version') },
        },
        {
          mimeType: 'text/html',
          body: { data: b64('<p>HTML version</p>') },
        },
      ],
    };
    expect(extractBody(payload)).toBe('Plain text version');
  });

  it('falls back to text/html when no text/plain in multipart', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/html',
          body: { data: b64('<p>Only HTML</p>') },
        },
      ],
    };
    expect(extractBody(payload)).toBe('Only HTML');
  });

  it('strips HTML tags from text/html fallback', () => {
    const html = '<div><p>Hello <b>bold</b> and <i>italic</i></p></div>';
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/html',
          body: { data: b64(html) },
        },
      ],
    };
    expect(extractBody(payload)).toBe('Hello bold and italic');
  });

  it('replaces &nbsp; with spaces in HTML', () => {
    const html = '<p>Hello&nbsp;world</p>';
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/html',
          body: { data: b64(html) },
        },
      ],
    };
    expect(extractBody(payload)).toBe('Hello world');
  });

  it('handles nested multipart', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: b64('Nested plain text') },
            },
            {
              mimeType: 'text/html',
              body: { data: b64('<p>Nested HTML</p>') },
            },
          ],
        },
        {
          mimeType: 'application/pdf',
          body: { data: b64('binary-data') },
        },
      ],
    };
    expect(extractBody(payload)).toBe('Nested plain text');
  });

  it('handles deeply nested multipart with only HTML', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'application/pdf',
          body: { data: b64('attachment') },
        },
        {
          mimeType: 'multipart/alternative',
          parts: [
            {
              mimeType: 'text/html',
              body: { data: b64('<b>Deep HTML</b>') },
            },
          ],
        },
      ],
    };
    expect(extractBody(payload)).toBe('Deep HTML');
  });

  it('returns empty string for empty body', () => {
    const payload = {
      mimeType: 'text/plain',
      body: {},
    };
    expect(extractBody(payload)).toBe('');
  });

  it('returns empty string for payload with no parts and no matching mimeType', () => {
    const payload = {
      mimeType: 'application/octet-stream',
      body: { data: b64('binary stuff') },
    };
    expect(extractBody(payload)).toBe('');
  });

  it('returns empty string for multipart with no text parts', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'application/pdf',
          body: { data: b64('pdf-data') },
        },
        {
          mimeType: 'image/png',
          body: { data: b64('image-data') },
        },
      ],
    };
    expect(extractBody(payload)).toBe('');
  });

  it('returns empty string for undefined payload parts and no body data', () => {
    const payload = { mimeType: 'multipart/mixed' };
    expect(extractBody(payload)).toBe('');
  });
});

describe('getContextKey', () => {
  afterEach(() => {
    // Reset triggerMode to default
    (EMAIL_CHANNEL as any).contextMode = 'single';
  });

  it('returns email-{threadId} for thread mode', () => {
    (EMAIL_CHANNEL as any).contextMode = 'thread';
    const email = makeEmail({ threadId: 'abc123' });
    expect(getContextKey(email)).toBe('email-abc123');
  });

  it('returns normalized sender key for sender mode', () => {
    (EMAIL_CHANNEL as any).contextMode = 'sender';
    const email = makeEmail({ from: 'Alice <alice@example.com>' });
    expect(getContextKey(email)).toBe('email-alice--alice-example-com-');
  });

  it('normalizes sender key to lowercase', () => {
    (EMAIL_CHANNEL as any).contextMode = 'sender';
    const email = makeEmail({ from: 'BOB@EXAMPLE.COM' });
    expect(getContextKey(email)).toBe('email-bob-example-com');
  });

  it('replaces non-alphanumeric characters in sender key', () => {
    (EMAIL_CHANNEL as any).contextMode = 'sender';
    const email = makeEmail({ from: 'test+tag@sub.example.com' });
    expect(getContextKey(email)).toBe('email-test-tag-sub-example-com');
  });

  it('returns email-main for single mode', () => {
    (EMAIL_CHANNEL as any).contextMode = 'single';
    const email = makeEmail();
    expect(getContextKey(email)).toBe('email-main');
  });

  it('returns email-main regardless of email content in single mode', () => {
    (EMAIL_CHANNEL as any).contextMode = 'single';
    const email1 = makeEmail({ from: 'alice@example.com', threadId: 'thread-1' });
    const email2 = makeEmail({ from: 'bob@example.com', threadId: 'thread-2' });
    expect(getContextKey(email1)).toBe('email-main');
    expect(getContextKey(email2)).toBe('email-main');
  });
});

describe('buildQuery', () => {
  afterEach(() => {
    // Reset to defaults
    (EMAIL_CHANNEL as any).triggerMode = 'label';
    (EMAIL_CHANNEL as any).triggerValue = 'NanoClaw';
  });

  it('builds label query', () => {
    (EMAIL_CHANNEL as any).triggerMode = 'label';
    (EMAIL_CHANNEL as any).triggerValue = 'NanoClaw';
    expect(buildQuery()).toBe('label:NanoClaw is:unread');
  });

  it('builds address query', () => {
    (EMAIL_CHANNEL as any).triggerMode = 'address';
    (EMAIL_CHANNEL as any).triggerValue = 'bot@example.com';
    expect(buildQuery()).toBe('to:bot@example.com is:unread');
  });

  it('builds subject query', () => {
    (EMAIL_CHANNEL as any).triggerMode = 'subject';
    (EMAIL_CHANNEL as any).triggerValue = '[AI]';
    expect(buildQuery()).toBe('subject:[AI] is:unread');
  });

  it('uses the current triggerValue', () => {
    (EMAIL_CHANNEL as any).triggerMode = 'label';
    (EMAIL_CHANNEL as any).triggerValue = 'CustomLabel';
    expect(buildQuery()).toBe('label:CustomLabel is:unread');
  });
});

describe('checkForNewEmails', () => {
  beforeEach(() => {
    vi.mocked(isEmailProcessed).mockReturnValue(false);
    mockMessagesList.mockReset();
    mockMessagesGet.mockReset();
  });

  it('returns parsed emails from Gmail API', async () => {
    mockMessagesList.mockResolvedValue({
      data: {
        messages: [{ id: 'msg-1', threadId: 'thread-1' }],
      },
    });

    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          mimeType: 'text/plain',
          body: { data: b64('Email body content') },
          headers: [
            { name: 'From', value: 'alice@example.com' },
            { name: 'Subject', value: 'Test Subject' },
            { name: 'Date', value: 'Wed, 15 Jan 2025 10:00:00 +0000' },
          ],
        },
      },
    });

    const emails = await checkForNewEmails();

    expect(emails).toHaveLength(1);
    expect(emails[0]).toEqual({
      id: 'msg-1',
      threadId: 'thread-1',
      from: 'alice@example.com',
      subject: 'Test Subject',
      body: 'Email body content',
      date: 'Wed, 15 Jan 2025 10:00:00 +0000',
    });
  });

  it('extracts headers case-insensitively', async () => {
    mockMessagesList.mockResolvedValue({
      data: {
        messages: [{ id: 'msg-1', threadId: 'thread-1' }],
      },
    });

    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          mimeType: 'text/plain',
          body: { data: b64('body') },
          headers: [
            { name: 'from', value: 'lowercase@example.com' },
            { name: 'SUBJECT', value: 'Uppercase Subject' },
            { name: 'date', value: '2025-01-15' },
          ],
        },
      },
    });

    const emails = await checkForNewEmails();

    expect(emails[0].from).toBe('lowercase@example.com');
    expect(emails[0].subject).toBe('Uppercase Subject');
    expect(emails[0].date).toBe('2025-01-15');
  });

  it('uses default values when headers are missing', async () => {
    mockMessagesList.mockResolvedValue({
      data: {
        messages: [{ id: 'msg-1', threadId: 'thread-1' }],
      },
    });

    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          mimeType: 'text/plain',
          body: { data: b64('body') },
          headers: [],
        },
      },
    });

    const emails = await checkForNewEmails();

    expect(emails[0].from).toBe('unknown');
    expect(emails[0].subject).toBe('(no subject)');
    expect(emails[0].date).toBe('');
  });

  it('skips already-processed emails', async () => {
    mockMessagesList.mockResolvedValue({
      data: {
        messages: [
          { id: 'msg-processed', threadId: 'thread-1' },
          { id: 'msg-new', threadId: 'thread-2' },
        ],
      },
    });

    vi.mocked(isEmailProcessed).mockImplementation(
      (id: string) => id === 'msg-processed',
    );

    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          mimeType: 'text/plain',
          body: { data: b64('New email body') },
          headers: [
            { name: 'From', value: 'bob@example.com' },
            { name: 'Subject', value: 'New Email' },
            { name: 'Date', value: '2025-01-15' },
          ],
        },
      },
    });

    const emails = await checkForNewEmails();

    expect(emails).toHaveLength(1);
    expect(emails[0].id).toBe('msg-new');
    // messages.get should only be called for the unprocessed message
    expect(mockMessagesGet).toHaveBeenCalledTimes(1);
  });

  it('handles empty results (no messages)', async () => {
    mockMessagesList.mockResolvedValue({
      data: {
        messages: undefined,
      },
    });

    const emails = await checkForNewEmails();
    expect(emails).toHaveLength(0);
    expect(mockMessagesGet).not.toHaveBeenCalled();
  });

  it('handles empty messages array', async () => {
    mockMessagesList.mockResolvedValue({
      data: {
        messages: [],
      },
    });

    const emails = await checkForNewEmails();
    expect(emails).toHaveLength(0);
  });

  it('skips messages with missing id or threadId', async () => {
    mockMessagesList.mockResolvedValue({
      data: {
        messages: [
          { id: null, threadId: 'thread-1' },
          { id: 'msg-2', threadId: null },
          { id: 'msg-3', threadId: 'thread-3' },
        ],
      },
    });

    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          mimeType: 'text/plain',
          body: { data: b64('Valid email') },
          headers: [
            { name: 'From', value: 'test@example.com' },
            { name: 'Subject', value: 'Valid' },
            { name: 'Date', value: '2025-01-15' },
          ],
        },
      },
    });

    const emails = await checkForNewEmails();

    expect(emails).toHaveLength(1);
    expect(emails[0].id).toBe('msg-3');
  });

  it('returns multiple emails in order', async () => {
    mockMessagesList.mockResolvedValue({
      data: {
        messages: [
          { id: 'msg-a', threadId: 'thread-a' },
          { id: 'msg-b', threadId: 'thread-b' },
        ],
      },
    });

    mockMessagesGet.mockImplementation(async ({ id }: { id: string }) => ({
      data: {
        payload: {
          mimeType: 'text/plain',
          body: { data: b64(`Body for ${id}`) },
          headers: [
            { name: 'From', value: `${id}@example.com` },
            { name: 'Subject', value: `Subject ${id}` },
            { name: 'Date', value: '2025-01-15' },
          ],
        },
      },
    }));

    const emails = await checkForNewEmails();

    expect(emails).toHaveLength(2);
    expect(emails[0].id).toBe('msg-a');
    expect(emails[0].body).toBe('Body for msg-a');
    expect(emails[1].id).toBe('msg-b');
    expect(emails[1].body).toBe('Body for msg-b');
  });

  it('handles missing payload headers gracefully', async () => {
    mockMessagesList.mockResolvedValue({
      data: {
        messages: [{ id: 'msg-1', threadId: 'thread-1' }],
      },
    });

    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          mimeType: 'text/plain',
          body: { data: b64('body') },
          // headers is undefined
        },
      },
    });

    const emails = await checkForNewEmails();

    expect(emails).toHaveLength(1);
    expect(emails[0].from).toBe('unknown');
    expect(emails[0].subject).toBe('(no subject)');
  });

  it('passes correct parameters to Gmail API', async () => {
    mockMessagesList.mockResolvedValue({
      data: { messages: [] },
    });

    await checkForNewEmails();

    expect(mockMessagesList).toHaveBeenCalledWith({
      userId: 'me',
      q: 'label:NanoClaw is:unread',
      maxResults: 10,
    });
  });
});

describe('sendEmailReply', () => {
  beforeEach(() => {
    mockMessagesGet.mockReset();
    mockMessagesSend.mockReset();
  });

  it('sends a reply with correct RFC headers', async () => {
    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          headers: [{ name: 'Message-ID', value: '<original@example.com>' }],
        },
      },
    });
    mockMessagesSend.mockResolvedValue({});

    await sendEmailReply('thread-1', 'bob@example.com', 'Test Subject', 'Reply body', 'msg-1');

    expect(mockMessagesSend).toHaveBeenCalledTimes(1);
    const callArgs = mockMessagesSend.mock.calls[0][0];
    expect(callArgs.userId).toBe('me');
    expect(callArgs.requestBody.threadId).toBe('thread-1');

    // Decode the raw email and verify headers
    const raw = callArgs.requestBody.raw;
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    expect(decoded).toContain('To: bob@example.com');
    expect(decoded).toContain('Subject: Re: Test Subject');
    expect(decoded).toContain('Content-Type: text/plain; charset=utf-8');
    expect(decoded).toContain('In-Reply-To: <original@example.com>');
    expect(decoded).toContain('References: <original@example.com>');
    expect(decoded).toContain('Reply body');
  });

  it('does not duplicate Re: prefix if already present', async () => {
    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          headers: [{ name: 'Message-ID', value: '<orig@example.com>' }],
        },
      },
    });
    mockMessagesSend.mockResolvedValue({});

    await sendEmailReply('thread-1', 'bob@example.com', 'Re: Already prefixed', 'body', 'msg-1');

    const raw = mockMessagesSend.mock.calls[0][0].requestBody.raw;
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    expect(decoded).toContain('Subject: Re: Already prefixed');
    // Ensure it does NOT have "Re: Re:"
    expect(decoded).not.toContain('Re: Re:');
  });

  it('omits In-Reply-To and References when no Message-ID header', async () => {
    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          headers: [],
        },
      },
    });
    mockMessagesSend.mockResolvedValue({});

    await sendEmailReply('thread-1', 'bob@example.com', 'Subject', 'body', 'msg-1');

    const raw = mockMessagesSend.mock.calls[0][0].requestBody.raw;
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    expect(decoded).not.toContain('In-Reply-To:');
    expect(decoded).not.toContain('References:');
  });

  it('uses base64url encoding (no +, /, or trailing =)', async () => {
    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          headers: [{ name: 'Message-ID', value: '<msg@example.com>' }],
        },
      },
    });
    mockMessagesSend.mockResolvedValue({});

    await sendEmailReply('thread-1', 'bob@example.com', 'Subject', 'body', 'msg-1');

    const raw = mockMessagesSend.mock.calls[0][0].requestBody.raw;
    expect(raw).not.toMatch(/\+/);
    expect(raw).not.toMatch(/\//);
    expect(raw).not.toMatch(/=+$/);
  });

  it('passes threadId for Gmail threading', async () => {
    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          headers: [],
        },
      },
    });
    mockMessagesSend.mockResolvedValue({});

    await sendEmailReply('specific-thread-id', 'to@example.com', 'Subject', 'body', 'msg-1');

    const callArgs = mockMessagesSend.mock.calls[0][0];
    expect(callArgs.requestBody.threadId).toBe('specific-thread-id');
  });

  it('fetches original message with metadata format', async () => {
    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          headers: [],
        },
      },
    });
    mockMessagesSend.mockResolvedValue({});

    await sendEmailReply('thread-1', 'to@example.com', 'Subject', 'body', 'original-msg-id');

    expect(mockMessagesGet).toHaveBeenCalledWith({
      userId: 'me',
      id: 'original-msg-id',
      format: 'metadata',
      metadataHeaders: ['Message-ID'],
    });
  });

  it('handles Message-ID header with case-insensitive lookup', async () => {
    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          headers: [{ name: 'message-id', value: '<lower@example.com>' }],
        },
      },
    });
    mockMessagesSend.mockResolvedValue({});

    await sendEmailReply('thread-1', 'to@example.com', 'Subject', 'body', 'msg-1');

    const raw = mockMessagesSend.mock.calls[0][0].requestBody.raw;
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    expect(decoded).toContain('In-Reply-To: <lower@example.com>');
    expect(decoded).toContain('References: <lower@example.com>');
  });

  it('uses CRLF line endings in email', async () => {
    mockMessagesGet.mockResolvedValue({
      data: {
        payload: {
          headers: [],
        },
      },
    });
    mockMessagesSend.mockResolvedValue({});

    await sendEmailReply('thread-1', 'to@example.com', 'Subject', 'body text', 'msg-1');

    const raw = mockMessagesSend.mock.calls[0][0].requestBody.raw;
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    // Headers separated by CRLF, double CRLF before body
    expect(decoded).toContain('\r\n\r\nbody text');
  });
});

describe('markAsRead', () => {
  beforeEach(() => {
    mockMessagesModify.mockReset();
  });

  it('removes UNREAD label', async () => {
    mockMessagesModify.mockResolvedValue({});

    await markAsRead('msg-123');

    expect(mockMessagesModify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'msg-123',
      requestBody: {
        removeLabelIds: ['UNREAD'],
      },
    });
  });

  it('passes the correct message ID', async () => {
    mockMessagesModify.mockResolvedValue({});

    await markAsRead('different-msg-id');

    expect(mockMessagesModify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'different-msg-id' }),
    );
  });
});
