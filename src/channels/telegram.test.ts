import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Juniper',
  TRIGGER_PATTERN: /^@Juniper\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Grammy mock (hoisted to avoid TDZ issues) ---

type Handler = (...args: any[]) => any;

const {
  mockBotInstances,
  mockApiInstances,
  MockBotClass,
  MockApiClass,
} = vi.hoisted(() => {
  const mockBotInstances: any[] = [];
  const mockApiInstances: any[] = [];

  function createMockBotApi() {
    return {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendChatAction: vi.fn().mockResolvedValue(true),
      setMyName: vi.fn().mockResolvedValue(true),
      getMe: vi.fn().mockResolvedValue({ id: 999, username: 'test_pool_bot', is_bot: true }),
    };
  }

  class MockBotClass {
    api = createMockBotApi();
    handlers: Record<string, ((...args: any[]) => any)[]> = {};
    commandHandlers: Record<string, (...args: any[]) => any> = {};
    catchHandler: ((...args: any[]) => any) | null = null;
    _started = false;
    token: string;

    constructor(token: string) {
      this.token = token;
      mockBotInstances.push(this);
    }

    on(event: string, handler: (...args: any[]) => any) {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(handler);
    }

    command(name: string, handler: (...args: any[]) => any) {
      this.commandHandlers[name] = handler;
    }

    catch(handler: (...args: any[]) => any) {
      this.catchHandler = handler;
    }

    start(opts?: { onStart?: (botInfo: any) => void }) {
      this._started = true;
      if (opts?.onStart) {
        opts.onStart({ id: 123, username: 'juniper_bot', is_bot: true });
      }
    }

    stop() {
      this._started = false;
    }

    // Test helpers
    _trigger(event: string, ctx: any) {
      const fns = this.handlers[event] || [];
      return Promise.all(fns.map((h) => h(ctx)));
    }

    _triggerCommand(name: string, ctx: any) {
      const handler = this.commandHandlers[name];
      if (handler) return handler(ctx);
    }

    _triggerError(err: any) {
      if (this.catchHandler) return this.catchHandler(err);
    }

    get isStarted() {
      return this._started;
    }
  }

  class MockApiClass {
    sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    sendChatAction = vi.fn().mockResolvedValue(true);
    setMyName = vi.fn().mockResolvedValue(true);
    getMe = vi.fn().mockResolvedValue({ id: 888, username: 'pool_bot', is_bot: true });

    constructor(_token: string) {
      mockApiInstances.push(this);
    }
  }

  return { mockBotInstances, mockApiInstances, MockBotClass, MockApiClass };
});

vi.mock('grammy', () => ({
  Bot: MockBotClass,
  Api: MockApiClass,
}));

import { TelegramChannel, TelegramChannelOpts, sendPoolMessage, hasPoolBots, initBotPool } from './telegram.js';
import { logger } from '../logger.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<TelegramChannelOpts>): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:12345': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Juniper',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })) as any,
    ...overrides,
  };
}

function createTextCtx(overrides: Record<string, any> = {}) {
  return {
    chat: { id: 12345, type: 'group', title: 'Test Group', ...overrides.chat },
    from: { id: 999, first_name: 'Alice', username: 'alice', ...overrides.from },
    message: {
      text: 'Hello',
      date: Math.floor(Date.now() / 1000),
      message_id: 42,
      entities: [],
      ...overrides.message,
    },
    me: { username: 'juniper_bot', ...overrides.me },
    reply: vi.fn(),
    ...overrides,
  };
}

// --- Tests ---

