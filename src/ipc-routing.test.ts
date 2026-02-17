import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup } from './types.js';
import type { IpcDeps } from './ipc.js';

// ---------------------------------------------------------------------------
// Temp directory — shared across the whole test file
// ---------------------------------------------------------------------------

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-routing-'));
const IPC_DIR = path.join(tmpBase, 'ipc');

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest)
//
// Because we use vi.resetModules() to get a fresh `ipc.js` per test (resetting
// the ipcWatcherRunning guard), every mock factory may be called multiple times.
// We define stable vi.fn() references at the top level and wire the mock
// factories to delegate to them, so assertions always target the same objects.
// ---------------------------------------------------------------------------

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Juniper',
  DATA_DIR: tmpBase,
  IPC_POLL_INTERVAL: 60_000,
  MAIN_GROUP_FOLDER: 'main',
  TIMEZONE: 'UTC',
}));

const mockLogDebug = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
vi.mock('./logger.js', () => ({
  logger: {
    debug: mockLogDebug,
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
  },
}));

const mockHasPoolBots = vi.fn<() => boolean>(() => false);
const mockSendPoolMessage = vi.fn<(chatId: string, text: string, sender: string, groupFolder: string) => Promise<void>>(async () => {});
vi.mock('./channels/telegram.js', () => ({
  hasPoolBots: () => mockHasPoolBots(),
  sendPoolMessage: (a: string, b: string, c: string, d: string) => mockSendPoolMessage(a, b, c, d),
}));

