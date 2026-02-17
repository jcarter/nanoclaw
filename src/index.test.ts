import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

import {
  _initTestDatabase,
  getAllRegisteredGroups,
  getRouterState,
  getSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { RegisteredGroup, NewMessage } from './types.js';

// --- Mocks ---

// Mock container-runner (runContainerAgent, writeGroupsSnapshot, writeTasksSnapshot)
vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(async () => ({ status: 'success', result: null })),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

// Mock container-runtime (not used directly but imported by index.ts)
vi.mock('./container-runtime.js', () => ({
  getContainerRuntime: () => 'docker',
  isDocker: () => true,
}));

// Mock channels
vi.mock('./channels/whatsapp.js', () => ({
  WhatsAppChannel: vi.fn(),
}));

vi.mock('./channels/telegram.js', () => ({
  TelegramChannel: vi.fn(),
  initBotPool: vi.fn(),
}));

// Mock subsystems that start infinite loops
vi.mock('./ipc.js', () => ({
  startIpcWatcher: vi.fn(),
}));

vi.mock('./task-scheduler.js', () => ({
  startSchedulerLoop: vi.fn(),
}));

// Mock email-channel
vi.mock('./email-channel.js', () => ({
  checkForNewEmails: vi.fn(async () => []),
  getContextKey: vi.fn(() => 'test-context'),
  markAsRead: vi.fn(async () => {}),
  sendEmailReply: vi.fn(async () => {}),
}));

// Mock fs.mkdirSync so registerGroup doesn't create real directories
const originalMkdirSync = fs.mkdirSync;
vi.spyOn(fs, 'mkdirSync').mockImplementation((...args) => {
  // Allow mkdirSync for paths that aren't group directories
  const dirPath = args[0] as string;
  if (typeof dirPath === 'string' && dirPath.includes('/groups/')) {
    return undefined;
  }
  return originalMkdirSync(...args);
});

// Import the module under test AFTER mocks are set up
import {
  getAvailableGroups,
  _setRegisteredGroups,
  _setLastAgentTimestamp,
  _getLastAgentTimestamp,
  _setSessions,
  _setChannels,
  _processGroupMessages,
  _registerGroup,
  _recoverPendingMessages,
  _getQueue,
} from './index.js';
import { runContainerAgent } from './container-runner.js';
import { Channel } from './types.js';

// --- Helpers ---

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main Group',
  folder: 'main',
  trigger: '',
  added_at: '2024-01-01T00:00:00.000Z',
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other Group',
  folder: 'other-group',
  trigger: '@Juniper',
  added_at: '2024-01-01T00:00:00.000Z',
  requiresTrigger: true,
};

const NO_TRIGGER_GROUP: RegisteredGroup = {
  name: 'No Trigger Group',
  folder: 'no-trigger',
  trigger: '',
  added_at: '2024-01-01T00:00:00.000Z',
  requiresTrigger: false,
};

function makeMessage(overrides: Partial<NewMessage> & { id: string; chat_jid: string; timestamp: string }): NewMessage {
  return {
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content: 'hello',
    ...overrides,
  };
}

function storeTestMessage(msg: NewMessage): void {
  storeMessage(msg);
}

function createMockChannel(prefix: string): Channel {
  return {
    name: `mock-${prefix}`,
    connect: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => jid.startsWith(prefix) || jid.endsWith('@g.us')),
    disconnect: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
    prefixAssistantName: true,
  };
}

// --- Test setup ---

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
  _setLastAgentTimestamp({});
  _setSessions({});
  _setChannels([]);
  vi.clearAllMocks();
});

// =========================================================================
// getAvailableGroups
// =========================================================================

