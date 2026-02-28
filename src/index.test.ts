import { describe, it, expect, vi } from 'vitest';

import type { ContainerOutput } from './container-runner.js';
import { createStreamingHandler } from './index.js';

describe('createStreamingHandler', () => {
  function makeDeps(overrides: Partial<Parameters<typeof createStreamingHandler>[0]> = {}) {
    return {
      channel: {
        sendMessage: vi.fn(async () => {}),
        setTyping: vi.fn(async () => {}),
      },
      chatJid: 'tg:12345',
      groupName: 'test-group',
      resetIdleTimer: vi.fn(),
      notifyIdle: vi.fn(),
      ...overrides,
    };
  }

  it('clears typing indicator after sending a message', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      channel: {
        sendMessage: vi.fn(async () => { calls.push('sendMessage'); }),
        setTyping: vi.fn(async () => { calls.push('setTyping'); }),
      },
    });

    const { handler } = createStreamingHandler(deps);
    await handler({ result: 'Hello!', status: 'success' } as ContainerOutput);

    expect(deps.channel.setTyping).toHaveBeenCalledWith('tg:12345', false);
    // setTyping(false) must come AFTER sendMessage
    expect(calls).toEqual(['sendMessage', 'setTyping']);
  });

  it('does not call setTyping when result text is empty after stripping internals', async () => {
    const deps = makeDeps();
    const { handler } = createStreamingHandler(deps);
    await handler({ result: '<internal>thinking</internal>', status: 'success' } as ContainerOutput);

    expect(deps.channel.sendMessage).not.toHaveBeenCalled();
    expect(deps.channel.setTyping).not.toHaveBeenCalled();
  });

  it('tracks outputSentToUser state', async () => {
    const deps = makeDeps();
    const { handler, state } = createStreamingHandler(deps);

    expect(state().outputSentToUser).toBe(false);
    await handler({ result: 'Hello', status: 'success' } as ContainerOutput);
    expect(state().outputSentToUser).toBe(true);
  });

  it('tracks hadError state', async () => {
    const deps = makeDeps();
    const { handler, state } = createStreamingHandler(deps);

    expect(state().hadError).toBe(false);
    await handler({ result: null, status: 'error', error: 'boom' } as ContainerOutput);
    expect(state().hadError).toBe(true);
  });

  it('calls notifyIdle on success status', async () => {
    const deps = makeDeps();
    const { handler } = createStreamingHandler(deps);
    await handler({ result: null, status: 'success' } as ContainerOutput);

    expect(deps.notifyIdle).toHaveBeenCalled();
  });

  it('calls resetIdleTimer when result is present', async () => {
    const deps = makeDeps();
    const { handler } = createStreamingHandler(deps);
    await handler({ result: 'Hi', status: 'success' } as ContainerOutput);

    expect(deps.resetIdleTimer).toHaveBeenCalled();
  });

  it('stringifies non-string results', async () => {
    const deps = makeDeps();
    const { handler } = createStreamingHandler(deps);
    await handler({ result: { key: 'value' }, status: 'success' } as any);

    expect(deps.channel.sendMessage).toHaveBeenCalledWith(
      'tg:12345',
      '{"key":"value"}',
    );
  });
});
