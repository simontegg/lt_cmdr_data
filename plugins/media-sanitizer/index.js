/**
 * media-sanitizer — OpenClaw plugin
 *
 * Strips large base64 image payloads and raw binary <file> blocks from
 * the session context to prevent context-window overflow.
 *
 * Two hooks:
 *   1. tool_result_persist (sync) — rewrites tool-result messages before
 *      they are appended to the session JSONL on disk.
 *   2. before_agent_start (async) — scrubs the in-memory message array
 *      that is about to be sent to the model, catching anything that
 *      was persisted before this plugin was installed.
 */

const DEFAULT_MAX_BASE64_CHARS = 1000;
const DEFAULT_MAX_FILE_BLOCK_CHARS = 2000;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Regex to match <file …>…</file> blocks that are likely binary junk.
 * Captures: name attribute, mime attribute, and inner content.
 */
const FILE_BLOCK_RE = /<file\s+name="([^"]*?)"\s+mime="([^"]*?)">\n?([\s\S]*?)\n?<\/file>/g;

/**
 * Returns true when a string looks like binary noise rather than
 * readable text (high ratio of non-printable / non-ASCII bytes).
 */
function looksLikeBinary(text) {
  if (!text || text.length < 64) return false;
  const sample = text.slice(0, 4096);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Allow tab, newline, carriage return, and printable ASCII
    if (code === 9 || code === 10 || code === 13) continue;
    if (code >= 32 && code <= 126) continue;
    nonPrintable++;
  }
  return nonPrintable / sample.length > 0.15;
}

/**
 * Sanitize a text string by replacing oversized or binary <file> blocks
 * with a short placeholder.
 */
function sanitizeFileBlocks(text, maxChars) {
  if (typeof text !== "string") return text;
  return text.replace(FILE_BLOCK_RE, (_match, name, mime, content) => {
    const isBinary = looksLikeBinary(content);
    const isOversized = content.length > maxChars;
    if (isBinary || isOversized) {
      const sizeKb = (content.length / 1024).toFixed(0);
      return `<file name="${name}" mime="${mime}">\n[binary content removed — ${sizeKb} KB]\n</file>`;
    }
    return _match;
  });
}

/**
 * Rewrite a content-block array:
 *  - Replace large base64 image blocks with a text placeholder.
 *  - Sanitize text blocks that contain <file> elements.
 *
 * Returns [newBlocks, changed] so callers can skip cloning when nothing changed.
 */
function sanitizeContentBlocks(blocks, maxBase64, maxFileChars) {
  if (!Array.isArray(blocks)) return [blocks, false];
  let changed = false;
  const out = blocks.map((block) => {
    if (!block || typeof block !== "object") return block;

    // ── Image content blocks (base64) ──
    if (block.type === "image" && typeof block.data === "string") {
      if (block.data.length > maxBase64) {
        changed = true;
        const sizeKb = (block.data.length * 0.75 / 1024).toFixed(0);
        return {
          type: "text",
          text: `[image removed — ${sizeKb} KB ${block.mimeType ?? "image"}]`,
        };
      }
    }

    // ── Image URL blocks (Anthropic format) ──
    if (block.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
      if (block.source.data.length > maxBase64) {
        changed = true;
        const sizeKb = (block.source.data.length * 0.75 / 1024).toFixed(0);
        return {
          type: "text",
          text: `[image removed — ${sizeKb} KB ${block.source.media_type ?? "image"}]`,
        };
      }
    }

    // ── Text blocks containing <file> elements ──
    if (block.type === "text" && typeof block.text === "string") {
      const cleaned = sanitizeFileBlocks(block.text, maxFileChars);
      if (cleaned !== block.text) {
        changed = true;
        return { ...block, text: cleaned };
      }
    }

    // ── Tool-result blocks (OpenAI format: content is string) ──
    if (block.type === "tool_result" && typeof block.content === "string") {
      const cleaned = sanitizeFileBlocks(block.content, maxFileChars);
      if (cleaned !== block.content) {
        changed = true;
        return { ...block, content: cleaned };
      }
    }

    return block;
  });
  return [out, changed];
}

// ── Plugin entry point ──────────────────────────────────────────────

export default function register(api) {
  const cfg = api.pluginConfig ?? {};
  const maxBase64 = cfg.maxBase64Chars ?? DEFAULT_MAX_BASE64_CHARS;
  const maxFileChars = cfg.maxFileBlockChars ?? DEFAULT_MAX_FILE_BLOCK_CHARS;

  api.logger.info(
    `[media-sanitizer] active — maxBase64=${maxBase64}, maxFileBlock=${maxFileChars}`
  );

  // ── 1. tool_result_persist — sync, fires before JSONL append ──────
  api.on("tool_result_persist", (event, _ctx) => {
    const msg = event.message;
    if (!msg) return undefined;

    // Content can be a string or an array of blocks
    if (typeof msg.content === "string") {
      const cleaned = sanitizeFileBlocks(msg.content, maxFileChars);
      if (cleaned !== msg.content) {
        api.logger.info(
          `[media-sanitizer] stripped file block from tool result (tool=${event.toolName})`
        );
        return { message: { ...msg, content: cleaned } };
      }
      return undefined;
    }

    if (Array.isArray(msg.content)) {
      const [newBlocks, changed] = sanitizeContentBlocks(
        msg.content,
        maxBase64,
        maxFileChars
      );
      if (changed) {
        api.logger.info(
          `[media-sanitizer] sanitized tool result blocks (tool=${event.toolName})`
        );
        return { message: { ...msg, content: newBlocks } };
      }
    }

    return undefined;
  });

  // ── 2. before_agent_start — scrub in-memory messages ──────────────
  api.on("before_agent_start", (event, _ctx) => {
    const messages = event.messages;
    if (!Array.isArray(messages)) return undefined;

    let totalStripped = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg !== "object") continue;

      // String content (common for user messages)
      if (typeof msg.content === "string") {
        const cleaned = sanitizeFileBlocks(msg.content, maxFileChars);
        if (cleaned !== msg.content) {
          msg.content = cleaned;
          totalStripped++;
        }
        continue;
      }

      // Array content (multimodal messages)
      if (Array.isArray(msg.content)) {
        const [newBlocks, changed] = sanitizeContentBlocks(
          msg.content,
          maxBase64,
          maxFileChars
        );
        if (changed) {
          msg.content = newBlocks;
          totalStripped++;
        }
      }
    }

    if (totalStripped > 0) {
      api.logger.info(
        `[media-sanitizer] scrubbed ${totalStripped} message(s) before agent start`
      );
    }

    return undefined;
  });
}
