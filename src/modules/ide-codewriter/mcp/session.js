import { createLogger } from '../logger.js';
import { normalizeRelPath } from '../util/paths.js';

const log = createLogger('mcp-session');

/** Sessions with no activity for this long are dropped. */
const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;

/**
 * Per-connection memory for an MCP client.
 *
 * The single most important thing tracked here is **which revision of which
 * file this client has actually read**. That fact is what turns "please re-read
 * the file before editing it" from a polite request in a prompt into something
 * the server can verify and refuse.
 *
 * The failure this prevents is specific and common. A model reads `app.js`,
 * makes an edit, the user then edits the same file in the editor, and the model
 * — working from what it remembers rather than what is on disk — writes back a
 * "full file" that silently reverts the user's work. Because every write must
 * quote a `baseRevision` that matches both the current content *and* something
 * this session has seen, that write is rejected with an instruction to re-read.
 */
export class McpSession {
  constructor(key, { userId, clientId, clientName }, readRevisions = new Map()) {
    this.key = key;
    this.userId = userId;
    this.clientId = clientId;
    this.clientName = clientName;
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();

    /** `workspaceId\npath` -> revision string this authenticated MCP client has been shown.
     *
     * ChatGPT can create a fresh Streamable HTTP transport for each tool call.
     * The registry therefore supplies a principal-scoped ledger shared by
     * ephemeral transports belonging to the same authenticated user/client.
     */
    this.readRevisions = readRevisions;

    /** Paths this session has written, for the activity summary. */
    this.writtenPaths = new Set();

    /** Tool call counters, surfaced in the desktop UI. */
    this.toolCalls = new Map();

    /** Change-log sequence this session has caught up to, per workspace. */
    this.changeCursor = new Map();
  }

  touch() {
    this.lastActiveAt = Date.now();
  }

  static readKey(workspaceId, relPath) {
    // Reads can come back from the desktop with a canonicalised slash/path
    // representation while the subsequent write uses the caller spelling.
    // Use one normaliser for the ledger so equivalent safe relative paths map
    // to the same freshness proof.
    const canonicalPath = normalizeRelPath(relPath, 'path');
    return `${String(workspaceId)}\n${canonicalPath}`;
  }

  /** Records that we handed this client the given revision of a file. */
  noteRead(workspaceId, relPath, revision) {
    this.readRevisions.set(McpSession.readKey(workspaceId, relPath), revision);
  }

  /** Records a partial read. A range read must not license a whole-file rewrite. */
  notePartialRead(workspaceId, relPath) {
    this.readRevisions.delete(McpSession.readKey(workspaceId, relPath));
  }

  /** The revision of a file this session last saw in full, or null. */
  lastReadRevision(workspaceId, relPath) {
    return this.readRevisions.get(McpSession.readKey(workspaceId, relPath)) ?? null;
  }

  /** True when this session has read the exact revision currently on disk. */
  hasFreshRead(workspaceId, relPath, currentRevision) {
    return this.lastReadRevision(workspaceId, relPath) === currentRevision;
  }

  noteWrite(workspaceId, relPath, newRevision) {
    // After our own write we know exactly what the file contains, so the write
    // itself counts as a read of the new revision. Forcing a re-read of content
    // the client just authored would be pure ceremony.
    this.noteRead(workspaceId, relPath, newRevision);
    this.writtenPaths.add(`${workspaceId}\n${relPath}`);
  }

  noteDelete(workspaceId, relPath) {
    this.readRevisions.delete(McpSession.readKey(workspaceId, relPath));
  }

  countCall(toolName) {
    this.toolCalls.set(toolName, (this.toolCalls.get(toolName) || 0) + 1);
    this.touch();
  }

  getChangeCursor(workspaceId) {
    return this.changeCursor.get(workspaceId) ?? 0;
  }

  setChangeCursor(workspaceId, seq) {
    this.changeCursor.set(workspaceId, seq);
  }

  toJSON() {
    return {
      key: this.key,
      clientId: this.clientId,
      clientName: this.clientName,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      filesRead: this.readRevisions.size,
      filesWritten: this.writtenPaths.size,
      toolCalls: Object.fromEntries(this.toolCalls)
    };
  }
}

/**
 * All live MCP sessions.
 *
 * Transport sessions remain separate for activity/cursors, but full-read
 * authorization is shared by authenticated user + OAuth client. Some MCP
 * clients (including ChatGPT) create a fresh Streamable HTTP transport for
 * each tool call; tying the ledger to transport identity makes a successful
 * read disappear before the immediately-following write.
 */
export class SessionRegistry {
  constructor() {
    /** @type {Map<string, McpSession>} */
    this.sessions = new Map();
    /** user/client identity -> shared full-read authorization ledger. */
    this.readLedgers = new Map();
    this.sweepTimer = setInterval(() => this.sweep(), 30 * 60 * 1000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  /**
   * @param {string} key
   * @param {{ userId: string, clientId: string, clientName: string }} identity
   * @returns {McpSession}
   */
  static ledgerKey(identity) {
    const userId = String(identity?.userId || '');
    const clientIdentity = String(identity?.clientId || identity?.clientName || 'unknown-client');
    return `${userId}\n${clientIdentity}`;
  }

  get(key, identity) {
    const ledgerKey = SessionRegistry.ledgerKey(identity);
    let ledger = this.readLedgers.get(ledgerKey);
    if (!ledger) {
      ledger = { readRevisions: new Map(), lastActiveAt: Date.now() };
      this.readLedgers.set(ledgerKey, ledger);
    }
    ledger.lastActiveAt = Date.now();

    let session = this.sessions.get(key);
    if (!session) {
      session = new McpSession(key, identity, ledger.readRevisions);
      this.sessions.set(key, session);
      log.info(`New MCP session ${key.slice(0, 12)} for ${identity.clientName}`);
    }
    session.touch();
    return session;
  }

  drop(key) {
    if (this.sessions.delete(key)) {
      log.debug(`Dropped MCP session ${key.slice(0, 12)}`);
    }
  }

  listForUser(userId) {
    return [...this.sessions.values()].filter((s) => s.userId === userId);
  }

  sweep() {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [key, session] of this.sessions) {
      if (session.lastActiveAt < cutoff) this.sessions.delete(key);
    }
    for (const [key, ledger] of this.readLedgers) {
      if (ledger.lastActiveAt < cutoff) this.readLedgers.delete(key);
    }
  }

  stop() {
    clearInterval(this.sweepTimer);
  }
}
