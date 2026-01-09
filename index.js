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

/**
 * ✅ Deepgram TTS: texto -> WAV buffer
 * Model: aura-asteria-es (español)
 */
async function deepgramTTS(text) {
  const resp = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-asteria-es",
    {
      method: "POST",
      headers: {
        // Deepgram usa Token <key> (NO Bearer)
        "Authorization": `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "audio/wav"
      },
      body: JSON.stringify({ text })
    }
  );

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`Deepgram TTS error ${resp.status}: ${err}`);
  }

  const arrayBuf = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length < 200) throw new Error("Deepgram TTS returned too-small audio buffer");
  return buf;
}

// audio (wav/mp3/etc) -> mulaw 8k raw usando ffmpeg
async function audioToMulaw8kRaw(inputBuffer) {
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
        reject(
          new Error(
            `ffmpeg exit ${code}: ${Buffer.concat(errChunks).toString("utf8").slice(0, 400)}`
          )
        );
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    ff.on("error", reject);

    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

// Enviar audio a Twilio por WS en frames de 20ms (160 bytes @8kHz mulaw)
async function playMulawToTwilio({ twilioWs, streamSid, mulawRaw }) {
  const FRAME_BYTES = 160; // 20ms @ 8kHz mulaw
  let offset = 0;

  while (offset < mulawRaw.length) {
    const frame = mulawRaw.subarray(offset, offset + FRAME_BYTES);
    offset += FRAME_BYTES;

    const payload = frame.toString("base64");
    const msg = { event: "media", streamSid, media: { payload } };

    if (twilioWs.readyState !== 1) break;

    twilioWs.send(JSON.stringify(msg));
    await sleep(20);
  }
}

// OpenAI: texto usuario -> texto respuesta
async function getAIResponse(userText, state) {
  const system = `Eres Lucía, agente de soporte telefónico de Alerta y Control.
Hablas en español, frases cortas, tono humano y profesional.
Haz 1 pregunta por turno.
Si falta información, pregunta.
Si es incidencia crítica, actúa con urgencia.
No digas que eres IA.`;

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

  dg.on(LiveTranscriptionEvents.Open, () => console.log("🟣 Deepgram Live conectado"));
  dg.on(LiveTranscriptionEvents.Error, (e) => console.log("💥 Deepgram error:", e?.message || e));
  dg.on(LiveTranscriptionEvents.Close, () => console.log("🟣 Deepgram Live cerrado"));

  dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const alt = data.channel?.alternatives?.[0];
    const text = (alt?.transcript || "").trim();
    if (!text) return;

    if (data.is_final) {
      state.finalTextBuffer += (state.finalTextBuffer ? " " : "") + text;
      state.lastFinalAt = Date.now();
      console.log("✅ FINAL:", text);
    }

    const now = Date.now();
    const endOfUtterance =
      data.speech_final || (state.finalTextBuffer && now - state.lastFinalAt > 700);

    // barge-in
    if (!data.is_final && state.isSpeaking && state.streamSid) {
      try { twilioWs.send(JSON.stringify({ event: "clear", streamSid: state.streamSid })); } catch {}
      state.isSpeaking = false;
    }

    if (!endOfUtterance || !state.finalTextBuffer) return;

    const userUtterance = state.finalTextBuffer;
    state.finalTextBuffer = "";
    console.log("🧠 TURNO USUARIO:", userUtterance);

    if (state.isSpeaking) return;
    state.isSpeaking = true;

    try {
      console.log("➡️ Llamando a OpenAI...");
      const aiText = await getAIResponse(userUtterance, state);
      console.log("✅ OpenAI OK:", aiText);

      console.log("➡️ Llamando a Deepgram TTS...");
      const wav = await deepgramTTS(aiText);
      console.log("✅ Deepgram TTS OK, bytes:", wav.length);

      console.log("➡️ Transcodificando con ffmpeg...");
      const mulaw = await audioToMulaw8kRaw(wav);
      console.log("✅ ffmpeg OK, bytes:", mulaw.length);

      console.log("➡️ Enviando audio a Twilio...");
      if (!state.streamSid) throw new Error("No streamSid disponible para reproducir audio");
      await playMulawToTwilio({ twilioWs, streamSid: state.streamSid, mulawRaw: mulaw });
      console.log("✅ Audio enviado a Twilio");
    } catch (e) {
      console.log("💥 Error respondiendo (mensaje):", e?.message || e);
      if (e?.stack) console.log("💥 Stack:", e.stack.split("\n").slice(0, 6).join("\n"));
    } finally {
      state.isSpeaking = false;
    }
  });

  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === "start") {
      state.streamSid = data?.start?.streamSid || null;
      console.log("📞 start:", state.streamSid);
      return;
    }

    if (data.event === "media") {
      const payload = data?.media?.payload;
      if (!payload) return;
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

  twilioWs.on("error", (err) => console.log("💥 WS error:", err?.message || err));
});

server.listen(PORT, () => console.log("✅ Server up on", PORT));