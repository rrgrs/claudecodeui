import { query, type SDKMessage, type Options, type Query } from '@anthropic-ai/claude-code';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ExtendedWebSocket, ClaudeSpawnOptions } from './types/index.js';

interface ActiveSession {
  query: Query;
  sessionId: string;
  ws: ExtendedWebSocket;
  abortController: AbortController;
}

const activeSessions = new Map<string, ActiveSession>(); // Track active sessions by session ID

async function startClaudeSession(command: string, options: ClaudeSpawnOptions = {}, ws: ExtendedWebSocket): Promise<void> {
  const { sessionId, projectPath, cwd, resume, toolsSettings, permissionMode, images } = options;
  let capturedSessionId = sessionId || generateSessionId();
  let sessionCreatedSent = false;
  let systemMessageSent = false;
  
  // Use tools settings passed from frontend, or defaults
  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };
  
  // Use cwd (actual project directory) instead of projectPath (Claude's metadata directory)
  const workingDir = cwd || process.cwd();
  
  // Handle images by including them in the prompt
  let enhancedPrompt = command;
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
        enhancedPrompt = command + imageNote;
      }
    } catch (error) {
      console.error('Error processing images for Claude:', error);
    }
  }
  
  // Create abort controller for this session
  const abortController = new AbortController();
  
  // Kill any existing session
  if (activeSessions.has(capturedSessionId)) {
    const existing = activeSessions.get(capturedSessionId);
    if (existing) {
      console.log(`Aborting existing Claude session ${capturedSessionId}`);
      existing.abortController.abort();
      activeSessions.delete(capturedSessionId);
    }
  }
  
  try {
    // Prepare SDK options
    const sdkOptions: Options = {
      abortController,
      cwd: workingDir,
      permissionMode: (permissionMode as any) || (settings.skipPermissions ? 'bypassPermissions' : 'default'),
      allowedTools: settings.allowedTools,
      disallowedTools: settings.disallowedTools,
      continue: false,
      resume: resume && sessionId ? sessionId : undefined,
      stderr: (data: string) => {
        console.error('Claude stderr:', data);
        ws.send(JSON.stringify({
          type: 'error',
          error: data
        }));
      }
    };
    
    // Add MCP servers configuration if available
    try {
      const claudeConfigPath = path.join(os.homedir(), '.claude.json');
      if (await fs.access(claudeConfigPath).then(() => true).catch(() => false)) {
        const config = JSON.parse(await fs.readFile(claudeConfigPath, 'utf8'));
        if (config['mcp-servers'] && Object.keys(config['mcp-servers']).length > 0) {
          sdkOptions.mcpServers = config['mcp-servers'];
          console.log('✅ MCP servers configured from .claude.json');
        }
      }
    } catch (error) {
      console.log('⚠️ Could not load MCP config:', error);
    }
    
    console.log('🚀 Starting Claude session with SDK');
    console.log('📂 Working directory:', workingDir);
    console.log('💬 Prompt:', enhancedPrompt);
    console.log('🔄 Resume:', resume && sessionId ? sessionId : 'New session');
    
    // Create the query
    const claudeQuery = query({
      prompt: enhancedPrompt,
      abortController,
      options: sdkOptions
    });
    
    // Store active session
    activeSessions.set(capturedSessionId, {
      query: claudeQuery,
      sessionId: capturedSessionId,
      ws,
      abortController
    });
    
    // Process messages from the SDK
    try {
      for await (const message of claudeQuery) {
        console.log('📨 SDK Message:', message.type);
        
        // Handle different message types
        switch (message.type) {
          case 'system':
            if (message.subtype === 'init') {
              // Extract session ID from system init message
              capturedSessionId = message.session_id;
              console.log('🔑 Captured session ID:', capturedSessionId);
              
              // Update stored session with real ID
              const oldSessionId = sessionId || generateSessionId();
              if (oldSessionId !== capturedSessionId) {
                activeSessions.delete(oldSessionId);
                activeSessions.set(capturedSessionId, {
                  query: claudeQuery,
                  sessionId: capturedSessionId,
                  ws,
                  abortController
                });
              }
              
              // Send session-created event
              if (!sessionCreatedSent) {
                ws.send(JSON.stringify({
                  type: 'session-created',
                  sessionId: capturedSessionId
                }));
                sessionCreatedSent = true;
              }
              
              // Send system info as claude-response
              ws.send(JSON.stringify({
                type: 'claude-response',
                data: {
                  type: 'system',
                  subtype: 'init',
                  session_id: capturedSessionId,
                  system_info: {
                    api_key_source: message.apiKeySource,
                    cwd: message.cwd,
                    tools: message.tools,
                    mcp_servers: message.mcp_servers,
                    model: message.model,
                    permission_mode: message.permissionMode
                  }
                }
              }));
              systemMessageSent = true;
            }
            break;
            
          case 'user':
            // Skip forwarding user messages since the frontend already has them
            // The frontend adds the user message when sending, so echoing it back
            // causes duplicate messages and can interfere with message display
            console.log('📤 Skipping user message echo to prevent duplicates');
            break;
            
          case 'assistant':
            // Forward assistant messages with proper format for frontend
            // The SDK message.message is an APIAssistantMessage object
            // but the frontend expects the content directly in data
            ws.send(JSON.stringify({
              type: 'claude-response',
              data: {
                type: 'assistant',
                content: message.message.content, // Extract content from the message
                message: message.message, // Keep full message for compatibility
                session_id: message.session_id
              }
            }));
            break;
            
          case 'result':
            // Handle completion
            console.log('✅ Claude session completed');
            console.log('📊 Usage:', message.usage);
            console.log('💰 Cost:', message.total_cost_usd);
            
            // Send result info
            ws.send(JSON.stringify({
              type: 'claude-response',
              data: {
                type: 'result',
                subtype: message.subtype,
                duration_ms: message.duration_ms,
                total_cost_usd: message.total_cost_usd,
                usage: message.usage,
                result: (message as any).result || undefined
              }
            }));
            break;
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('🛑 Claude session aborted');
      } else {
        console.error('❌ Error during Claude session:', error);
        ws.send(JSON.stringify({
          type: 'error',
          error: error.message
        }));
      }
    }
    
    // Clean up temp directory if it was created
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log('🧹 Cleaned up temp image directory');
      } catch (error) {
        console.error('Error cleaning up temp directory:', error);
      }
    }
    
    // Remove from active sessions
    activeSessions.delete(capturedSessionId);
    
    // Send claude-complete event (frontend expects this)
    ws.send(JSON.stringify({
      type: 'claude-complete',
      exitCode: 0,
      isNewSession: !sessionId && !!command
    }));
    
  } catch (error: any) {
    console.error('Failed to start Claude session:', error);
    
    // Clean up on error
    activeSessions.delete(capturedSessionId);
    
    if (tempDir) {
      fs.rm(tempDir, { recursive: true, force: true }).catch(err => 
        console.error('Error cleaning up temp directory:', err)
      );
    }
    
    ws.send(JSON.stringify({
      type: 'error',
      error: error.message || 'Failed to start Claude session'
    }));
  }
}

function abortClaudeSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (session) {
    console.log(`🛑 Aborting Claude session: ${sessionId}`);
    session.abortController.abort();
    activeSessions.delete(sessionId);
    return true;
  }
  return false;
}

// Helper function to generate a temporary session ID
function generateSessionId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export {
  startClaudeSession as spawnClaude,
  abortClaudeSession
};