describe('getAvailableGroups', () => {
  it('returns groups ordered by most recent activity', () => {
    // Store chats with different timestamps
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:01.000Z', 'Group 1');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:03.000Z', 'Group 2');
    storeChatMetadata('group3@g.us', '2024-01-01T00:00:02.000Z', 'Group 3');

    const groups = getAvailableGroups();

    expect(groups).toHaveLength(3);
    // Most recent first
    expect(groups[0].jid).toBe('group2@g.us');
    expect(groups[1].jid).toBe('group3@g.us');
    expect(groups[2].jid).toBe('group1@g.us');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:01.000Z', 'Group 1');
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:05.000Z');

    const groups = getAvailableGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group1@g.us');
  });

  it('marks registered groups as isRegistered: true', () => {
    storeChatMetadata('reg@g.us', '2024-01-01T00:00:01.000Z', 'Registered');
    storeChatMetadata('unreg@g.us', '2024-01-01T00:00:02.000Z', 'Unregistered');

    _setRegisteredGroups({
      'reg@g.us': MAIN_GROUP,
    });

    const groups = getAvailableGroups();

    const registered = groups.find((g) => g.jid === 'reg@g.us');
    const unregistered = groups.find((g) => g.jid === 'unreg@g.us');

    expect(registered?.isRegistered).toBe(true);
    expect(unregistered?.isRegistered).toBe(false);
  });

  it('includes WhatsApp (@g.us) JIDs', () => {
    storeChatMetadata('chat@g.us', '2024-01-01T00:00:01.000Z', 'WA Group');

    const groups = getAvailableGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('chat@g.us');
  });

  it('includes Telegram (tg:) JIDs', () => {
    storeChatMetadata('tg:-100123456', '2024-01-01T00:00:01.000Z', 'TG Group');

    const groups = getAvailableGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('tg:-100123456');
  });

  it('excludes individual chat JIDs (non-group, non-telegram)', () => {
    storeChatMetadata('user@s.whatsapp.net', '2024-01-01T00:00:01.000Z', 'User');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:02.000Z', 'Group');

    const groups = getAvailableGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });

  it('includes lastActivity from chat metadata', () => {
    storeChatMetadata('group@g.us', '2024-06-15T12:30:00.000Z', 'Group');

    const groups = getAvailableGroups();

    expect(groups[0].lastActivity).toBe('2024-06-15T12:30:00.000Z');
  });
});

// =========================================================================
// registerGroup
// =========================================================================

describe('registerGroup', () => {
  it('adds group to registeredGroups', () => {
    _registerGroup('new@g.us', {
      name: 'New Group',
      folder: 'new-group',
      trigger: '@Juniper',
      added_at: '2024-06-01T00:00:00.000Z',
    });

    // Verify via getAvailableGroups which reads registeredGroups
    storeChatMetadata('new@g.us', '2024-06-01T00:00:00.000Z', 'New Group');
    const groups = getAvailableGroups();
    expect(groups[0].isRegistered).toBe(true);
  });

  it('persists group to database via setRegisteredGroup', () => {
    _registerGroup('persist@g.us', {
      name: 'Persist Group',
      folder: 'persist-group',
      trigger: '@Juniper',
      added_at: '2024-06-01T00:00:00.000Z',
    });

    // Re-initialize registeredGroups from DB to confirm persistence
    // The DB call happens inside registerGroup via setRegisteredGroup
    // We can verify by checking the DB directly
    const dbGroups = getAllRegisteredGroups();
    expect(dbGroups['persist@g.us']).toBeDefined();
    expect(dbGroups['persist@g.us'].name).toBe('Persist Group');
    expect(dbGroups['persist@g.us'].folder).toBe('persist-group');
  });

  it('calls fs.mkdirSync to create group folder with logs subdirectory', () => {
    const mkdirSpy = vi.mocked(fs.mkdirSync);
    mkdirSpy.mockClear();

    _registerGroup('dir@g.us', {
      name: 'Dir Group',
      folder: 'dir-group',
      trigger: '@Juniper',
      added_at: '2024-06-01T00:00:00.000Z',
    });

    // Check that mkdirSync was called with a path containing the group folder
    const calls = mkdirSpy.mock.calls;
    const groupDirCall = calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('dir-group') && call[0].includes('logs'),
    );
    expect(groupDirCall).toBeDefined();
    expect(groupDirCall![1]).toEqual({ recursive: true });
  });
});

// =========================================================================
// processGroupMessages
// =========================================================================

