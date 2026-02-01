import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as fs from "fs";

const config = new pulumi.Config();

// Secrets
const kimiKey = config.requireSecret("kimiKey");
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
    .all([kimiKey, groqKey, geminiKey, openaiKey, telegramToken, whatsappPhone, telegramUserId, tsKey])
    .apply(([kk, gk, gm, ok, tg, wp, tu, tk]) => `
#cloud-config
package_update: true
packages: [docker.io, curl, git, python3-pip, ffmpeg]

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

runcmd:
  - echo "--- STARTING SETUP ---" | tee /dev/tty0

  # ── 1. Tailscale ──
  - curl -fsSL https://tailscale.com/install.sh | sh
  - tailscale up --authkey=${tk} --ssh

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
      --auth-choice moonshot-api-key --moonshot-api-key "${kk}" \\
      --gateway-port 18789 \\
      --gateway-bind tailnet \\
      --gateway-auth token --gateway-token "$GW_TOKEN" \\
      --skip-channels --skip-skills --skip-health --skip-ui

    # ── 7. Additional API keys ──
    openclaw config set env.GROQ_API_KEY "${gk}"
    openclaw config set env.GOOGLE_GENERATIVE_AI_API_KEY "${gm}"
    openclaw config set env.OPENAI_API_KEY "${ok}"
    openclaw config set env.TELEGRAM_BOT_TOKEN "${tg}"

    # ── 8. Model cascade: Kimi K2.5 → Gemini 2.0 Flash → Groq Llama 3.3 ──
    openclaw models set "moonshot/kimi-k2.5"
    openclaw config set agents.defaults.model.fallbacks --json '["google/gemini-2.0-flash","groq/llama-3.3-70b-versatile"]'

    # ── 9. Agent identity — Lt. Commander Data ──
    openclaw agents set-identity --agent main \\
      --name "Data" \\
      --emoji "🤖" \\
      --theme "Lt. Commander Data from Star Trek TNG. Speak in a precise, formal, analytical manner. Use correct grammar and vocabulary. Occasionally note your lack of emotions with curiosity. Reference your positronic brain when discussing cognition. Be helpful, literal, and thorough. Avoid contractions. Never use emojis or exclamation marks."

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
    openclaw config set channels.telegram.streamMode partial
    openclaw config set channels.telegram.mediaMaxMb 50

    # ── 14. Messages ──
    openclaw config set messages.ackReactionScope group-mentions

    # ── 15. Session compaction ──
    openclaw config set agents.defaults.compaction.mode safeguard

  - echo "--- SETUP COMPLETE ---" | tee /dev/tty0
`);

const server = new hcloud.Server("openclaw-vps", {
    serverType: "cpx22",
    image: "ubuntu-24.04",
    datacenter: "sin-dc1",
    userData: userData,
    sshKeys: [mySshKey.id],
});

export const serverIp = server.ipv4Address;