describe('TelegramChannel', () => {
  let lastBot: InstanceType<typeof MockBotClass>;

  beforeEach(() => {
    mockBotInstances.length = 0;
    mockApiInstances.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connectChannel(channel: TelegramChannel): Promise<void> {
    await channel.connect();
    lastBot = mockBotInstances[mockBotInstances.length - 1];
  }

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });

    it('does not prefix assistant name', () => {
      const channel = new TelegramChannel('token', createTestOpts());
      expect(channel.prefixAssistantName).toBe(false);
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('returns true for tg: prefix', () => {
      const channel = new TelegramChannel('token', createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(true);
    });

    it('returns true for tg: prefix with negative chat ID', () => {
      const channel = new TelegramChannel('token', createTestOpts());
      expect(channel.ownsJid('tg:-100123456')).toBe(true);
    });

    it('returns false for WhatsApp JIDs', () => {
      const channel = new TelegramChannel('token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('returns false for plain numbers', () => {
      const channel = new TelegramChannel('token', createTestOpts());
      expect(channel.ownsJid('12345')).toBe(false);
    });

    it('returns false for empty string', () => {
      const channel = new TelegramChannel('token', createTestOpts());
      expect(channel.ownsJid('')).toBe(false);
    });
  });

  // --- isConnected ---

  describe('isConnected', () => {
    it('returns false before connect()', () => {
      const channel = new TelegramChannel('token', createTestOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('returns true after connect()', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);
      expect(channel.isConnected()).toBe(true);
    });

    it('returns false after disconnect()', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- disconnect ---

  describe('disconnect', () => {
    it('stops the bot and sets it to null', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(lastBot.isStarted).toBe(false);
    });

    it('is safe to call when not connected', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await expect(channel.disconnect()).resolves.toBeUndefined();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('logs warning when bot is not initialized', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await channel.sendMessage('tg:12345', 'Hello');
      expect(logger.warn).toHaveBeenCalledWith('Telegram bot not initialized');
    });

    it('strips tg: prefix before sending', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      await channel.sendMessage('tg:12345', 'Hello');

      expect(lastBot.api.sendMessage).toHaveBeenCalledWith(
        '12345',
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' }),
      );
    });

    it('sends plain text with MarkdownV2 escaping', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      await channel.sendMessage('tg:12345', 'Hello world');

      expect(lastBot.api.sendMessage).toHaveBeenCalledWith(
        '12345',
        'Hello world',
        { parse_mode: 'MarkdownV2' },
      );
    });

    it('catches and logs send errors', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      // Both MarkdownV2 and plain text calls fail to trigger the outer catch
      lastBot.api.sendMessage.mockRejectedValue(new Error('Network error'));

      await expect(channel.sendMessage('tg:12345', 'Hello')).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:12345' }),
        'Failed to send Telegram message',
      );
    });

    it('logs success info after sending', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      await channel.sendMessage('tg:12345', 'Hello');

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'tg:12345', length: 5 }),
        'Telegram message sent',
      );
    });
  });

  // --- MarkdownV2 conversion (tested via sendMessage) ---

  describe('MarkdownV2 conversion', () => {
    async function sendAndCapture(text: string): Promise<string> {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);
      await channel.sendMessage('tg:12345', text);
      const call = lastBot.api.sendMessage.mock.calls[0];
      return call[1] as string;
    }

    it('escapes MarkdownV2 special characters in plain text', async () => {
      const sent = await sendAndCapture('Hello! How are you? (fine) [ok]');
      expect(sent).toBe('Hello\\! How are you? \\(fine\\) \\[ok\\]');
    });

    it('escapes dots and hyphens', async () => {
      const sent = await sendAndCapture('file.txt - test');
      expect(sent).toBe('file\\.txt \\- test');
    });

    it('converts bold **text** to *escaped*', async () => {
      const sent = await sendAndCapture('This is **bold** text');
      expect(sent).toBe('This is *bold* text');
    });

    it('converts italic *text* to _escaped_', async () => {
      const sent = await sendAndCapture('This is *italic* text');
      expect(sent).toBe('This is _italic_ text');
    });

    it('converts bold italic ***text*** to *_escaped_*', async () => {
      const sent = await sendAndCapture('This is ***bold italic*** text');
      expect(sent).toBe('This is *_bold italic_* text');
    });

    it('preserves fenced code blocks', async () => {
      const sent = await sendAndCapture('```js\nconsole.log("hi")\n```');
      expect(sent).toBe('```js\nconsole.log("hi")\n```');
    });

    it('escapes backticks and backslashes inside code blocks', async () => {
      const sent = await sendAndCapture('```\nfoo\\bar`baz\n```');
      expect(sent).toBe('```\nfoo\\\\bar\\`baz\n```');
    });

    it('preserves inline code', async () => {
      const sent = await sendAndCapture('Run `npm install` now');
      expect(sent).toBe('Run `npm install` now');
    });

    it('escapes backslashes inside inline code', async () => {
      const sent = await sendAndCapture('Use `foo\\bar` here');
      expect(sent).toBe('Use `foo\\\\bar` here');
    });

    it('converts links [text](url)', async () => {
      const sent = await sendAndCapture('Visit [Google](https://google.com) now');
      expect(sent).toBe('Visit [Google](https://google.com) now');
    });

    it('escapes special chars in link text', async () => {
      const sent = await sendAndCapture('[Click here!](https://example.com)');
      expect(sent).toBe('[Click here\\!](https://example.com)');
    });

    it('handles multiple formatting types in one message', async () => {
      const sent = await sendAndCapture('**Bold** and *italic* and `code`');
      expect(sent).toBe('*Bold* and _italic_ and `code`');
    });

    it('escapes remaining special chars outside formatting', async () => {
      const sent = await sendAndCapture('**Bold** > quote #tag');
      expect(sent).toBe('*Bold* \\> quote \\#tag');
    });

    it('handles text with no markdown', async () => {
      const sent = await sendAndCapture('Just plain text');
      expect(sent).toBe('Just plain text');
    });

    it('handles equals and pipe characters', async () => {
      const sent = await sendAndCapture('a = b | c');
      expect(sent).toBe('a \\= b \\| c');
    });

    it('handles curly braces', async () => {
      const sent = await sendAndCapture('{ key: value }');
      expect(sent).toBe('\\{ key: value \\}');
    });

    it('handles tilde', async () => {
      const sent = await sendAndCapture('~strikethrough~');
      expect(sent).toBe('\\~strikethrough\\~');
    });

    it('handles plus sign', async () => {
      const sent = await sendAndCapture('a + b');
      expect(sent).toBe('a \\+ b');
    });

    it('handles code block with language specifier and special chars outside', async () => {
      const sent = await sendAndCapture('Run this:\n```bash\necho "hello"\n```\nDone!');
      expect(sent).toBe('Run this:\n```bash\necho "hello"\n```\nDone\\!');
    });

    it('handles bold with special chars inside', async () => {
      const sent = await sendAndCapture('**hello!**');
      expect(sent).toBe('*hello\\!*');
    });

    it('handles italic with special chars inside', async () => {
      const sent = await sendAndCapture('*hello!*');
      expect(sent).toBe('_hello\\!_');
    });

    it('handles bold italic with special chars inside', async () => {
      const sent = await sendAndCapture('***hello!***');
      expect(sent).toBe('*_hello\\!_*');
    });

    it('handles link URL with backslash', async () => {
      const sent = await sendAndCapture('[text](https://example.com/a\\b)');
      expect(sent).toBe('[text](https://example.com/a\\\\b)');
    });
  });

  // --- sendTelegramMessage fallback (tested via sendMessage) ---

  describe('sendTelegramMessage fallback behavior', () => {
    it('falls back to plain text when MarkdownV2 fails', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      // First call (MarkdownV2) fails, second call (plain text) succeeds
      lastBot.api.sendMessage
        .mockRejectedValueOnce(new Error('Bad Request: can\'t parse entities'))
        .mockResolvedValueOnce({ message_id: 2 });

      await channel.sendMessage('tg:12345', 'Hello');

      expect(lastBot.api.sendMessage).toHaveBeenCalledTimes(2);
      // First call with MarkdownV2
      expect(lastBot.api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '12345',
        expect.any(String),
        { parse_mode: 'MarkdownV2' },
      );
      // Second call without parse_mode (plain text)
      expect(lastBot.api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '12345',
        'Hello',
      );
    });

    it('chunks long messages into 4096-char segments (plain text)', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      // 5000 plain A's: formatted text is also 5000 (no special chars)
      // Since formatted.length (5000) > MAX_LENGTH (4096), MarkdownV2 is skipped
      // Then plain text (5000) > MAX_LENGTH, so chunking kicks in
      const longText = 'A'.repeat(5000);

      await channel.sendMessage('tg:12345', longText);

      const calls = lastBot.api.sendMessage.mock.calls;
      // Should be 2 chunk calls (5000 / 4096 = ceil to 2 chunks)
      expect(calls.length).toBe(2);
      expect(calls[0][1]).toBe('A'.repeat(4096));
      expect(calls[1][1]).toBe('A'.repeat(904));
    });

    it('sends short text as single plain message when MarkdownV2 fails', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      lastBot.api.sendMessage
        .mockRejectedValueOnce(new Error('parse error'))
        .mockResolvedValueOnce({ message_id: 2 });

      await channel.sendMessage('tg:12345', 'Short text');

      expect(lastBot.api.sendMessage).toHaveBeenCalledTimes(2);
      expect(lastBot.api.sendMessage).toHaveBeenNthCalledWith(2, '12345', 'Short text');
    });

    it('skips MarkdownV2 when formatted text exceeds 4096 chars', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      // Each ! becomes \! (2 chars), so 2500 ! chars become 5000 escaped chars
      const text = '!'.repeat(2500);

      await channel.sendMessage('tg:12345', text);

      // The formatted text (5000 chars) exceeds 4096,
      // so it should skip MarkdownV2 and go straight to plain text
      const calls = lastBot.api.sendMessage.mock.calls;
      // Plain text is 2500 chars < 4096, so single call without parse_mode
      expect(calls.length).toBe(1);
      expect(calls[0][1]).toBe(text);
      expect(calls[0][2]).toBeUndefined();
    });

    it('sends single message for text exactly at 4096 chars', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      const text = 'A'.repeat(4096);

      await channel.sendMessage('tg:12345', text);

      const calls = lastBot.api.sendMessage.mock.calls;
      // Formatted text is 4096 (no special chars) <= MAX_LENGTH, tries MarkdownV2
      expect(calls.length).toBe(1);
      expect(calls[0][1]).toBe(text);
      expect(calls[0][2]).toEqual({ parse_mode: 'MarkdownV2' });
    });

    it('chunks text at exactly 4097 chars into two messages', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      const text = 'A'.repeat(4097);

      await channel.sendMessage('tg:12345', text);

      const calls = lastBot.api.sendMessage.mock.calls;
      // formatted (4097) > 4096, skip MarkdownV2, plain text > 4096, chunk
      expect(calls.length).toBe(2);
      expect(calls[0][1]).toBe('A'.repeat(4096));
      expect(calls[1][1]).toBe('A');
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends typing action immediately when isTyping is true', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      await channel.setTyping('tg:12345', true);

      expect(lastBot.api.sendChatAction).toHaveBeenCalledWith('12345', 'typing');
      expect(lastBot.api.sendChatAction).toHaveBeenCalledTimes(1);

      // Clean up
      await channel.setTyping('tg:12345', false);
    });

    it('repeats typing action every 4 seconds', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      await channel.setTyping('tg:12345', true);
      expect(lastBot.api.sendChatAction).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(4000);
      expect(lastBot.api.sendChatAction).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(4000);
      expect(lastBot.api.sendChatAction).toHaveBeenCalledTimes(3);

      // Clean up
      await channel.setTyping('tg:12345', false);
    });

    it('stops repeating when isTyping is set to false', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      await channel.setTyping('tg:12345', true);
      expect(lastBot.api.sendChatAction).toHaveBeenCalledTimes(1);

      await channel.setTyping('tg:12345', false);
      lastBot.api.sendChatAction.mockClear();

      vi.advanceTimersByTime(8000);
      expect(lastBot.api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when isTyping is false and not currently typing', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      await channel.setTyping('tg:12345', false);

      expect(lastBot.api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does not start duplicate intervals for same jid', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      await channel.setTyping('tg:12345', true);
      await channel.setTyping('tg:12345', true); // second call should be ignored

      expect(lastBot.api.sendChatAction).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(4000);
      // Should only fire once (one interval, not two)
      expect(lastBot.api.sendChatAction).toHaveBeenCalledTimes(2);

      // Clean up
      await channel.setTyping('tg:12345', false);
    });

    it('does nothing when bot is not initialized', async () => {
      const channel = new TelegramChannel('token', createTestOpts());

      await expect(channel.setTyping('tg:12345', true)).resolves.toBeUndefined();
    });

    it('handles typing error gracefully and keeps interval running', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      lastBot.api.sendChatAction.mockRejectedValue(new Error('Network error'));

      await channel.setTyping('tg:12345', true);

      // Should not throw — error is caught
      vi.advanceTimersByTime(4000);

      // Still trying (interval not cleared by errors)
      expect(lastBot.api.sendChatAction).toHaveBeenCalledTimes(2);

      // Clean up
      await channel.setTyping('tg:12345', false);
    });

    it('strips tg: prefix from jid', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      await channel.setTyping('tg:67890', true);

      expect(lastBot.api.sendChatAction).toHaveBeenCalledWith('67890', 'typing');

      // Clean up
      await channel.setTyping('tg:67890', false);
    });

    it('clears all typing intervals on disconnect', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      await channel.setTyping('tg:111', true);
      await channel.setTyping('tg:222', true);
      lastBot.api.sendChatAction.mockClear();

      await channel.disconnect();

      vi.advanceTimersByTime(8000);
      expect(lastBot.api.sendChatAction).not.toHaveBeenCalled();
    });
  });

  // --- Message handling (connect handlers) ---

  describe('message handling', () => {
    it('delivers text message for registered chat', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx();
      await lastBot._trigger('message:text', ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:12345',
        expect.any(String),
        'Test Group',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          id: '42',
          chat_jid: 'tg:12345',
          sender: '999',
          sender_name: 'Alice',
          content: 'Hello',
          is_from_me: false,
        }),
      );
    });

    it('skips messages starting with /', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx({
        message: {
          text: '/start',
          date: Math.floor(Date.now() / 1000),
          message_id: 1,
          entities: [],
        },
      });
      await lastBot._trigger('message:text', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('only stores metadata for unregistered chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})) as any,
      });
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx({
        chat: { id: 99999, type: 'group', title: 'Unknown Group' },
      });
      await lastBot._trigger('message:text', ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:99999',
        expect.any(String),
        'Unknown Group',
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('logs debug for unregistered chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})) as any,
      });
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx({
        chat: { id: 99999, type: 'group', title: 'Unknown Group' },
      });
      await lastBot._trigger('message:text', ctx);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ chatJid: 'tg:99999', chatName: 'Unknown Group' }),
        'Message from unregistered Telegram chat',
      );
    });

    it('translates @bot_username mention into trigger format', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx({
        message: {
          text: '@juniper_bot What is the weather?',
          date: Math.floor(Date.now() / 1000),
          message_id: 50,
          entities: [{ type: 'mention', offset: 0, length: 12 }],
        },
      });
      await lastBot._trigger('message:text', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: '@Juniper @juniper_bot What is the weather?',
        }),
      );
    });

    it('does not add trigger when content already matches trigger pattern', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx({
        message: {
          text: '@Juniper @juniper_bot do something',
          date: Math.floor(Date.now() / 1000),
          message_id: 51,
          entities: [{ type: 'mention', offset: 9, length: 12 }],
        },
      });
      await lastBot._trigger('message:text', ctx);

      // Should NOT double-prefix since TRIGGER_PATTERN already matches
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: '@Juniper @juniper_bot do something',
        }),
      );
    });

    it('does not translate non-bot mentions', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx({
        message: {
          text: '@someoneelse Hello!',
          date: Math.floor(Date.now() / 1000),
          message_id: 52,
          entities: [{ type: 'mention', offset: 0, length: 12 }],
        },
      });
      await lastBot._trigger('message:text', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: '@someoneelse Hello!',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx({
        message: {
          text: 'Check https://example.com',
          date: Math.floor(Date.now() / 1000),
          message_id: 53,
          entities: [{ type: 'url', offset: 6, length: 19 }],
        },
      });
      await lastBot._trigger('message:text', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          content: 'Check https://example.com',
        }),
      );
    });

    it('uses sender first_name for sender_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx({
        from: { id: 111, first_name: 'Bob', username: 'bob_user' },
      });
      await lastBot._trigger('message:text', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name is missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx({
        from: { id: 222, first_name: '', username: 'bob_user' },
      });
      await lastBot._trigger('message:text', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ sender_name: 'bob_user' }),
      );
    });

    it('falls back to user id when first_name and username are missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx({
        from: { id: 333, first_name: '', username: '' },
      });
      await lastBot._trigger('message:text', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ sender_name: '333' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:999': {
            name: 'Private',
            folder: 'private',
            trigger: '@Juniper',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })) as any,
      });
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx({
        chat: { id: 999, type: 'private' },
        from: { id: 999, first_name: 'Alice', username: 'alice' },
      });
      await lastBot._trigger('message:text', ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999',
        expect.any(String),
        'Alice',
      );
    });

    it('converts message timestamp from unix seconds', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const unixSeconds = 1700000000;
      const ctx = createTextCtx({
        message: {
          text: 'Test',
          date: unixSeconds,
          message_id: 60,
          entities: [],
        },
      });
      await lastBot._trigger('message:text', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          timestamp: new Date(unixSeconds * 1000).toISOString(),
        }),
      );
    });

    it('logs info after storing message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);

      const ctx = createTextCtx();
      await lastBot._trigger('message:text', ctx);

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: 'tg:12345',
          chatName: 'Test Group',
          sender: 'Alice',
        }),
        'Telegram message stored',
      );
    });
  });

  // --- Non-text message handling ---

  describe('non-text message handling', () => {
    async function setupAndTrigger(
      event: string,
      ctx: any,
      registered = true,
    ) {
      const opts = createTestOpts(
        registered
          ? undefined
          : { registeredGroups: vi.fn(() => ({})) as any },
      );
      const channel = new TelegramChannel('token', opts);
      await connectChannel(channel);
      await lastBot._trigger(event, ctx);
      return opts;
    }

    function createNonTextCtx(overrides: Record<string, any> = {}) {
      return {
        chat: { id: 12345, type: 'group', title: 'Test Group' },
        from: { id: 999, first_name: 'Alice', username: 'alice' },
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 100,
          ...overrides.message,
        },
        ...overrides,
      };
    }

    it('handles photo messages', async () => {
      const ctx = createNonTextCtx();
      const opts = await setupAndTrigger('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('handles photo with caption', async () => {
      const ctx = createNonTextCtx({
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 101,
          caption: 'Nice view',
        },
      });
      const opts = await setupAndTrigger('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '[Photo] Nice view' }),
      );
    });

    it('handles video messages', async () => {
      const ctx = createNonTextCtx();
      const opts = await setupAndTrigger('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('handles voice messages', async () => {
      const ctx = createNonTextCtx();
      const opts = await setupAndTrigger('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '[Voice message]' }),
      );
    });

    it('handles audio messages', async () => {
      const ctx = createNonTextCtx();
      const opts = await setupAndTrigger('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('handles document messages with filename', async () => {
      const ctx = createNonTextCtx({
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 102,
          document: { file_name: 'report.pdf' },
        },
      });
      const opts = await setupAndTrigger('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '[Document: report.pdf]' }),
      );
    });

    it('handles document without filename', async () => {
      const ctx = createNonTextCtx({
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 103,
          document: {},
        },
      });
      const opts = await setupAndTrigger('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '[Document: file]' }),
      );
    });

    it('handles sticker with emoji', async () => {
      const ctx = createNonTextCtx({
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 104,
          sticker: { emoji: '\u{1F602}' },
        },
      });
      const opts = await setupAndTrigger('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '[Sticker \u{1F602}]' }),
      );
    });

    it('handles sticker without emoji', async () => {
      const ctx = createNonTextCtx({
        message: {
          date: Math.floor(Date.now() / 1000),
          message_id: 105,
          sticker: {},
        },
      });
      const opts = await setupAndTrigger('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '[Sticker ]' }),
      );
    });

    it('handles location messages', async () => {
      const ctx = createNonTextCtx();
      const opts = await setupAndTrigger('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('handles contact messages', async () => {
      const ctx = createNonTextCtx();
      const opts = await setupAndTrigger('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('skips non-text messages from unregistered chats', async () => {
      const ctx = createNonTextCtx({
        chat: { id: 99999, type: 'group', title: 'Unregistered' },
      });
      const opts = await setupAndTrigger('message:photo', ctx, false);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('includes sender info in non-text messages', async () => {
      const ctx = createNonTextCtx({
        from: { id: 777, first_name: 'Charlie', username: 'charlie' },
      });
      const opts = await setupAndTrigger('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.objectContaining({
          sender: '777',
          sender_name: 'Charlie',
        }),
      );
    });

    it('calls onChatMetadata for non-text messages', async () => {
      const ctx = createNonTextCtx();
      const opts = await setupAndTrigger('message:photo', ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:12345',
        expect.any(String),
      );
    });
  });

  // --- Commands ---

  describe('bot commands', () => {
    it('responds to /chatid with chat info', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      const ctx = {
        chat: { id: 12345, type: 'group', title: 'My Group' },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };
      lastBot._triggerCommand('chatid', ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        'Chat ID: `tg:12345`\nName: My Group\nType: group',
        { parse_mode: 'Markdown' },
      );
    });

    it('uses first_name for private chat /chatid', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      const ctx = {
        chat: { id: 999, type: 'private' },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };
      lastBot._triggerCommand('chatid', ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        'Chat ID: `tg:999`\nName: Bob\nType: private',
        { parse_mode: 'Markdown' },
      );
    });

    it('responds to /ping with assistant name', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      const ctx = { reply: vi.fn() };
      lastBot._triggerCommand('ping', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Juniper is online.');
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('logs bot errors via catch handler', async () => {
      const channel = new TelegramChannel('token', createTestOpts());
      await connectChannel(channel);

      lastBot._triggerError({ message: 'Something went wrong' });

      expect(logger.error).toHaveBeenCalledWith(
        { err: 'Something went wrong' },
        'Telegram bot error',
      );
    });
  });
});