describe('processGroupMessages', () => {
  let mockChannel: Channel;

  beforeEach(() => {
    mockChannel = createMockChannel('');
    _setChannels([mockChannel]);
  });

  it('returns true for unregistered group (no-op)', async () => {
    const result = await _processGroupMessages('unknown@g.us');
    expect(result).toBe(true);
    expect(runContainerAgent).not.toHaveBeenCalled();
  });

  it('returns true when no pending messages exist', async () => {
    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    // No messages stored, so getMessagesSince returns empty

    const result = await _processGroupMessages('group@g.us');
    expect(result).toBe(true);
    expect(runContainerAgent).not.toHaveBeenCalled();
  });

  it('main group processes all messages without trigger', async () => {
    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));
    storeTestMessage(makeMessage({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      content: 'another message',
      timestamp: '2024-01-01T00:00:02.000Z',
    }));

    const result = await _processGroupMessages('group@g.us');

    expect(result).toBe(true);
    expect(runContainerAgent).toHaveBeenCalledTimes(1);
  });

  it('non-main group with requiresTrigger skips messages without trigger', async () => {
    _setRegisteredGroups({ 'other@g.us': OTHER_GROUP });
    storeChatMetadata('other@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'other@g.us',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    const result = await _processGroupMessages('other@g.us');

    expect(result).toBe(true);
    expect(runContainerAgent).not.toHaveBeenCalled();
  });

  it('non-main group processes when trigger IS present', async () => {
    _setRegisteredGroups({ 'other@g.us': OTHER_GROUP });
    storeChatMetadata('other@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'other@g.us',
      content: 'some context message',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));
    storeTestMessage(makeMessage({
      id: 'msg-2',
      chat_jid: 'other@g.us',
      content: '@Juniper help me with something',
      timestamp: '2024-01-01T00:00:02.000Z',
    }));

    const result = await _processGroupMessages('other@g.us');

    expect(result).toBe(true);
    expect(runContainerAgent).toHaveBeenCalledTimes(1);
  });

  it('non-main group with requiresTrigger: false processes all messages', async () => {
    _setRegisteredGroups({ 'notrig@g.us': NO_TRIGGER_GROUP });
    storeChatMetadata('notrig@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'notrig@g.us',
      content: 'no trigger needed',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    const result = await _processGroupMessages('notrig@g.us');

    expect(result).toBe(true);
    expect(runContainerAgent).toHaveBeenCalledTimes(1);
  });

  it('advances lastAgentTimestamp cursor after successful processing', async () => {
    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello',
      timestamp: '2024-01-01T00:00:05.000Z',
    }));

    await _processGroupMessages('group@g.us');

    const ts = _getLastAgentTimestamp();
    expect(ts['group@g.us']).toBe('2024-01-01T00:00:05.000Z');
  });

  it('rolls back cursor on agent error when no output was sent', async () => {
    vi.mocked(runContainerAgent).mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'container failed',
    });

    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    _setLastAgentTimestamp({ 'group@g.us': '2024-01-01T00:00:00.000Z' });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello',
      timestamp: '2024-01-01T00:00:05.000Z',
    }));

    const result = await _processGroupMessages('group@g.us');

    expect(result).toBe(false);
    // Cursor should be rolled back to the previous value
    const ts = _getLastAgentTimestamp();
    expect(ts['group@g.us']).toBe('2024-01-01T00:00:00.000Z');
  });

  it('does NOT roll back cursor on agent error when output was already sent', async () => {
    // Simulate runContainerAgent calling the streaming callback with a result
    // then returning an error status
    vi.mocked(runContainerAgent).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        // Simulate sending output to the user
        if (onOutput) {
          await onOutput({ status: 'success', result: 'Here is the answer' });
        }
        return { status: 'error', result: null, error: 'late error' };
      },
    );

    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    _setLastAgentTimestamp({ 'group@g.us': '2024-01-01T00:00:00.000Z' });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello',
      timestamp: '2024-01-01T00:00:05.000Z',
    }));

    const result = await _processGroupMessages('group@g.us');

    // Should return true because output was sent (no rollback)
    expect(result).toBe(true);
    // Cursor should NOT be rolled back
    const ts = _getLastAgentTimestamp();
    expect(ts['group@g.us']).toBe('2024-01-01T00:00:05.000Z');
  });

  it('sets typing indicator on and off around agent invocation', async () => {
    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    await _processGroupMessages('group@g.us');

    const setTyping = vi.mocked(mockChannel.setTyping!);
    // setTyping should have been called with true (start) and false (stop)
    expect(setTyping).toHaveBeenCalledWith('group@g.us', true);
    expect(setTyping).toHaveBeenCalledWith('group@g.us', false);
  });

  it('sends formatted agent output to channel', async () => {
    vi.mocked(runContainerAgent).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        if (onOutput) {
          await onOutput({ status: 'success', result: 'Agent reply text' });
        }
        return { status: 'success', result: null };
      },
    );

    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    await _processGroupMessages('group@g.us');

    const sendMessage = vi.mocked(mockChannel.sendMessage);
    expect(sendMessage).toHaveBeenCalledWith('group@g.us', expect.stringContaining('Agent reply text'));
  });

  it('strips <internal> tags from agent output before sending', async () => {
    vi.mocked(runContainerAgent).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: '<internal>thinking...</internal>Visible reply',
          });
        }
        return { status: 'success', result: null };
      },
    );

    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    await _processGroupMessages('group@g.us');

    const sendMessage = vi.mocked(mockChannel.sendMessage);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sentText = sendMessage.mock.calls[0][1];
    expect(sentText).not.toContain('<internal>');
    expect(sentText).toContain('Visible reply');
  });

  it('does not send message when agent output is only internal tags', async () => {
    vi.mocked(runContainerAgent).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: '<internal>only internal thoughts</internal>',
          });
        }
        return { status: 'success', result: null };
      },
    );

    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    await _processGroupMessages('group@g.us');

    const sendMessage = vi.mocked(mockChannel.sendMessage);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('only processes messages since last agent timestamp (not all time)', async () => {
    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    _setLastAgentTimestamp({ 'group@g.us': '2024-01-01T00:00:02.000Z' });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    // This message is before the cursor, should be skipped
    storeTestMessage(makeMessage({
      id: 'msg-old',
      chat_jid: 'group@g.us',
      content: 'old message',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    // This message is after the cursor, should be processed
    storeTestMessage(makeMessage({
      id: 'msg-new',
      chat_jid: 'group@g.us',
      content: 'new message',
      timestamp: '2024-01-01T00:00:03.000Z',
    }));

    await _processGroupMessages('group@g.us');

    expect(runContainerAgent).toHaveBeenCalledTimes(1);
    // Verify the prompt contains only the new message
    const call = vi.mocked(runContainerAgent).mock.calls[0];
    const input = call[1];
    expect(input.prompt).toContain('new message');
    expect(input.prompt).not.toContain('old message');
  });

  it('returns true when no channel matches the JID', async () => {
    // Set up a channel that doesn't own this JID
    const narrowChannel = createMockChannel('tg:');
    vi.mocked(narrowChannel.ownsJid).mockReturnValue(false);
    _setChannels([narrowChannel]);

    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    const result = await _processGroupMessages('group@g.us');

    expect(result).toBe(true);
    expect(runContainerAgent).not.toHaveBeenCalled();
  });
});

// =========================================================================
// recoverPendingMessages
// =========================================================================

describe('recoverPendingMessages', () => {
  it('enqueues groups that have unprocessed messages', () => {
    _setRegisteredGroups({
      'group1@g.us': MAIN_GROUP,
      'group2@g.us': { ...OTHER_GROUP, folder: 'other2' },
    });
    _setLastAgentTimestamp({});

    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    // group1 has a pending message
    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group1@g.us',
      content: 'pending message',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    // Spy on queue.enqueueMessageCheck
    const queue = _getQueue();
    const enqueueSpy = vi.spyOn(queue, 'enqueueMessageCheck');

    _recoverPendingMessages();

    // group1 should be enqueued (has pending messages)
    expect(enqueueSpy).toHaveBeenCalledWith('group1@g.us');
    // group2 should NOT be enqueued (no messages)
    expect(enqueueSpy).not.toHaveBeenCalledWith('group2@g.us');
  });

  it('does not enqueue groups with no unprocessed messages', () => {
    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    _setLastAgentTimestamp({ 'group@g.us': '2024-01-01T00:00:05.000Z' });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    // Only old messages (before the cursor)
    storeTestMessage(makeMessage({
      id: 'msg-old',
      chat_jid: 'group@g.us',
      content: 'already processed',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    const queue = _getQueue();
    const enqueueSpy = vi.spyOn(queue, 'enqueueMessageCheck');

    _recoverPendingMessages();

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('recovers multiple groups with pending messages', () => {
    const group2: RegisteredGroup = {
      name: 'Group 2',
      folder: 'group2',
      trigger: '',
      added_at: '2024-01-01T00:00:00.000Z',
    };

    _setRegisteredGroups({
      'g1@g.us': MAIN_GROUP,
      'g2@g.us': group2,
    });
    _setLastAgentTimestamp({});

    storeChatMetadata('g1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('g2@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-g1',
      chat_jid: 'g1@g.us',
      content: 'pending 1',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    storeTestMessage(makeMessage({
      id: 'msg-g2',
      chat_jid: 'g2@g.us',
      content: 'pending 2',
      timestamp: '2024-01-01T00:00:02.000Z',
    }));

    const queue = _getQueue();
    const enqueueSpy = vi.spyOn(queue, 'enqueueMessageCheck');

    _recoverPendingMessages();

    expect(enqueueSpy).toHaveBeenCalledWith('g1@g.us');
    expect(enqueueSpy).toHaveBeenCalledWith('g2@g.us');
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
  });
});

// =========================================================================
// State persistence (loadState/saveState via processGroupMessages)
// =========================================================================

describe('state persistence', () => {
  it('saves lastAgentTimestamp to DB after processing messages', async () => {
    const mockChannel = createMockChannel('');
    _setChannels([mockChannel]);
    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello',
      timestamp: '2024-01-01T00:00:05.000Z',
    }));

    await _processGroupMessages('group@g.us');

    // Verify the timestamp was persisted to the router_state table
    const savedTs = getRouterState('last_agent_timestamp');
    expect(savedTs).toBeDefined();
    const parsed = JSON.parse(savedTs!);
    expect(parsed['group@g.us']).toBe('2024-01-01T00:00:05.000Z');
  });

  it('rolls back and saves cursor on error', async () => {
    vi.mocked(runContainerAgent).mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'container failed',
    });

    const mockChannel = createMockChannel('');
    _setChannels([mockChannel]);
    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    _setLastAgentTimestamp({ 'group@g.us': '2024-01-01T00:00:00.000Z' });
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello',
      timestamp: '2024-01-01T00:00:05.000Z',
    }));

    await _processGroupMessages('group@g.us');

    // The rolled-back cursor should be saved to DB
    const savedTs = getRouterState('last_agent_timestamp');
    const parsed = JSON.parse(savedTs!);
    expect(parsed['group@g.us']).toBe('2024-01-01T00:00:00.000Z');
  });
});

