import { WebSocket } from 'ws';
import { Request } from 'express';
import { IncomingMessage } from 'http';
import chokidar from 'chokidar';

// Extend WebSocket with custom properties
export interface ExtendedWebSocket extends WebSocket {
  projectPath?: string;
  sessionId?: string;
}

// Extended Request types
export interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    username: string;
  };
  file?: Express.Multer.File;
  files?: Express.Multer.File[];
}

export interface WebSocketRequest extends IncomingMessage {
  user?: {
    id: number;
    username: string;
  };
}

// Project types
export interface Project {
  name: string;
  displayName?: string;
  actualPath: string;
  fullPath: string;
  sessionCount: number;
  lastModified: number;
  sessions?: Session[];
  sessionMeta?: {
    total: number;
    hasMore: boolean;
  };
}

export interface Session {
  id: string;
  createdAt: number;
  summary: string;
}

// File system types
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  permissions?: string;
  permissionsRwx?: string;
  children?: FileNode[];
}

// Claude CLI types
export interface ClaudeSpawnOptions {
  sessionId?: string;
  projectPath?: string;
  cwd?: string;
  resume?: boolean;
  toolsSettings?: ToolSettings;
  permissionMode?: string;
  images?: Array<{ data: string }>;
}

export interface ToolSettings {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
}

export interface ShellInitOptions {
  projectPath?: string;
  sessionId?: string;
  hasSession?: boolean;
}

// Chokidar watcher type
export type ProjectsWatcher = import('chokidar').FSWatcher | null;

// Database types
export interface User {
  id?: number;
  username: string;
  password?: string;
  created_at?: string;
}

// JWT payload type
export interface JWTPayload {
  userId: number;
  username: string;
  iat?: number;
  exp?: number;
}