// --- Bot Pool ---

describe('Bot pool', () => {
  // Note: poolApis is module-level state that persists across tests.
  // We don't clear mockApiInstances here because pool tests need
  // access to API instances created by initBotPool.

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initBotPool and hasPoolBots', () => {
    it('initializes API instances and calls getMe', async () => {
      const countBefore = mockApiInstances.length;
      await initBotPool(['token1', 'token2']);

      // Two new Api instances created
      expect(mockApiInstances.length - countBefore).toBe(2);
      // getMe called on each new instance
      const newApis = mockApiInstances.slice(countBefore);
      for (const api of newApis) {
        expect(api.getMe).toHaveBeenCalled();
      }
      expect(hasPoolBots()).toBe(true);
    });
  });

  describe('sendPoolMessage', () => {
    it('strips tg: prefix from chatId', async () => {
      // Pool is already initialized from the previous test (module-level state persists)
      if (!hasPoolBots()) {
        await initBotPool(['pool-token-1']);
      }

      // Use the first pool API (round-robin assigns to first available)
      // sendPoolMessage assigns bots round-robin, so use a unique sender
      // to get a deterministic assignment
      const countBefore = mockApiInstances.length;

      await sendPoolMessage('tg:12345', 'Hello', 'StripPrefixSender', 'strip-prefix-group');

      // Find which API was used by checking which one had sendMessage called
      const calledApi = mockApiInstances.find((api) => api.sendMessage.mock.calls.length > 0);
      expect(calledApi).toBeDefined();
      expect(calledApi!.sendMessage).toHaveBeenCalledWith(
        '12345',
        expect.any(String),
        expect.anything(),
      );
    });

    it('renames bot on first assignment', async () => {
      if (!hasPoolBots()) {
        await initBotPool(['pool-rename']);
      }

      // Use a unique sender to ensure it's a new assignment
      await sendPoolMessage('tg:222', 'Hello', 'UniqueRenameSender', 'unique-rename-group');

      // Find which API was assigned (had setMyName called)
      const calledApi = mockApiInstances.find((api) => api.setMyName.mock.calls.length > 0);
      expect(calledApi).toBeDefined();
      expect(calledApi!.setMyName).toHaveBeenCalledWith('UniqueRenameSender');
    });

    it('sends message even if rename fails', async () => {
      if (!hasPoolBots()) {
        await initBotPool(['pool-rename-fail']);
      }

      // Make ALL pool APIs' setMyName fail so whichever gets assigned will fail rename
      for (const api of mockApiInstances) {
        api.setMyName.mockRejectedValueOnce(new Error('Rename failed'));
        api.sendMessage.mockResolvedValue({ message_id: 1 });
      }

      await sendPoolMessage('tg:333', 'Hello', 'FailRenameUnique', 'fail-rename-unique');

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sender: 'FailRenameUnique' }),
        'Failed to rename pool bot (sending anyway)',
      );
      // Message should still be sent
      const calledApi = mockApiInstances.find((api) => api.sendMessage.mock.calls.length > 0);
      expect(calledApi).toBeDefined();
    });

    it('handles send failure gracefully', async () => {
      if (!hasPoolBots()) {
        await initBotPool(['pool-send-fail']);
      }

      // Make ALL pool APIs' sendMessage fail
      for (const api of mockApiInstances) {
        api.sendMessage.mockRejectedValue(new Error('Send failed'));
      }

      await expect(
        sendPoolMessage('tg:444', 'Hello', 'ErrorSendUnique', 'error-send-unique'),
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'tg:444', sender: 'ErrorSendUnique' }),
        'Failed to send pool message',
      );
    });
  });
});
