import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';

import { GroupQueue } from './group-queue.js';
import { ChildProcess } from 'child_process';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- closeStdin() when state.active is false (email loop bug) ---

  describe('closeStdin when not active', () => {
    it('does NOT write _close sentinel when group was never activated via runForGroup', () => {
      // The email loop calls runAgent directly (not through the queue),
      // so state.active is never set to true. registerProcess alone
      // does not flip the active flag.
      const fakeProc = { killed: false } as unknown as ChildProcess;
      queue.registerProcess('group1@g.us', fakeProc, 'ctr-1', 'my-group');

      queue.closeStdin('group1@g.us');

      // _close file should NOT be written because state.active is false
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('writes _close sentinel when group IS active', async () => {
      let resolveProcessing: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcessing = resolve;
        });
        return true;
      });

      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      // While active, register process with groupFolder
      const fakeProc = { killed: false } as unknown as ChildProcess;
      queue.registerProcess('group1@g.us', fakeProc, 'ctr-1', 'my-group');

      queue.closeStdin('group1@g.us');

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        '/tmp/nanoclaw-test-data/ipc/my-group/input',
        { recursive: true },
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/nanoclaw-test-data/ipc/my-group/input/_close',
        '',
      );

      // Release so the test cleans up
      resolveProcessing!();
      await vi.advanceTimersByTimeAsync(10);
    });
  });

  // --- sendMessage() piping to active container ---

  describe('sendMessage', () => {
    it('writes a JSON file to the IPC input directory when group is active', async () => {
      let resolveProcessing: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcessing = resolve;
        });
        return true;
      });

      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      // Register process with groupFolder while active
      const fakeProc = { killed: false } as unknown as ChildProcess;
      queue.registerProcess('group1@g.us', fakeProc, 'ctr-1', 'test-folder');

      const result = queue.sendMessage('group1@g.us', 'Hello there');

      expect(result).toBe(true);
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        '/tmp/nanoclaw-test-data/ipc/test-folder/input',
        { recursive: true },
      );
      // writeFileSync is called with a .tmp path and JSON content
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.json.tmp'),
        JSON.stringify({ type: 'message', text: 'Hello there' }),
      );
      // renameSync moves the .tmp to .json (atomic write)
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('.json.tmp'),
        expect.stringContaining('.json'),
      );

      resolveProcessing!();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('returns false when group is NOT active', () => {
      const result = queue.sendMessage('group1@g.us', 'Hello');

      expect(result).toBe(false);
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('returns false when group is active but has no groupFolder', async () => {
      let resolveProcessing: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcessing = resolve;
        });
        return true;
      });

      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      // Register without groupFolder
      const fakeProc = { killed: false } as unknown as ChildProcess;
      queue.registerProcess('group1@g.us', fakeProc, 'ctr-1');

      const result = queue.sendMessage('group1@g.us', 'Hello');

      expect(result).toBe(false);

      resolveProcessing!();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('writes JSON with correct message structure', async () => {
      let resolveProcessing: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcessing = resolve;
        });
        return true;
      });

      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      const fakeProc = { killed: false } as unknown as ChildProcess;
      queue.registerProcess('group1@g.us', fakeProc, 'ctr-1', 'msg-group');

      queue.sendMessage('group1@g.us', 'Test message content');

      // Verify the JSON payload has the expected shape
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(
        (call) => typeof call[1] === 'string' && call[1].includes('message'),
      );
      expect(writeCall).toBeDefined();
      const parsed = JSON.parse(writeCall![1] as string);
      expect(parsed).toEqual({ type: 'message', text: 'Test message content' });

      resolveProcessing!();
      await vi.advanceTimersByTimeAsync(10);
    });
  });

  // --- registerProcess() tracking ---

  describe('registerProcess', () => {
    it('stores process and container name on group state', async () => {
      let resolveProcessing: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcessing = resolve;
        });
        return true;
      });

      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      const fakeProc = { killed: false } as unknown as ChildProcess;
      queue.registerProcess('group1@g.us', fakeProc, 'ctr-abc', 'folder-1');

      // sendMessage succeeds because process and groupFolder are registered
      const result = queue.sendMessage('group1@g.us', 'ping');
      expect(result).toBe(true);

      resolveProcessing!();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('sets groupFolder when provided', async () => {
      let resolveProcessing: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcessing = resolve;
        });
        return true;
      });

      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      const fakeProc = { killed: false } as unknown as ChildProcess;
      queue.registerProcess('group1@g.us', fakeProc, 'ctr-1', 'custom-folder');

      queue.sendMessage('group1@g.us', 'test');

      // Verify the groupFolder was used in the IPC path
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        '/tmp/nanoclaw-test-data/ipc/custom-folder/input',
        { recursive: true },
      );

      resolveProcessing!();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('does not set groupFolder when not provided', async () => {
      let resolveProcessing: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcessing = resolve;
        });
        return true;
      });

      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      const fakeProc = { killed: false } as unknown as ChildProcess;
      queue.registerProcess('group1@g.us', fakeProc, 'ctr-1');

      // sendMessage returns false because groupFolder is null
      const result = queue.sendMessage('group1@g.us', 'test');
      expect(result).toBe(false);

      resolveProcessing!();
      await vi.advanceTimersByTimeAsync(10);
    });
  });

  // --- closeStdin() writes _close sentinel ---

  describe('closeStdin sentinel writing', () => {
    it('creates _close file in the correct IPC input directory', async () => {
      let resolveProcessing: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcessing = resolve;
        });
        return true;
      });

      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      const fakeProc = { killed: false } as unknown as ChildProcess;
      queue.registerProcess('group1@g.us', fakeProc, 'ctr-1', 'sentinel-group');

      queue.closeStdin('group1@g.us');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/nanoclaw-test-data/ipc/sentinel-group/input/_close',
        '',
      );

      resolveProcessing!();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('creates directory recursively before writing _close', async () => {
      let resolveProcessing: () => void;

      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProcessing = resolve;
        });
        return true;
      });

      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(10);

      const fakeProc = { killed: false } as unknown as ChildProcess;
      queue.registerProcess('group1@g.us', fakeProc, 'ctr-1', 'dir-test');

      queue.closeStdin('group1@g.us');

      // mkdirSync is called before writeFileSync, with recursive: true
      const mkdirCall = vi.mocked(fs.mkdirSync).mock.invocationCallOrder[0];
      const writeCall = vi.mocked(fs.writeFileSync).mock.invocationCallOrder[0];
      expect(mkdirCall).toBeLessThan(writeCall);
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        '/tmp/nanoclaw-test-data/ipc/dir-test/input',
        { recursive: true },
      );

      resolveProcessing!();
      await vi.advanceTimersByTimeAsync(10);
    });

    it('does nothing for an unknown group', () => {
      queue.closeStdin('unknown@g.us');

      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });
});
