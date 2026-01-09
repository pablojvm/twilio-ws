import http from "http";
import { WebSocketServer } from "ws";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import OpenAI from "openai";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";

const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ✅ OpenAI TTS: texto -> MP3 buffer
 * Requiere billing/crédito activo para evitar 429
 */
async function openaiTTS(text) {
  const voice = process.env.OPENAI_TTS_VOICE || "alloy"; // prueba: alloy, verse, aria, etc.
  const audio = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice,
    format: "mp3",
    input: text,
  });

  const arrayBuf = await audio.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/*
// (Opcional) Deepgram TTS fallback si OpenAI TTS da 429
async function deepgramTTS(text) {
  const model = process.env.DEEPGRAM_TTS_MODEL || "aura-2-nestor-es";
  const resp = await fetch(
    `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "audio/wav",
      },
      body: JSON.stringify({ text }),
    }
  );

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`Deepgram TTS error ${resp.status}: ${err}`);
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}
*/

// MP3/WAV/whatever -> mulaw 8k raw usando ffmpeg
async function audioToMulaw8kRaw(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "mulaw",
      "-ar", "8000",
      "-ac", "1",
      "pipe:1",
    ]);

    const out = [];
    const err = [];

    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => err.push(d));

    ff.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 500)}`));
      } else {
        resolve(Buffer.concat(out));
      }
    });

    ff.on("error", reject);

    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

// Enviar audio a Twilio en frames de 20ms (160 bytes mulaw@8k)
async function playMulawToTwilio({ ws, streamSid, mulaw }) {
  const FRAME_BYTES = 160;
  let offset = 0;

  while (offset < mulaw.length) {
    if (ws.readyState !== 1) break;

    const frame = mulaw.subarray(offset, offset + FRAME_BYTES);
    offset += FRAME_BYTES;

    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: frame.toString("base64") },
    }));

    await sleep(20);
  }
}

// OpenAI Chat: userText -> texto de Lucía
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
      { role: "user", content: userText },
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "Perdona, ¿me lo repites?";
}

// ===== HTTP + WS =====
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

wss.on("connection", (ws) => {
  console.log("🟢 Twilio conectado en /ws-media");

  const state = {
    streamSid: null,
    isSpeaking: false,
    finalTextBuffer: "",
    lastFinalAt: 0,
    employeeName: null,
    company: null,
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
    vad_events: true,
  });

  dg.on(LiveTranscriptionEvents.Open, () => console.log("🟣 Deepgram STT conectado"));
  dg.on(LiveTranscriptionEvents.Error, (e) => console.log("💥 Deepgram error:", e?.message || e));
  dg.on(LiveTranscriptionEvents.Close, () => console.log("🟣 Deepgram STT cerrado"));

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
    const endOfUtterance = data.speech_final || (state.finalTextBuffer && now - state.lastFinalAt > 700);

    // barge-in (si usuario habla mientras suena)
    if (!data.is_final && state.isSpeaking && state.streamSid) {
      try { ws.send(JSON.stringify({ event: "clear", streamSid: state.streamSid })); } catch {}
      state.isSpeaking = false;
    }

    if (!endOfUtterance || !state.finalTextBuffer) return;
    if (state.isSpeaking) return;

    const userUtterance = state.finalTextBuffer;
    state.finalTextBuffer = "";
    console.log("🧠 TURNO USUARIO:", userUtterance);

    state.isSpeaking = true;

    try {
      if (!state.streamSid) throw new Error("No streamSid disponible");

      console.log("➡️ Llamando a OpenAI (chat)...");
      const aiText = await getAIResponse(userUtterance, state);
      console.log("✅ OpenAI OK:", aiText);

      console.log("➡️ Llamando a OpenAI TTS...");
      const audioBuf = await openaiTTS(aiText);
      console.log("✅ OpenAI TTS OK, bytes:", audioBuf.length);

      console.log("➡️ ffmpeg -> mulaw 8k...");
      const mulaw = await audioToMulaw8kRaw(audioBuf);
      console.log("✅ mulaw OK, bytes:", mulaw.length);

      console.log("➡️ Enviando audio a Twilio...");
      await playMulawToTwilio({ ws, streamSid: state.streamSid, mulaw });
      console.log("✅ Audio enviado");
    } catch (e) {
      // Si vuelve el 429, aquí lo verás claro
      console.log("💥 Error respondiendo:", e?.message || e);

      // Opcional: fallback a Deepgram TTS si OpenAI TTS falla por 429
      // if (String(e?.message || "").includes("429") && state.streamSid) {
      //   try {
      //     console.log("↩️ Fallback: Deepgram TTS...");
      //     const wav = await deepgramTTS("Ahora mismo no puedo hablar, pero te escucho. ¿Puedes repetirlo?");
      //     const mulaw = await audioToMulaw8kRaw(wav);
      //     await playMulawToTwilio({ ws, streamSid: state.streamSid, mulaw });
      //   } catch (e2) {
      //     console.log("💥 Fallback también falló:", e2?.message || e2);
      //   }
      // }
    } finally {
      state.isSpeaking = false;
    }
  });

  ws.on("message", (msg) => {
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
      dg.send(Buffer.from(payload, "base64"));
      return;
    }

    if (data.event === "stop") {
      console.log("🔴 stop");
      try { dg.finish(); } catch {}
      return;
    }
  });

  ws.on("close", () => {
    console.log("❌ WS cerrado");
    try { dg.finish(); } catch {}
  });

  ws.on("error", (err) => console.log("💥 WS error:", err?.message || err));
});

server.listen(PORT, () => console.log("✅ Server up on", PORT));