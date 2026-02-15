import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { StreamState } from './main.js';

// Mock @actions/core
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
}));

// Mock @actions/http-client with a class-based mock
const mockPostJson = vi.fn();
vi.mock('@actions/http-client', () => {
  return {
    HttpClient: class {
      postJson = mockPostJson;
    },
  };
});

import * as core from '@actions/core';
import { run, processSSEEvent, parseSSELines, streamTaskOutput } from './main.js';

function makeStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

describe('parseSSELines', () => {
  function freshState(): StreamState {
    return { outputBuffer: '', status: 'unknown', error: null, costUsd: undefined };
  }

  it('extracts event type and data from complete SSE lines', () => {
    const state = freshState();
    const buffer = 'event: stdout\ndata: {"data":"hello"}\n\n';
    const remainder = parseSSELines(buffer, state);

    expect(state.outputBuffer).toBe('hello');
    expect(remainder).toBe('');
  });

  it('returns incomplete data as remainder', () => {
    const state = freshState();
    const buffer = 'event: stdout\ndata: {"data":"hello"}\npartial';
    const remainder = parseSSELines(buffer, state);

    expect(state.outputBuffer).toBe('hello');
    expect(remainder).toBe('partial');
  });

  it('handles multiple events in a single buffer', () => {
    const state = freshState();
    const buffer =
      'event: stdout\ndata: {"data":"line1"}\nevent: stdout\ndata: {"data":"line2"}\n';
    parseSSELines(buffer, state);

    expect(state.outputBuffer).toBe('line1line2');
  });

  it('handles empty buffer', () => {
    const state = freshState();
    const remainder = parseSSELines('', state);

    expect(remainder).toBe('');
    expect(state.outputBuffer).toBe('');
  });

  it('ignores lines that are not event or data prefixed', () => {
    const state = freshState();
    const buffer = ':comment\nid: 123\nevent: stdout\ndata: {"data":"ok"}\n';
    parseSSELines(buffer, state);

    expect(state.outputBuffer).toBe('ok');
  });
});

describe('processSSEEvent', () => {
  function freshState(): StreamState {
    return { outputBuffer: '', status: 'unknown', error: null, costUsd: undefined };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles start event with info log', () => {
    const state = freshState();
    processSSEEvent('start', '{}', state);

    expect(core.info).toHaveBeenCalledWith('[Stream] Task execution started');
    expect(state.status).toBe('unknown');
  });

  it('appends stdout data to output buffer', () => {
    const state = freshState();
    processSSEEvent('stdout', '{"data":"hello world"}', state);

    expect(state.outputBuffer).toBe('hello world');
    expect(core.info).toHaveBeenCalledWith('hello world');
  });

  it('logs stderr data as warning', () => {
    const state = freshState();
    processSSEEvent('stderr', '{"data":"warning msg"}', state);

    expect(core.warning).toHaveBeenCalledWith('[stderr] warning msg');
    expect(state.outputBuffer).toBe('');
  });

  it('marks status completed and captures cost on complete event', () => {
    const state = freshState();
    processSSEEvent('complete', '{"costUsd":0.05}', state);

    expect(state.status).toBe('completed');
    expect(state.costUsd).toBe(0.05);
  });

  it('marks status failed and captures error on error event', () => {
    const state = freshState();
    processSSEEvent('error', '{"error":"task crashed"}', state);

    expect(state.status).toBe('failed');
    expect(state.error).toBe('task crashed');
    expect(core.error).toHaveBeenCalledWith('[Stream] Task failed: task crashed');
  });

  it('uses default error message when error field is missing', () => {
    const state = freshState();
    processSSEEvent('error', '{}', state);

    expect(state.error).toBe('Unknown error');
  });

  it('ignores invalid JSON data gracefully', () => {
    const state = freshState();
    processSSEEvent('stdout', 'not-json', state);

    expect(state.outputBuffer).toBe('');
    expect(core.debug).toHaveBeenCalledWith('Failed to parse SSE data: not-json');
  });

  it('logs unknown event types as debug', () => {
    const state = freshState();
    processSSEEvent('custom-event', '{}', state);

    expect(core.debug).toHaveBeenCalledWith('Unknown event type: custom-event');
  });

  it('does not append to buffer when stdout data field is empty', () => {
    const state = freshState();
    processSSEEvent('stdout', '{}', state);

    expect(state.outputBuffer).toBe('');
  });
});

