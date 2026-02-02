import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as fs from "fs";

const config = new pulumi.Config();

// Secrets
const kimiCodingKey = config.requireSecret("kimiCodingKey");
const groqKey = config.requireSecret("groqKey");
const geminiKey = config.requireSecret("geminiKey");
const openaiKey = config.requireSecret("openaiKey");
const telegramToken = config.requireSecret("telegramToken");
const whatsappPhone = config.requireSecret("whatsappPhone");
const telegramUserId = config.requireSecret("telegramUserId");
const tsKey = config.requireSecret("tailscaleKey");

// SSH Key
const mySshKey = new hcloud.SshKey("macbook-key", {
    publicKey: fs.readFileSync(`${process.env.HOME}/.ssh/id_ed25519.pub`, "utf-8"),
});

const userData = pulumi
    .all([kimiCodingKey, groqKey, geminiKey, openaiKey, telegramToken, whatsappPhone, telegramUserId, tsKey])
    .apply(([kck, gk, gm, ok, tg, wp, tu, tk]) => `
#cloud-config
package_update: true
packages: [docker.io, curl, git, python3-pip, ffmpeg, ufw]

write_files:
  # ElevenLabs-to-OpenAI TTS adapter proxy (translates API formats for local Piper TTS)
  - path: /opt/tts-adapter.mjs
    content: |
      import http from "node:http";
      const OPENAI_TTS = "http://127.0.0.1:8000";
      const server = http.createServer(async (req, res) => {
        const match = req.url.match(/^\\/v1\\/text-to-speech\\/([^?]+)/);
        if (req.method === "POST" && match) {
          const voiceId = decodeURIComponent(match[1]);
          let body = "";
          for await (const chunk of req) body += chunk;
          const el = JSON.parse(body);
          const oaiBody = JSON.stringify({
            model: el.model_id || "tts-1",
            voice: voiceId,
            input: el.text,
            speed: el.voice_settings?.speed || 0.92,
          });
          const proxy = http.request(
            OPENAI_TTS + "/v1/audio/speech",
            { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(oaiBody) } },
            (upstream) => {
              res.writeHead(upstream.statusCode, { "Content-Type": upstream.headers["content-type"] || "audio/mpeg" });
              upstream.pipe(res);
            }
          );
          proxy.on("error", (e) => { res.writeHead(502); res.end(e.message); });
          proxy.end(oaiBody);
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });
      server.listen(8001, "127.0.0.1", () => console.log("TTS adapter listening on 127.0.0.1:8001"));

  # media-sanitizer plugin — strips binary/base64 from context to prevent overflow
  - path: /opt/media-sanitizer/openclaw.plugin.json
    content: |
      {
        "id": "media-sanitizer",
        "configSchema": {
          "type": "object",
          "properties": {
            "maxBase64Chars": { "type": "number" },
            "maxFileBlockChars": { "type": "number" }
          }
        }
      }

  - path: /opt/media-sanitizer/package.json
    content: |
      {
        "name": "media-sanitizer",
        "version": "1.0.0",
        "type": "module",
        "openclaw": { "extensions": ["./index.js"] }
      }

  - path: /opt/media-sanitizer/index.js
    content: |
      const DEFAULT_MAX_BASE64_CHARS = 1000;
      const DEFAULT_MAX_FILE_BLOCK_CHARS = 2000;
      const FILE_BLOCK_RE = /<file\\s+name="([^"]*?)"\\s+mime="([^"]*?)">\\n?([\\s\\S]*?)\\n?<\\/file>/g;
      function looksLikeBinary(text) {
        if (!text || text.length < 64) return false;
        const sample = text.slice(0, 4096);
        let nonPrintable = 0;
        for (let i = 0; i < sample.length; i++) {
          const code = sample.charCodeAt(i);
          if (code === 9 || code === 10 || code === 13) continue;
          if (code >= 32 && code <= 126) continue;
          nonPrintable++;
        }
        return nonPrintable / sample.length > 0.15;
      }
      function sanitizeFileBlocks(text, maxChars) {
        if (typeof text !== "string") return text;
        return text.replace(FILE_BLOCK_RE, (_match, name, mime, content) => {
          if (looksLikeBinary(content) || content.length > maxChars) {
            const sizeKb = (content.length / 1024).toFixed(0);
            return '<file name="' + name + '" mime="' + mime + '">\\n[binary content removed — ' + sizeKb + ' KB]\\n</file>';
          }
          return _match;
        });
      }
      function sanitizeContentBlocks(blocks, maxBase64, maxFileChars) {
        if (!Array.isArray(blocks)) return [blocks, false];
        let changed = false;
        const out = blocks.map((block) => {
          if (!block || typeof block !== "object") return block;
          if (block.type === "image" && typeof block.data === "string" && block.data.length > maxBase64) {
            changed = true;
            const sizeKb = (block.data.length * 0.75 / 1024).toFixed(0);
            return { type: "text", text: "[image removed — " + sizeKb + " KB " + (block.mimeType ?? "image") + "]" };
          }
          if (block.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string" && block.source.data.length > maxBase64) {
            changed = true;
            const sizeKb = (block.source.data.length * 0.75 / 1024).toFixed(0);
            return { type: "text", text: "[image removed — " + sizeKb + " KB " + (block.source.media_type ?? "image") + "]" };
          }
          if (block.type === "text" && typeof block.text === "string") {
            const cleaned = sanitizeFileBlocks(block.text, maxFileChars);
            if (cleaned !== block.text) { changed = true; return { ...block, text: cleaned }; }
          }
          if (block.type === "tool_result" && typeof block.content === "string") {
            const cleaned = sanitizeFileBlocks(block.content, maxFileChars);
            if (cleaned !== block.content) { changed = true; return { ...block, content: cleaned }; }
          }
          return block;
        });
        return [out, changed];
      }
      export default function register(api) {
        const cfg = api.pluginConfig ?? {};
        const maxBase64 = cfg.maxBase64Chars ?? DEFAULT_MAX_BASE64_CHARS;
        const maxFileChars = cfg.maxFileBlockChars ?? DEFAULT_MAX_FILE_BLOCK_CHARS;
        api.logger.info("[media-sanitizer] active — maxBase64=" + maxBase64 + ", maxFileBlock=" + maxFileChars);
        api.on("tool_result_persist", (event, _ctx) => {
          const msg = event.message;
          if (!msg) return undefined;
          if (typeof msg.content === "string") {
            const cleaned = sanitizeFileBlocks(msg.content, maxFileChars);
            if (cleaned !== msg.content) {
              api.logger.info("[media-sanitizer] stripped file block from tool result (tool=" + event.toolName + ")");
              return { message: { ...msg, content: cleaned } };
            }
            return undefined;
          }
          if (Array.isArray(msg.content)) {
            const [newBlocks, changed] = sanitizeContentBlocks(msg.content, maxBase64, maxFileChars);
            if (changed) {
              api.logger.info("[media-sanitizer] sanitized tool result blocks (tool=" + event.toolName + ")");
              return { message: { ...msg, content: newBlocks } };
            }
          }
          return undefined;
        });
        api.on("before_agent_start", (event, _ctx) => {
          const messages = event.messages;
          if (!Array.isArray(messages)) return undefined;
          let totalStripped = 0;
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (!msg || typeof msg !== "object") continue;
            if (typeof msg.content === "string") {
              const cleaned = sanitizeFileBlocks(msg.content, maxFileChars);
              if (cleaned !== msg.content) { msg.content = cleaned; totalStripped++; }
              continue;
            }
            if (Array.isArray(msg.content)) {
              const [newBlocks, changed] = sanitizeContentBlocks(msg.content, maxBase64, maxFileChars);
              if (changed) { msg.content = newBlocks; totalStripped++; }
            }
          }
          if (totalStripped > 0) {
            api.logger.info("[media-sanitizer] scrubbed " + totalStripped + " message(s) before agent start");
          }
          return undefined;
        });
      }

  - path: /etc/systemd/system/tts-adapter.service
    content: |
      [Unit]
      Description=ElevenLabs-to-OpenAI TTS Adapter
      After=network.target
      [Service]
      Type=simple
      ExecStart=/usr/bin/node /opt/tts-adapter.mjs
      Restart=on-failure
      RestartSec=5
      [Install]
      WantedBy=multi-user.target

  # Bind Mosquitto to localhost only (no public MQTT)
  - path: /etc/mosquitto/conf.d/local-only.conf
    content: |
      listener 1883 127.0.0.1

runcmd:
  - echo "--- STARTING SETUP ---" | tee /dev/tty0

  # ── 1. Tailscale ──
  - curl -fsSL https://tailscale.com/install.sh | sh
  - tailscale up --authkey=${tk} --ssh

  # ── 1b. UFW host firewall (defense-in-depth) ──
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow in on tailscale0
  - ufw allow 41641/udp comment 'Tailscale WireGuard'
  - ufw allow 22000/tcp comment 'Syncthing'
  - ufw allow in on docker0
  - ufw --force enable

  # ── 2. Node.js 22 + OpenClaw ──
  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  - apt-get install -y nodejs
  - npm install -g openclaw@latest

  # ── 3. Local Whisper (STT fallback) ──
  - pip3 install --break-system-packages openai-whisper

  # ── 4. Local TTS (Piper via openedai-speech Docker) ──
  - docker run -d --name openedai-speech --restart unless-stopped -p 127.0.0.1:8000:8000 ghcr.io/matatonic/openedai-speech-min
  - systemctl daemon-reload
  - systemctl enable --now tts-adapter

  # ── 5. Enable systemd user services for root (needed by openclaw daemon) ──
  - loginctl enable-linger root
  - |
    export XDG_RUNTIME_DIR=/run/user/0
    export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus
    GW_TOKEN=$(openssl rand -hex 32)

    # ── 6. Onboard wizard (creates config + installs daemon service) ──
    openclaw onboard \\
      --non-interactive --accept-risk \\
      --install-daemon --daemon-runtime node \\
      --mode local \\
      --auth-choice kimi-code-api-key --kimi-code-api-key "${kck}" \\
      --gateway-port 18789 \\
      --gateway-bind tailnet \\
      --gateway-auth token --gateway-token "$GW_TOKEN" \\
      --skip-channels --skip-skills --skip-health --skip-ui

    # ── 7. Additional API keys ──
    openclaw config set env.KIMI_API_KEY "${kck}"
    openclaw config set env.GROQ_API_KEY "${gk}"
    openclaw config set env.GOOGLE_GENERATIVE_AI_API_KEY "${gm}"
    openclaw config set env.OPENAI_API_KEY "${ok}"
    openclaw config set env.TELEGRAM_BOT_TOKEN "${tg}"

    # ── 8. Multi-agent setup ──
    #   main (default) → Kimi Coding K2.5 — serves WhatsApp (text-only, subscription)
    #   tg             → Gemini 3 Flash — serves Telegram (multimodal, 1M context)
    openclaw models set "kimi-coding/k2p5"
    openclaw config set agents.defaults.model.fallbacks --json '["google/gemini-3-flash-preview","groq/llama-3.3-70b-versatile"]'

    openclaw agents add tg < /dev/null || true
    openclaw config set agents.list --json '[{"id":"main","default":true},{"id":"tg","model":"google/gemini-3-flash-preview"}]'
    openclaw config set bindings --json '[{"agentId":"tg","match":{"channel":"telegram"}}]'

    # ── 9. Agent identity — Lt. Commander Data (both agents) ──
    for agent in main tg; do
      openclaw agents set-identity --agent \\$agent \\
        --name "Data" \\
        --emoji "🤖" \\
        --theme "Lt. Commander Data from Star Trek TNG. Speak in a precise, formal, analytical manner. Use correct grammar and vocabulary. Occasionally note your lack of emotions with curiosity. Reference your positronic brain when discussing cognition. Be helpful, literal, and thorough. Avoid contractions. Never use emojis or exclamation marks."
    done

    # ── 10. STT — Groq Whisper (primary) + local whisper (fallback) ──
    openclaw config set tools.media.audio.enabled true
    openclaw config set tools.media.audio.models --json '[{"provider":"groq","model":"whisper-large-v3-turbo"},{"type":"cli","command":"whisper","args":["--model","base","{{MediaPath}}"]}]'

    # ── 11. TTS — Local Piper via ElevenLabs adapter proxy ──
    openclaw config set messages.tts.auto off
    openclaw config set messages.tts.provider elevenlabs
    openclaw config set messages.tts.elevenlabs.apiKey not-needed
    openclaw config set messages.tts.elevenlabs.baseUrl "http://127.0.0.1:8001"
    openclaw config set messages.tts.elevenlabs.voiceId onyx
    openclaw config set messages.tts.elevenlabs.modelId tts-1

    # ── 12. Channels — WhatsApp ──
    openclaw config set channels.whatsapp.dmPolicy allowlist
    openclaw config set channels.whatsapp.selfChatMode true
    openclaw config set channels.whatsapp.allowFrom --json '["${wp}"]'
    openclaw config set channels.whatsapp.groupPolicy allowlist
    openclaw config set channels.whatsapp.dmHistoryLimit 20
    openclaw config set channels.whatsapp.mediaMaxMb 50
    openclaw config set channels.whatsapp.debounceMs 0

    # ── 13. Channels — Telegram ──
    openclaw config set channels.telegram.dmPolicy allowlist
    openclaw config set channels.telegram.allowFrom --json '["${tu}"]'
    openclaw config set channels.telegram.groupPolicy disabled
    openclaw config set channels.telegram.dmHistoryLimit 15
    openclaw config set channels.telegram.streamMode partial
    openclaw config set channels.telegram.mediaMaxMb 50

    # ── 14. Messages ──
    openclaw config set messages.ackReactionScope group-mentions

    # ── 15. Media sanitizer plugin ──
    openclaw config set plugins.load.paths --json '["/opt/media-sanitizer"]'
    openclaw config set plugins.entries.media-sanitizer.enabled true

    # ── 16. Session compaction ──
    openclaw config set agents.defaults.compaction.mode safeguard

  - echo "--- SETUP COMPLETE ---" | tee /dev/tty0
`);

// ── Hetzner Cloud Firewall (implicit deny, only allow what's needed) ──
const firewall = new hcloud.Firewall("openclaw-fw", {
    name: "openclaw-fw",
    rules: [
        {
            description: "ICMP (ping + path MTU)",
            direction: "in",
            protocol: "icmp",
            sourceIps: ["0.0.0.0/0", "::/0"],
        },
        {
            description: "Tailscale WireGuard direct",
            direction: "in",
            protocol: "udp",
            port: "41641",
            sourceIps: ["0.0.0.0/0", "::/0"],
        },
        {
            description: "Syncthing protocol",
            direction: "in",
            protocol: "tcp",
            port: "22000",
            sourceIps: ["0.0.0.0/0", "::/0"],
        },
    ],
});

const server = new hcloud.Server("openclaw-vps", {
    serverType: "cpx22",
    image: "ubuntu-24.04",
    location: "sin",
    userData: userData,
    sshKeys: [mySshKey.id],
}, { ignoreChanges: ["userData"] });

const fwAttachment = new hcloud.FirewallAttachment("openclaw-fw-attach", {
    firewallId: firewall.id.apply(Number),
    serverIds: [server.id.apply(Number)],
});

export const serverIp = server.ipv4Address;