// =========================================================================
// Trigger pattern matching edge cases
// =========================================================================

describe('trigger pattern edge cases', () => {
  let mockChannel: Channel;

  beforeEach(() => {
    mockChannel = createMockChannel('');
    _setChannels([mockChannel]);
  });

  it('trigger is case-insensitive', async () => {
    _setRegisteredGroups({ 'other@g.us': OTHER_GROUP });
    storeChatMetadata('other@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'other@g.us',
      content: '@juniper help me',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    const result = await _processGroupMessages('other@g.us');

    expect(result).toBe(true);
    expect(runContainerAgent).toHaveBeenCalledTimes(1);
  });

  it('trigger must be at start of message (after trimming)', async () => {
    _setRegisteredGroups({ 'other@g.us': OTHER_GROUP });
    storeChatMetadata('other@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'other@g.us',
      content: 'hey @Juniper help',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    const result = await _processGroupMessages('other@g.us');

    expect(result).toBe(true);
    // No trigger at start = skipped
    expect(runContainerAgent).not.toHaveBeenCalled();
  });

  it('trigger with leading whitespace is trimmed before matching', async () => {
    _setRegisteredGroups({ 'other@g.us': OTHER_GROUP });
    storeChatMetadata('other@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'other@g.us',
      content: '  @Juniper help me',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    const result = await _processGroupMessages('other@g.us');

    expect(result).toBe(true);
    expect(runContainerAgent).toHaveBeenCalledTimes(1);
  });

  it('any message in batch having trigger causes all messages to be processed', async () => {
    _setRegisteredGroups({ 'other@g.us': OTHER_GROUP });
    storeChatMetadata('other@g.us', '2024-01-01T00:00:00.000Z');

    // First message: no trigger
    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'other@g.us',
      content: 'context message without trigger',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    // Second message: has trigger
    storeTestMessage(makeMessage({
      id: 'msg-2',
      chat_jid: 'other@g.us',
      content: '@Juniper respond to this thread',
      timestamp: '2024-01-01T00:00:02.000Z',
    }));

    const result = await _processGroupMessages('other@g.us');

    expect(result).toBe(true);
    expect(runContainerAgent).toHaveBeenCalledTimes(1);
    // Both messages should be in the prompt
    const input = vi.mocked(runContainerAgent).mock.calls[0][1];
    expect(input.prompt).toContain('context message without trigger');
    expect(input.prompt).toContain('@Juniper respond to this thread');
  });
});

// =========================================================================
// runAgent session tracking (via processGroupMessages)
// =========================================================================

describe('session tracking', () => {
  it('updates session when agent returns newSessionId', async () => {
    vi.mocked(runContainerAgent).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: 'reply',
            newSessionId: 'session-abc-123',
          });
        }
        return { status: 'success', result: null, newSessionId: 'session-abc-123' };
      },
    );

    const mockChannel = createMockChannel('');
    _setChannels([mockChannel]);
    _setRegisteredGroups({ 'group@g.us': MAIN_GROUP });
    _setSessions({});
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeTestMessage(makeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    }));

    await _processGroupMessages('group@g.us');

    // The session should be persisted in the sessions DB
    const storedSession = getSession('main');
    expect(storedSession).toBe('session-abc-123');
  });
});
