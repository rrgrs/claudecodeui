import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ExtendedWebSocket, ClaudeSpawnOptions } from './types/index.js';

interface ActiveProcess {
  process: ChildProcessWithoutNullStreams;
  sessionId: string;
  ws: ExtendedWebSocket;
}

interface ClaudeProcess extends ChildProcessWithoutNullStreams {
  tempImagePaths?: string[];
  tempDir?: string | null;
}

const activeClaudeProcesses = new Map<string, ActiveProcess>(); // Track active processes by session ID

async function spawnClaude(command: string, options: ClaudeSpawnOptions = {}, ws: ExtendedWebSocket): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, permissionMode, images } = options;
    let capturedSessionId = sessionId; // Track session ID throughout the process
    let sessionCreatedSent = false; // Track if we've already sent session-created event
    
    // Use tools settings passed from frontend, or defaults
    const settings = toolsSettings || {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false
    };
    
    // Build Claude CLI command - start with print/resume flags first
    const args: string[] = [];
    
    // Add print flag with command if we have a command
    if (command && command.trim()) {
      args.push('--print', command.trim());
    }
    
    // Use cwd (actual project directory) instead of projectPath (Claude's metadata directory)
    const workingDir = cwd || process.cwd();
    
    // Handle images by saving them to temporary files and passing paths to Claude
    const tempImagePaths: string[] = [];
    let tempDir: string | null = null;
    if (images && images.length > 0) {
      try {
        // Create temp directory in the project directory so Claude can access it
        tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
        await fs.mkdir(tempDir, { recursive: true });
        
        // Save each image to a temp file
        for (const [index, image] of images.entries()) {
          // Extract base64 data and mime type
          const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
          if (!matches) {
            console.error('Invalid image data format');
            continue;
          }
          
          const [, mimeType, base64Data] = matches;
          const extension = mimeType.split('/')[1] || 'png';
          const filename = `image_${index}.${extension}`;
          const filepath = path.join(tempDir, filename);
          
          // Write base64 data to file
          await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
          tempImagePaths.push(filepath);
        }
        
        // Include the full image paths in the prompt for Claude to reference
        if (tempImagePaths.length > 0 && command && command.trim()) {
          const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
          const modifiedCommand = command + imageNote;
          
          // Update the command in args
          const printIndex = args.indexOf('--print');
          if (printIndex !== -1) {
            args[printIndex + 1] = modifiedCommand;
          }
        }
        
      } catch (error) {
        console.error('Error processing images for Claude:', error);
      }
    }
    
    // Add resume flag if resuming
    if (resume && sessionId) {
      args.push('--resume', sessionId);
    }
    
    // Add basic flags
    args.push('--output-format', 'stream-json', '--verbose');
    
    // Add MCP config flag only if MCP servers are configured
    try {
      console.log('🔍 Starting MCP config check...');
      // Use already imported modules (fs.promises is imported as fs, path, os)
      const fsSync = await import('fs'); // Import synchronous fs methods
      console.log('✅ Successfully imported fs sync methods');
      
      // Check for MCP config in ~/.claude.json
      const claudeConfigPath = path.join(os.homedir(), '.claude.json');
      
      console.log(`🔍 Checking for MCP configs in: ${claudeConfigPath}`);
      console.log(`  Claude config exists: ${fsSync.existsSync(claudeConfigPath)}`);
      
      if (fsSync.existsSync(claudeConfigPath)) {
        const config = JSON.parse(await fs.readFile(claudeConfigPath, 'utf8'));
        console.log('📄 Found Claude config:', JSON.stringify(config, null, 2));
        
        // Only add flag if MCP servers are actually configured
        if (config['mcp-servers'] && Object.keys(config['mcp-servers']).length > 0) {
          console.log('✅ MCP servers configured, adding --config flag');
          args.push('--config', claudeConfigPath);
        } else {
          console.log('⚠️ No MCP servers found in config, skipping --config flag');
        }
      } else {
        console.log('⚠️ Claude config file not found, skipping --config flag');
      }
    } catch (error) {
      console.error('⚠️ Error checking MCP config, skipping --config flag:', error);
    }
    
    // Add permission mode
    if (permissionMode) {
      args.push('--permission-mode', permissionMode);
    } else if (settings.skipPermissions) {
      args.push('--permission-mode', 'allow');
    }
    
    // Add allowed/disallowed tools
    if (settings.allowedTools.length > 0) {
      args.push('--allowed-tools', settings.allowedTools.join(','));
    }
    if (settings.disallowedTools.length > 0) {
      args.push('--disallowed-tools', settings.disallowedTools.join(','));
    }
    
    console.log('🚀 Spawning Claude with args:', args);
    console.log('📂 Working directory:', cwd);
    
    const claudeProcess = spawn('claude', args, {
      cwd: cwd,
      env: { ...process.env },
      shell: false
    }) as ClaudeProcess;
    
    // Store temp paths on the process for cleanup
    claudeProcess.tempImagePaths = tempImagePaths;
    claudeProcess.tempDir = tempDir;
    
    // Kill any existing process for this session
    if (capturedSessionId && activeClaudeProcesses.has(capturedSessionId)) {
      const existing = activeClaudeProcesses.get(capturedSessionId);
      if (existing) {
        console.log(`Killing existing Claude process for session ${capturedSessionId}`);
        existing.process.kill();
        activeClaudeProcesses.delete(capturedSessionId);
      }
    }
    
    let outputBuffer = '';
    let errorBuffer = '';
    let currentJsonBuffer = '';
    
    claudeProcess.stdout.on('data', (data) => {
      outputBuffer += data.toString();
      currentJsonBuffer += data.toString();
      
      // Try to parse complete JSON objects from the buffer
      const lines = currentJsonBuffer.split('\n');
      currentJsonBuffer = '';
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // If this is the last line and it's not empty, keep it in the buffer
        if (i === lines.length - 1 && line !== '') {
          currentJsonBuffer = line;
          continue;
        }
        
        if (line === '') continue;
        
        try {
          const output = JSON.parse(line);
          
          // Capture session ID from any output that contains it
          if (output.session_id && !capturedSessionId) {
            capturedSessionId = output.session_id;
            console.log('🔑 Captured session ID from output:', capturedSessionId);
            
            // Store the process with its session ID
            activeClaudeProcesses.set(capturedSessionId!, {
              process: claudeProcess,
              sessionId: capturedSessionId!,
              ws
            });
            
            // Send session-created event if we haven't already
            if (!sessionCreatedSent) {
              ws.send(JSON.stringify({
                type: 'session-created',
                sessionId: capturedSessionId
              }));
              sessionCreatedSent = true;
            }
          }
          
          // Send the output to the WebSocket
          ws.send(JSON.stringify({
            type: 'claude-response',
            data: output
          }));
        } catch (e) {
          // Not valid JSON, might be partial output
          console.error('Failed to parse Claude output line:', line);
        }
      }
    });

    claudeProcess.stderr.on('data', (data) => {
      errorBuffer += data.toString();
      console.error('Claude stderr:', data.toString());
      
      // Check for specific error patterns
      const errorString = data.toString();
      if (errorString.includes('not found') || errorString.includes('command not found')) {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Claude CLI not found. Please install it first: npm install -g @anthropic-ai/claude-cli'
        }));
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          error: errorString
        }));
      }
    });

    claudeProcess.on('close', async (code) => {
      console.log(`Claude process exited with code ${code}`);
      
      // Clean up temp directory if it was created
      if (claudeProcess.tempDir) {
        try {
          await fs.rm(claudeProcess.tempDir, { recursive: true, force: true });
          console.log('🧹 Cleaned up temp image directory');
        } catch (error) {
          console.error('Error cleaning up temp directory:', error);
        }
      }
      
      // Remove from active processes
      if (capturedSessionId) {
        activeClaudeProcesses.delete(capturedSessionId);
      }
      
      // Send claude-complete event (frontend expects this)
      ws.send(JSON.stringify({
        type: 'claude-complete',
        exitCode: code,
        isNewSession: !sessionId && !!command // Flag to indicate this was a new session
      }));
      
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Claude process exited with code ${code}`));
      }
    });

    claudeProcess.on('error', (error) => {
      console.error('Failed to start Claude process:', error);
      
      // Clean up temp directory if it was created
      if (claudeProcess.tempDir) {
        fs.rm(claudeProcess.tempDir, { recursive: true, force: true }).catch(err => 
          console.error('Error cleaning up temp directory:', err)
        );
      }
      
      // Remove from active processes
      if (capturedSessionId) {
        activeClaudeProcesses.delete(capturedSessionId);
      }
      
      if ((error as any).code === 'ENOENT') {
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Claude CLI not found. Please install it first: npm install -g @anthropic-ai/claude-cli'
        }));
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          error: error.message
        }));
      }
      reject(error);
    });

    // If command is provided, close stdin (non-interactive mode)
    if (command && command.trim()) {
      claudeProcess.stdin.end();
    } else {
      // If no command provided, stdin stays open for interactive use
    }
  });
}

function abortClaudeSession(sessionId: string): boolean {
  const process = activeClaudeProcesses.get(sessionId);
  if (process) {
    console.log(`🛑 Aborting Claude session: ${sessionId}`);
    process.process.kill('SIGTERM');
    activeClaudeProcesses.delete(sessionId);
    return true;
  }
  return false;
}

export {
  spawnClaude,
  abortClaudeSession
};