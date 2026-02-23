import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// --- MarkdownV2 conversion utilities ---

/** Characters that must be escaped outside of formatting entities in MarkdownV2. */
const MD2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

function escapeMarkdownV2(text: string): string {
  return text.replace(MD2_SPECIAL, '\\$&');
}

/**
 * Convert standard Markdown (as produced by Claude) to Telegram MarkdownV2 format.
 * Handles fenced code blocks, inline code, links, bold, italic, and bold-italic.
 * All other MarkdownV2 special characters are escaped.
 */
function markdownToTelegramV2(text: string): string {
  const blocks: string[] = [];
  const ph = (s: string) => {
    const i = blocks.length;
    blocks.push(s);
    return `\x00${i}\x00`;
  };

  let r = text;

  // Fenced code blocks
  r = r.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    ph(`\`\`\`${lang}\n${code.replace(/([`\\])/g, '\\$1')}\`\`\``),
  );

  // Inline code
  r = r.replace(/`([^`\n]+)`/g, (_, code) =>
    ph(`\`${code.replace(/([`\\])/g, '\\$1')}\``),
  );

  // Links [text](url)
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t: string, url: string) =>
    ph(`[${escapeMarkdownV2(t)}](${url.replace(/[)\\]/g, '\\$&')})`),
  );

  // Bold italic ***text***
  r = r.replace(/\*\*\*(.+?)\*\*\*/g, (_, c: string) =>
    ph(`*_${escapeMarkdownV2(c)}_*`),
  );

  // Bold **text**
  r = r.replace(/\*\*(.+?)\*\*/g, (_, c: string) =>
    ph(`*${escapeMarkdownV2(c)}*`),
  );

  // Italic *text*
  r = r.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, (_, c: string) =>
    ph(`_${escapeMarkdownV2(c)}_`),
  );

  return r
    .split(/(\x00\d+\x00)/)
    .map((part) => {
      const m = part.match(/^\x00(\d+)\x00$/);
      return m ? blocks[parseInt(m[1])] : escapeMarkdownV2(part);
    })
    .join('');
}

/**
 * Send a Telegram message with MarkdownV2 formatting.
 * Falls back to plain text if MarkdownV2 parsing fails.
 */
async function sendTelegramMessage(
  api: Api,
  chatId: string,
  text: string,
): Promise<void> {
  const MAX_LENGTH = 4096;

  const formatted = markdownToTelegramV2(text);
  if (formatted.length <= MAX_LENGTH) {
    try {
      await api.sendMessage(chatId, formatted, { parse_mode: 'MarkdownV2' });
      return;
    } catch {
      logger.debug('MarkdownV2 send failed, falling back to plain text');
    }
  }

  if (text.length <= MAX_LENGTH) {
    await api.sendMessage(chatId, text);
  } else {
    for (let i = 0; i < text.length; i += MAX_LENGTH) {
      await api.sendMessage(chatId, text.slice(i, i + MAX_LENGTH));
    }
  }
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false;

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]'),
    );
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      await sendTelegramMessage(this.bot.api, numericId, text);
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    // Clear all typing intervals
    for (const [, interval] of this.typingIntervals) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot) return;
    if (!isTyping) {
      const existing = this.typingIntervals.get(jid);
      if (existing) {
        clearInterval(existing);
        this.typingIntervals.delete(jid);
      }
      return;
    }
    if (this.typingIntervals.has(jid)) return;
    const numericId = jid.replace(/^tg:/, '');
    const sendAction = () => {
      this.bot?.api.sendChatAction(numericId, 'typing').catch((err) => {
        logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
      });
    };
    sendAction();
    this.typingIntervals.set(jid, setInterval(sendAction, 4000));
  }
}

// --- Bot Pool for Agent Teams ---

const poolApis: Api[] = [];
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) return;
  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned and renamed pool bot');
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
    }
  }
  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    await sendTelegramMessage(api, numericId, text);
    logger.info({ chatId, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export function hasPoolBots(): boolean {
  return poolApis.length > 0;
}