describe('streamTaskOutput', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns completed status when SSE stream sends complete event', async () => {
    const sseBody = makeStreamFromChunks([
      'event: start\ndata: {}\n\n',
      'event: stdout\ndata: {"data":"output text"}\n\n',
      'event: complete\ndata: {"costUsd":0.12}\n\n',
    ]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    });

    const result = await streamTaskOutput('https://api.test/stream', 'test-key', 30000);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('output text');
    expect(result.costUsd).toBe(0.12);
    expect(result.error).toBeNull();
  });

  it('returns failed status when SSE stream sends error event', async () => {
    const sseBody = makeStreamFromChunks([
      'event: error\ndata: {"error":"container crashed"}\n\n',
    ]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    });

    const result = await streamTaskOutput('https://api.test/stream', 'test-key', 30000);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('container crashed');
  });

  it('returns failed status when response is JSON with error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn().mockResolvedValue({ error: 'task not found' }),
      body: makeStreamFromChunks([]),
    });

    const result = await streamTaskOutput('https://api.test/stream', 'test-key', 30000);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('task not found');
  });

  it('returns failed status when response is JSON with nested error object', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn().mockResolvedValue({ error: { message: 'detailed error' } }),
      body: makeStreamFromChunks([]),
    });

    const result = await streamTaskOutput('https://api.test/stream', 'test-key', 30000);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('detailed error');
  });

  it('throws when SSE connection returns non-OK status', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    });

    await expect(
      streamTaskOutput('https://api.test/stream', 'test-key', 30000),
    ).rejects.toThrow('SSE connection failed (401): Unauthorized');
  });

  it('returns timeout status when abort signal fires', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    global.fetch = vi.fn().mockRejectedValue(abortError);

    const result = await streamTaskOutput('https://api.test/stream', 'test-key', 100);

    expect(result.status).toBe('timeout');
    expect(result.error).toContain('timeout');
  });

  it('sends correct authorization and accept headers', async () => {
    const sseBody = makeStreamFromChunks([
      'event: complete\ndata: {}\n\n',
    ]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    });

    await streamTaskOutput('https://api.test/stream', 'my-api-key', 30000);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test/stream',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer my-api-key',
          'Accept': 'text/event-stream',
        }),
      }),
    );
  });

  it('returns unknown status when stream ends without terminal event', async () => {
    const sseBody = makeStreamFromChunks([
      'event: stdout\ndata: {"data":"partial"}\n\n',
    ]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    });

    const result = await streamTaskOutput('https://api.test/stream', 'test-key', 30000);

    expect(result.status).toBe('unknown');
    expect(result.output).toBe('partial');
  });
});

describe('run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_TOKEN;
  });

  function mockInputs(inputs: Record<string, string>): void {
    (core.getInput as Mock).mockImplementation((name: string) => inputs[name] || '');
  }

  function mockSuccessfulSubmission(taskId: string): void {
    mockPostJson.mockResolvedValue({
      statusCode: 200,
      result: { task_id: taskId },
    });
  }

  it('submits task and sets outputs on successful completion', async () => {
    mockInputs({
      'api-key': 'test-api-key',
      'prompt': 'review this code',
      'api-url': 'https://test-api.example.com',
      'timeout': '60',
    });

    mockSuccessfulSubmission('task-123');
    process.env.GITHUB_REPOSITORY = 'owner/repo';

    // Mock global fetch for the SSE stream
    const sseBody = makeStreamFromChunks([
      'event: start\ndata: {}\n\n',
      'event: stdout\ndata: {"data":"review complete"}\n\n',
      'event: complete\ndata: {"costUsd":0.03}\n\n',
    ]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    });

    await run();

    expect(core.setOutput).toHaveBeenCalledWith('task-id', 'task-123');
    expect(core.setOutput).toHaveBeenCalledWith('result', 'completed');
    expect(core.setOutput).toHaveBeenCalledWith('output', 'review complete');
    expect(core.setOutput).toHaveBeenCalledWith('cost-usd', '0.03');
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('calls setFailed when task submission returns error status', async () => {
    mockInputs({
      'api-key': 'test-key',
      'prompt': 'test',
    });

    mockPostJson.mockResolvedValue({
      statusCode: 401,
      result: { error: 'Invalid API key' },
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Task submission failed (401)'),
    );
  });

  it('calls setFailed when API response is missing task_id', async () => {
    mockInputs({
      'api-key': 'test-key',
      'prompt': 'test',
    });

    mockPostJson.mockResolvedValue({
      statusCode: 200,
      result: {},
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith('Invalid response from API: missing task_id');
  });

  it('calls setFailed when task execution reports failure', async () => {
    mockInputs({
      'api-key': 'test-key',
      'prompt': 'test',
      'timeout': '60',
    });

    mockSuccessfulSubmission('task-fail');

    const sseBody = makeStreamFromChunks([
      'event: error\ndata: {"error":"container OOM"}\n\n',
    ]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('Task execution failed: container OOM'),
    );
  });

  it('sanitizes API key from error messages', async () => {
    mockInputs({
      'api-key': 'secret-key-12345',
      'prompt': 'test',
    });

    mockPostJson.mockRejectedValue(
      new Error('Request failed with Bearer secret-key-12345 in header'),
    );

    await run();

    const failedCall = (core.setFailed as Mock).mock.calls[0][0] as string;
    expect(failedCall).not.toContain('secret-key-12345');
    expect(failedCall).toContain('Bearer ***');
  });

  it('uses default API URL when not specified', async () => {
    mockInputs({
      'api-key': 'test-key',
      'prompt': 'test',
    });

    mockSuccessfulSubmission('task-default');

    const sseBody = makeStreamFromChunks([
      'event: complete\ndata: {}\n\n',
    ]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    });

    await run();

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('https://api.vibectl.dev'),
    );
  });

  it('includes repository and github token in submission payload', async () => {
    mockInputs({
      'api-key': 'test-key',
      'prompt': 'review PR',
      'timeout': '60',
    });

    process.env.GITHUB_REPOSITORY = 'vibectl/test-repo';
    process.env.GITHUB_TOKEN = 'ghs_fake_token';

    mockPostJson.mockResolvedValue({
      statusCode: 200,
      result: { task_id: 'task-repo' },
    });

    const sseBody = makeStreamFromChunks([
      'event: complete\ndata: {}\n\n',
    ]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseBody,
    });

    await run();

    const postJsonCall = mockPostJson.mock.calls[0];
    const payload = postJsonCall[1];
    expect(payload.payload.repository).toBe('vibectl/test-repo');
    expect(payload.payload.repo_url).toBe('https://github.com/vibectl/test-repo');
    expect(payload.payload.github_token).toBe('ghs_fake_token');
  });
});
