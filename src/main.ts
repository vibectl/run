import * as core from '@actions/core';
import * as httpm from '@actions/http-client';

/**
 * Result from streaming task output via SSE.
 */
export interface StreamResult {
  status: string;
  output?: string;
  costUsd?: number;
  error?: string | null;
}

/**
 * Response from the task submission API endpoint.
 */
export interface TaskSubmissionResponse {
  task_id?: string;
  error?: string;
}

/**
 * SSE event data payload from the streaming endpoint.
 */
export interface SSEEventData {
  data?: string;
  costUsd?: number;
  error?: string;
}

/**
 * Mutable state accumulated while parsing an SSE stream.
 */
export interface StreamState {
  outputBuffer: string;
  status: string;
  error: string | null;
  costUsd: number | undefined;
}

/**
 * Submit a task to the vibectl API and stream its output via SSE.
 *
 * The action communicates exclusively via the public REST API. The platform
 * executes tasks in ephemeral containers that clone the customer's repository,
 * providing full Claude Code access to the codebase and .claude/ configuration.
 */
export async function run(): Promise<void> {
  try {
    const apiKey = core.getInput('api-key', { required: true });
    const prompt = core.getInput('prompt', { required: true });
    const apiUrl = core.getInput('api-url', { required: false }) || 'https://api.vibectl.dev';
    const timeoutSeconds = parseInt(core.getInput('timeout', { required: false }) || '1800', 10);

    core.info(`Submitting task to vibectl API: ${apiUrl}`);
    core.info(`Timeout: ${timeoutSeconds}s (streaming mode)`);

    const http = new httpm.HttpClient('vibectl-github-action', undefined, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    const repository = process.env.GITHUB_REPOSITORY || '';
    const githubToken = process.env.GITHUB_TOKEN || '';

    const taskSubmission = {
      type: 'exec',
      payload: {
        prompt,
        repository,
        repo_url: repository ? `https://github.com/${repository}` : undefined,
        github_token: githubToken,
      },
      timeout_seconds: timeoutSeconds,
    };

    core.debug(`Task submission payload: ${JSON.stringify(taskSubmission)}`);

    const submitResponse = await http.postJson<TaskSubmissionResponse>(
      `${apiUrl}/v1/tasks`,
      taskSubmission,
    );

    if (submitResponse.statusCode < 200 || submitResponse.statusCode >= 300) {
      const errorBody = submitResponse.result || {};
      throw new Error(
        `Task submission failed (${submitResponse.statusCode}): ${errorBody.error || 'Unknown error'}`,
      );
    }

    const taskData = submitResponse.result;
    if (!taskData?.task_id) {
      throw new Error('Invalid response from API: missing task_id');
    }

    const taskId = taskData.task_id;
    core.info(`Task submitted successfully. Task ID: ${taskId}`);
    core.setOutput('task-id', taskId);

    const startTime = Date.now();

    core.info('Connecting to SSE stream for real-time output...');

    const streamUrl = `${apiUrl}/v1/tasks/${taskId}/stream`;
    const streamResult = await streamTaskOutput(streamUrl, apiKey, timeoutSeconds * 1000);

    const duration = Date.now() - startTime;

    core.setOutput('result', streamResult.status);
    core.setOutput('duration-ms', duration.toString());

    if (streamResult.output) {
      core.setOutput('output', streamResult.output);
    }

    if (streamResult.costUsd !== undefined) {
      core.setOutput('cost-usd', streamResult.costUsd.toString());
    }

    if (streamResult.status === 'failed') {
      core.setFailed(`Task execution failed: ${streamResult.error || 'Unknown error'}`);
    } else {
      core.info(`Task completed successfully in ${duration}ms`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = message.replace(/Bearer\s+[^\s]+/gi, 'Bearer ***');
    core.setFailed(safeMessage);
  }
}

/**
 * Process a single SSE event, updating the stream state and logging to the workflow.
 */
export function processSSEEvent(eventType: string, eventData: string, state: StreamState): void {
  let event: SSEEventData;
  try {
    event = JSON.parse(eventData) as SSEEventData;
  } catch {
    core.debug(`Failed to parse SSE data: ${eventData}`);
    return;
  }

  switch (eventType) {
    case 'start':
      core.info('[Stream] Task execution started');
      break;

    case 'stdout':
      if (event.data) {
        core.info(event.data);
        state.outputBuffer += event.data;
      }
      break;

    case 'stderr':
      if (event.data) {
        core.warning(`[stderr] ${event.data}`);
      }
      break;

    case 'complete':
      state.status = 'completed';
      core.info('[Stream] Task completed');
      if (event.costUsd !== undefined) {
        state.costUsd = event.costUsd;
      }
      break;

    case 'error':
      state.status = 'failed';
      state.error = event.error || 'Unknown error';
      core.error(`[Stream] Task failed: ${state.error}`);
      break;

    default:
      core.debug(`Unknown event type: ${eventType}`);
  }
}

/**
 * Parse complete SSE lines from a buffer, extracting event type and data pairs.
 * Returns any remaining incomplete data left in the buffer.
 */
export function parseSSELines(buffer: string, state: StreamState): string {
  const lines = buffer.split('\n');
  const remainder = lines.pop() || '';

  let eventType = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.substring(7).trim();
    } else if (line.startsWith('data: ')) {
      const eventData = line.substring(6);
      processSSEEvent(eventType, eventData, state);
      eventType = '';
    }
  }

  return remainder;
}

/**
 * Stream task output via the SSE endpoint, returning the final result
 * when a terminal event (complete/error) is received or the timeout expires.
 */
export async function streamTaskOutput(
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<StreamResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const state: StreamState = {
    outputBuffer: '',
    status: 'unknown',
    error: null,
    costUsd: undefined,
  };

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'text/event-stream',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SSE connection failed (${response.status}): ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const jsonResponse = (await response.json()) as { error?: { message?: string } | string };
      if (jsonResponse.error) {
        const errorMsg =
          typeof jsonResponse.error === 'object' ? jsonResponse.error.message : jsonResponse.error;
        return { status: 'failed', error: errorMsg || 'Unknown error' };
      }
    }

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = parseSSELines(buffer, state);

      if (state.status === 'completed' || state.status === 'failed') {
        break;
      }
    }

    clearTimeout(timeoutId);

    return {
      status: state.status,
      output: state.outputBuffer || undefined,
      costUsd: state.costUsd,
      error: state.error,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === 'AbortError') {
      return {
        status: 'timeout',
        error: `Task execution exceeded timeout (${timeoutMs}ms)`,
      };
    }

    throw err;
  }
}