// ipc.ts imports these for task processing (not exercised in this file).
vi.mock('cron-parser', () => ({
  CronExpressionParser: { parse: vi.fn() },
}));
vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeMessageFile(
  groupFolder: string,
  filename: string,
  content: unknown,
): string {
  const dir = path.join(IPC_DIR, groupFolder, 'messages');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  if (typeof content === 'string') {
    fs.writeFileSync(filePath, content, 'utf-8');
  } else {
    fs.writeFileSync(filePath, JSON.stringify(content), 'utf-8');
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Juniper',
  added_at: '2024-01-01T00:00:00.000Z',
};

const TG_GROUP: RegisteredGroup = {
  name: 'Telegram Group',
  folder: 'tg-group',
  trigger: '@Juniper',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let mockSendMessage: ReturnType<typeof vi.fn>;
let deps: IpcDeps;

// ---------------------------------------------------------------------------
// startIpcWatcher has a module-level `ipcWatcherRunning` guard that prevents
// duplicate starts. We use vi.resetModules() + dynamic import to get a fresh
// module (with the boolean reset to false) for every test.
// ---------------------------------------------------------------------------

let startIpcWatcher: typeof import('./ipc.js').startIpcWatcher;

beforeEach(async () => {
  // Clean IPC directory
  fs.rmSync(IPC_DIR, { recursive: true, force: true });
  fs.mkdirSync(IPC_DIR, { recursive: true });

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'tg:-100123456': TG_GROUP,
  };

  mockSendMessage = vi.fn(async () => {}) as unknown as ReturnType<typeof vi.fn> & IpcDeps['sendMessage'];

  deps = {
    sendMessage: mockSendMessage as IpcDeps['sendMessage'],
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
    },
    syncGroupMetadata: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
  };

  mockHasPoolBots.mockReturnValue(false);
  mockSendPoolMessage.mockReset();
  mockLogDebug.mockClear();
  mockLogInfo.mockClear();
  mockLogWarn.mockClear();
  mockLogError.mockClear();

  // Reset the ipc module so ipcWatcherRunning resets to false
  vi.resetModules();
  const ipcModule = await import('./ipc.js');
  startIpcWatcher = ipcModule.startIpcWatcher;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test driver: start the watcher with fake timers, process one poll cycle
// ---------------------------------------------------------------------------

async function startAndProcessOnce(): Promise<void> {
  vi.useFakeTimers();
  startIpcWatcher(deps);
  // processIpcFiles is async — flush microtask queue so awaits resolve
  await vi.advanceTimersByTimeAsync(0);
}

// ---------------------------------------------------------------------------
// 1. Unknown JID handling (the real bug)
// ---------------------------------------------------------------------------

describe('unknown JID handling', () => {
  it('does not crash when sendMessage rejects for unknown JID', async () => {
    mockSendMessage.mockRejectedValueOnce(
      new Error('No channel owns JID email:someone@gmail.com'),
    );

    writeMessageFile('main', 'msg-unknown.json', {
      type: 'message',
      chatJid: 'email:someone@gmail.com',
      text: 'hello from the void',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).toHaveBeenCalledWith(
      'email:someone@gmail.com',
      'Juniper: hello from the void',
    );

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'email:someone@gmail.com',
        sourceGroup: 'main',
      }),
      expect.stringContaining('IPC message send failed'),
    );

    // File stays (continue skips unlinkSync — will be retried next poll)
    const remaining = fs.readdirSync(
      path.join(IPC_DIR, 'main', 'messages'),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe('msg-unknown.json');
  });

  it('continues processing subsequent files after a send failure', async () => {
    mockSendMessage
      .mockRejectedValueOnce(new Error('No channel'))
      .mockResolvedValueOnce(undefined);

    writeMessageFile('main', '01-fail.json', {
      type: 'message',
      chatJid: 'email:unknown@example.com',
      text: 'will fail',
    });
    writeMessageFile('main', '02-succeed.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'will succeed',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage).toHaveBeenCalledWith(
      'other@g.us',
      'Juniper: will succeed',
    );

    // Failed file stays, successful file is deleted
    const remaining = fs.readdirSync(
      path.join(IPC_DIR, 'main', 'messages'),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe('01-fail.json');
  });
});

// ---------------------------------------------------------------------------
// 2. Valid JID routing
// ---------------------------------------------------------------------------

describe('valid JID routing', () => {
  it('sends message with assistant name prefix to correct JID', async () => {
    writeMessageFile('main', 'valid-msg.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'Hello group!',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).toHaveBeenCalledOnce();
    expect(mockSendMessage).toHaveBeenCalledWith(
      'other@g.us',
      'Juniper: Hello group!',
    );
  });

  it('deletes the message file after successful processing', async () => {
    const filePath = writeMessageFile('main', 'to-delete.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'delete me after',
    });

    await startAndProcessOnce();

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('logs info on successful send', async () => {
    writeMessageFile('main', 'info-log.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'logged',
    });

    await startAndProcessOnce();

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'other@g.us',
        sourceGroup: 'main',
      }),
      'IPC message sent',
    );
  });

  it('non-main group can send to its own JID', async () => {
    writeMessageFile('other-group', 'own-msg.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'from myself',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).toHaveBeenCalledWith(
      'other@g.us',
      'Juniper: from myself',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Pool bot routing (Telegram swarm)
// ---------------------------------------------------------------------------

describe('pool bot routing', () => {
  it('routes through sendPoolMessage when sender, tg: JID, and pool bots exist', async () => {
    mockHasPoolBots.mockReturnValue(true);

    writeMessageFile('main', 'pool-msg.json', {
      type: 'message',
      chatJid: 'tg:-100123456',
      text: 'Hello from swarm',
      sender: 'AgentAlpha',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendPoolMessage).toHaveBeenCalledOnce();
    expect(mockSendPoolMessage).toHaveBeenCalledWith(
      'tg:-100123456',
      'Hello from swarm',
      'AgentAlpha',
      'main',
    );
  });

  it('falls back to regular sendMessage when no pool bots available', async () => {
    mockHasPoolBots.mockReturnValue(false);

    writeMessageFile('main', 'no-pool.json', {
      type: 'message',
      chatJid: 'tg:-100123456',
      text: 'No pool available',
      sender: 'AgentBeta',
    });

    await startAndProcessOnce();

    expect(mockSendPoolMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      'tg:-100123456',
      'Juniper: No pool available',
    );
  });

  it('falls back to regular sendMessage when sender is absent even with tg: JID', async () => {
    mockHasPoolBots.mockReturnValue(true);

    writeMessageFile('main', 'no-sender.json', {
      type: 'message',
      chatJid: 'tg:-100123456',
      text: 'No sender field',
    });

    await startAndProcessOnce();

    expect(mockSendPoolMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      'tg:-100123456',
      'Juniper: No sender field',
    );
  });

  it('uses regular sendMessage when sender present but JID is not tg:', async () => {
    mockHasPoolBots.mockReturnValue(true);

    writeMessageFile('main', 'wa-sender.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'WhatsApp with sender',
      sender: 'AgentGamma',
    });

    await startAndProcessOnce();

    expect(mockSendPoolMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      'other@g.us',
      'Juniper: WhatsApp with sender',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Malformed JSON files
// ---------------------------------------------------------------------------

describe('malformed JSON files', () => {
  it('moves malformed file to errors directory without crashing', async () => {
    writeMessageFile('main', 'bad.json', '{{not valid json!!!');

    await startAndProcessOnce();

    const messagesDir = path.join(IPC_DIR, 'main', 'messages');
    const remaining = fs.readdirSync(messagesDir);
    expect(remaining).toHaveLength(0);

    const errorDir = path.join(IPC_DIR, 'errors');
    expect(fs.existsSync(errorDir)).toBe(true);
    const errorFiles = fs.readdirSync(errorDir);
    expect(errorFiles).toHaveLength(1);
    expect(errorFiles[0]).toBe('main-bad.json');
  });

  it('logs an error for malformed JSON', async () => {
    writeMessageFile('main', 'broken.json', '{broken');

    await startAndProcessOnce();

    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        file: 'broken.json',
        sourceGroup: 'main',
      }),
      'Error processing IPC message',
    );
  });

  it('does not affect processing of valid files in the same directory', async () => {
    writeMessageFile('main', '01-bad.json', 'NOT JSON');
    writeMessageFile('main', '02-good.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'I am valid',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).toHaveBeenCalledWith(
      'other@g.us',
      'Juniper: I am valid',
    );

    const errorFiles = fs.readdirSync(path.join(IPC_DIR, 'errors'));
    expect(errorFiles).toContain('main-01-bad.json');
  });
});

// ---------------------------------------------------------------------------
// 5. Authorization checks (integration — actual file-based processing)
// ---------------------------------------------------------------------------

describe('authorization via file processing', () => {
  it('main group can send to any registered JID', async () => {
    writeMessageFile('main', 'cross-group.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'cross-group message',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).toHaveBeenCalledWith(
      'other@g.us',
      'Juniper: cross-group message',
    );
  });

  it('main group can send to unregistered JID', async () => {
    writeMessageFile('main', 'unregistered.json', {
      type: 'message',
      chatJid: 'nobody@g.us',
      text: 'to the unknown',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).toHaveBeenCalledWith(
      'nobody@g.us',
      'Juniper: to the unknown',
    );
  });

  it('non-main group can send to its own JID', async () => {
    writeMessageFile('other-group', 'self-send.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'my own message',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).toHaveBeenCalledWith(
      'other@g.us',
      'Juniper: my own message',
    );
  });

  it('non-main group cannot send to a different groups JID', async () => {
    writeMessageFile('other-group', 'unauthorized.json', {
      type: 'message',
      chatJid: 'main@g.us',
      text: 'should be blocked',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'main@g.us',
        sourceGroup: 'other-group',
      }),
      'Unauthorized IPC message attempt blocked',
    );
  });

  it('non-main group cannot send to unregistered JID', async () => {
    writeMessageFile('other-group', 'unreg.json', {
      type: 'message',
      chatJid: 'unknown@g.us',
      text: 'blocked',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'unknown@g.us',
        sourceGroup: 'other-group',
      }),
      'Unauthorized IPC message attempt blocked',
    );
  });

  it('unauthorized message file is still deleted', async () => {
    const filePath = writeMessageFile('other-group', 'blocked.json', {
      type: 'message',
      chatJid: 'main@g.us',
      text: 'blocked but cleaned up',
    });

    await startAndProcessOnce();

    expect(fs.existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('ignores files without .json extension', async () => {
    const dir = path.join(IPC_DIR, 'main', 'messages');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'not a message', 'utf-8');

    await startAndProcessOnce();

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'readme.txt'))).toBe(true);
  });

  it('skips messages missing required fields (chatJid or text)', async () => {
    writeMessageFile('main', 'no-text.json', {
      type: 'message',
      chatJid: 'other@g.us',
    });
    writeMessageFile('main', 'no-jid.json', {
      type: 'message',
      text: 'orphan text',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).not.toHaveBeenCalled();

    const remaining = fs.readdirSync(
      path.join(IPC_DIR, 'main', 'messages'),
    );
    expect(remaining).toHaveLength(0);
  });

  it('skips the errors directory when scanning group folders', async () => {
    const errDir = path.join(IPC_DIR, 'errors');
    fs.mkdirSync(errDir, { recursive: true });
    fs.writeFileSync(
      path.join(errDir, 'stale.json'),
      JSON.stringify({ type: 'message', chatJid: 'x', text: 'y' }),
      'utf-8',
    );

    await startAndProcessOnce();

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('handles empty messages directory gracefully', async () => {
    const dir = path.join(IPC_DIR, 'main', 'messages');
    fs.mkdirSync(dir, { recursive: true });

    await startAndProcessOnce();

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('processes files from multiple group directories in one poll', async () => {
    writeMessageFile('main', 'from-main.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'from main',
    });
    writeMessageFile('other-group', 'from-other.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'from other',
    });

    await startAndProcessOnce();

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage).toHaveBeenCalledWith(
      'other@g.us',
      'Juniper: from main',
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      'other@g.us',
      'Juniper: from other',
    );
  });
});
