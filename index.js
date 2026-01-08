import http from "http";
import { WebSocketServer } from "ws";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import OpenAI from "openai";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";

const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ElevenLabs: texto -> mp3 buffer
async function elevenlabsTTS(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4, similarity_boost: 0.75 }
    })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs error ${resp.status}: ${errText}`);
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// mp3 -> mulaw 8k (raw) buffer usando ffmpeg
async function mp3ToMulaw8kRaw(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "mulaw",
      "-ar", "8000",
      "-ac", "1",
      "pipe:1"
    ]);

    const chunks = [];
    const errChunks = [];

    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => errChunks.push(d));

    ff.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(errChunks).toString("utf8")}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    ff.on("error", reject);

    ff.stdin.write(mp3Buffer);
    ff.stdin.end();
  });
}

// Enviar audio a Twilio por WS en frames de 20ms (160 bytes @8kHz mulaw)
async function playMulawToTwilio({ twilioWs, streamSid, mulawRaw }) {
  const FRAME_BYTES = 160; // 20ms
  let offset = 0;

  while (offset < mulawRaw.length) {
    const frame = mulawRaw.subarray(offset, offset + FRAME_BYTES);
    offset += FRAME_BYTES;

    const payload = frame.toString("base64");
    const msg = {
      event: "media",
      streamSid,
      media: { payload }
    };

    // Si la conexión cae, salimos
    if (twilioWs.readyState !== 1) break;

    twilioWs.send(JSON.stringify(msg));

    // pacing: 20ms por frame
    await sleep(20);
  }
}

// OpenAI: texto usuario -> texto respuesta
async function getAIResponse(userText, state) {
  // aquí puedes meter tu “estilo Lucía” y reglas de call center
  const system = `Eres Lucía, agente de soporte telefónico de Alerta y Control.
Hablas en español, frases cortas, tono humano y profesional.
Haz 1 pregunta por turno.
Si falta información, pregunta.
Si es incidencia crítica, actúa con urgencia.
No digas que eres IA.`;

  // Estado mínimo (puedes ampliarlo y meter n8n)
  const context = `Estado:
- Empleado: ${state.employeeName || "no identificado"}
- Empresa: ${state.company || "desconocida"}
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "system", content: context },
      { role: "user", content: userText }
    ]
  });

  return resp.choices?.[0]?.message?.content?.trim() || "Perdona, ¿me lo repites?";
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws-media") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (twilioWs) => {
  console.log("🟢 Twilio conectado en /ws-media");

  const state = {
    streamSid: null,
    isSpeaking: false,
    finalTextBuffer: "",
    lastFinalAt: 0
  };

  // Deepgram live (Twilio manda mulaw 8k normalmente)
  const dg = deepgram.listen.live({
    model: "nova-2",
    language: "es",
    smart_format: true,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    interim_results: true,
    endpointing: 200,
    vad_events: true
  });

  dg.on(LiveTranscriptionEvents.Open, () => {
    console.log("🟣 Deepgram Live conectado");
  });

  dg.on(LiveTranscriptionEvents.Error, (e) => {
    console.log("💥 Deepgram error:", e?.message || e);
  });

  dg.on(LiveTranscriptionEvents.Close, () => {
    console.log("🟣 Deepgram Live cerrado");
  });

  // Cuando Deepgram produce texto
  dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const alt = data.channel?.alternatives?.[0];
    const text = (alt?.transcript || "").trim();
    if (!text) return;

    if (data.is_final) {
      state.finalTextBuffer += (state.finalTextBuffer ? " " : "") + text;
      state.lastFinalAt = Date.now();
      console.log("✅ FINAL:", text);
    } else {
      // interim (no respondemos aún)
      // console.log("… interim:", text);
    }

    // Heurística simple de “fin de turno”
    const now = Date.now();
    const endOfUtterance = data.speech_final || (state.finalTextBuffer && now - state.lastFinalAt > 700);

    // Si ya está hablando Lucía y el usuario vuelve a hablar -> barge-in: cortamos audio
    // (esto no es perfecto pero ayuda)
    if (!data.is_final && state.isSpeaking && state.streamSid) {
      try {
        twilioWs.send(JSON.stringify({ event: "clear", streamSid: state.streamSid }));
      } catch {}
      state.isSpeaking = false;
    }

    if (!endOfUtterance || !state.finalTextBuffer) return;

    // Cogemos el turno del usuario
    const userUtterance = state.finalTextBuffer;
    state.finalTextBuffer = "";
    console.log("🧠 TURNO USUARIO:", userUtterance);

    // Evitar solapamiento de respuestas
    if (state.isSpeaking) return;

    state.isSpeaking = true;
    try {
      // 1) IA -> texto
      const aiText = await getAIResponse(userUtterance, state);
      console.log("🤖 IA:", aiText);

      // 2) TTS -> mp3
      const mp3 = await elevenlabsTTS(aiText);

      // 3) mp3 -> mulaw raw 8k
      const mulaw = await mp3ToMulaw8kRaw(mp3);

      // 4) reproducir en la llamada
      if (state.streamSid) {
        await playMulawToTwilio({ twilioWs, streamSid: state.streamSid, mulawRaw: mulaw });
      }
    } catch (e) {
      console.log("💥 Error respondiendo:", e?.message || e);
    } finally {
      state.isSpeaking = false;
    }
  });

  twilioWs.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      state.streamSid = data?.start?.streamSid || null;
      console.log("📞 start:", state.streamSid);
      return;
    }

    if (data.event === "media") {
      const payload = data?.media?.payload;
      if (!payload) return;

      // audio mulaw base64 -> buffer -> Deepgram
      const audio = Buffer.from(payload, "base64");
      dg.send(audio);
      return;
    }

    if (data.event === "stop") {
      console.log("🔴 stop");
      try { dg.finish(); } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("❌ WS cerrado");
    try { dg.finish(); } catch {}
  });

  twilioWs.on("error", (err) => {
    console.log("💥 WS error:", err?.message || err);
  });
});

server.listen(PORT, () => {
  console.log("✅ Server up on", PORT);
});
