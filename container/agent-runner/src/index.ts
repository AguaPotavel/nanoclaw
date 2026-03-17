/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface CodexTurnResult {
  result: string | null;
  newSessionId?: string;
  closedDuringQuery: boolean;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      // ignore
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter(file => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }

    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise(resolve => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }

      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }

      setTimeout(poll, IPC_POLL_MS);
    };

    poll();
  });
}

function loadGlobalMemory(containerInput: ContainerInput): string | undefined {
  const globalMemoryPath = '/workspace/global/CLAUDE.md';
  if (!containerInput.isMain && fs.existsSync(globalMemoryPath)) {
    return fs.readFileSync(globalMemoryPath, 'utf-8');
  }
  return undefined;
}

function buildPromptWithGlobalMemory(
  prompt: string,
  containerInput: ContainerInput,
): string {
  const globalMemory = loadGlobalMemory(containerInput);
  if (!globalMemory?.trim()) {
    return prompt;
  }

  return [
    'Shared context (from /workspace/global/CLAUDE.md):',
    globalMemory,
    '',
    'User message:',
    prompt,
  ].join('\n');
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    proc.once('error', reject);
    proc.once('close', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim() || `${command} exited with code ${code ?? 1}`,
        ),
      );
    });
  });
}

async function configureMcpServer(containerInput: ContainerInput): Promise<void> {
  const mcpServerPath = '/tmp/dist/ipc-mcp-stdio.js';
  if (!fs.existsSync(mcpServerPath)) {
    throw new Error(`MCP server not found at ${mcpServerPath}`);
  }

  try {
    await runCommand('codex', ['mcp', 'remove', 'nanoclaw'], '/workspace/group');
  } catch {
    // ignore missing prior config
  }

  await runCommand(
    'codex',
    [
      'mcp',
      'add',
      'nanoclaw',
      '--env',
      `NANOCLAW_CHAT_JID=${containerInput.chatJid}`,
      '--env',
      `NANOCLAW_GROUP_FOLDER=${containerInput.groupFolder}`,
      '--env',
      `NANOCLAW_IS_MAIN=${containerInput.isMain ? '1' : '0'}`,
      '--',
      'node',
      mcpServerPath,
    ],
    '/workspace/group',
  );
}

async function runCodexTurn(
  prompt: string,
  sessionId: string | undefined,
): Promise<CodexTurnResult> {
  const outputPath = '/tmp/codex-last-message.txt';
  try {
    fs.unlinkSync(outputPath);
  } catch {
    // ignore
  }

  const model = process.env.CODEX_MODEL?.trim();
  const args: string[] = ['exec'];
  if (sessionId) {
    args.push('resume');
  }
  args.push(
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--color',
    'never',
  );
  if (model) {
    args.push('--model', model);
  }
  args.push('-o', outputPath);
  if (sessionId) {
    args.push(sessionId);
  }
  args.push(prompt);

  log(`Starting Codex turn (${sessionId ? `resume=${sessionId}` : 'new thread'})`);

  const proc = spawn('codex', args, {
    cwd: '/workspace/group',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderr = '';
  const errors: string[] = [];
  let newSessionId = sessionId;
  let closedDuringQuery = false;

  const processJsonLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) return;

    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        thread_id?: string;
        message?: string;
      };
      if (event.type === 'thread.started' && event.thread_id) {
        newSessionId = event.thread_id;
      }
      if (event.type === 'error' && event.message) {
        errors.push(event.message);
      }
    } catch {
      // ignore malformed lines
    }
  };

  proc.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      processJsonLine(line);
    }
  });

  proc.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  const closeWatcher = setInterval(() => {
    if (shouldClose()) {
      closedDuringQuery = true;
      proc.kill('SIGTERM');
    }
  }, IPC_POLL_MS);

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', code => resolve(code ?? 1));
  });

  clearInterval(closeWatcher);

  if (stdoutBuffer.trim()) {
    processJsonLine(stdoutBuffer);
  }

  if (closedDuringQuery) {
    log('Close sentinel detected during Codex turn, terminating');
    return {
      result: null,
      newSessionId,
      closedDuringQuery: true,
    };
  }

  let result: string | null = null;
  if (fs.existsSync(outputPath)) {
    const content = fs.readFileSync(outputPath, 'utf-8').trim();
    result = content || null;
  }

  if (exitCode !== 0) {
    const details = [errors.join(' | '), stderr.trim()]
      .filter(Boolean)
      .join(' | ');
    throw new Error(details || `Codex exited with code ${exitCode}`);
  }

  return {
    result,
    newSessionId,
    closedDuringQuery: false,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      // ignore
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore
  }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  try {
    await configureMcpServer(containerInput);

    while (true) {
      const codexPrompt = buildPromptWithGlobalMemory(prompt, containerInput);
      const result = await runCodexTurn(codexPrompt, sessionId);

      if (result.newSessionId) {
        sessionId = result.newSessionId;
      }

      writeOutput({
        status: 'success',
        result: result.result,
        newSessionId: sessionId,
      });

      if (result.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
