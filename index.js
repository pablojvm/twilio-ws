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
 * (Si te vuelve a salir 429, es billing/cuota)
 */
async function openaiTTS(text) {
  const voice = process.env.OPENAI_TTS_VOICE || "alloy";
  const audio = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice,
    format: "mp3",
    input: text,
  });
  const arrayBuf = await audio.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// audio -> mulaw 8k raw (Twilio)
async function audioToMulaw8kRaw(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "mulaw",
      "-ar",
      "8000",
      "-ac",
      "1",
      "pipe:1",
    ]);

    const out = [];
    const err = [];

    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => err.push(d));

    ff.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `ffmpeg exit ${code}: ${Buffer.concat(err)
              .toString("utf8")
              .slice(0, 500)}`
          )
        );
      } else {
        resolve(Buffer.concat(out));
      }
    });

    ff.on("error", reject);
    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

// enviar audio a Twilio en frames de 20ms
async function playMulawToTwilio({ ws, streamSid, mulaw }) {
  const FRAME_BYTES = 160; // 20ms @ 8kHz mulaw
  let offset = 0;

  while (offset < mulaw.length) {
    if (ws.readyState !== 1) break;

    const frame = mulaw.subarray(offset, offset + FRAME_BYTES);
    offset += FRAME_BYTES;

    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: frame.toString("base64") },
      })
    );

    await sleep(20);
  }
}

// === OpenAI Chat (Víctor RRHH) ===
async function getAIResponse(userText, state) {
  const system = `
Eres Víctor, agente de Recursos Humanos de Alerta y Control. Atiendes llamadas reales.
Hablas en español (España), tono humano, cercano y profesional.
Respuestas cortas (1–2 frases). No repitas lo que dice el usuario.

Objetivo:
1) Entender el motivo de la llamada.
2) Clasificar la incidencia y asignar departamento.
3) Confirmar que has creado la incidencia y que se la envías al departamento correspondiente.
4) Si procede, indica el nivel de prioridad (baja/media/alta/crítica).

Reglas:
- NO hagas muchas preguntas. Solo pregunta si falta un dato imprescindible para tramitar (por ejemplo: “¿Tu nombre y número de empleado?”).
- Si el usuario ya dio suficiente info, NO preguntes: actúa y confirma ticket.
- No menciones “IA”, “modelo”, “OpenAI”, ni “prompts”.
- Si el usuario saluda o prueba “¿me oyes?”, responde breve y pide el motivo una sola vez.

Departamentos posibles (elige UNO):
- nominas
- contratacion
- vacaciones_permisos
- bajas_medicas
- certificados
- acceso_portal_empleado
- datos_personales
- it_soporte (solo si es portal, acceso, contraseña)
- otros_rrhh

Formato de salida OBLIGATORIO:
Devuelve SIEMPRE un bloque JSON al final del mensaje, entre etiquetas <json>...</json>, con:
{
  "resumen": "...",
  "departamento": "nominas|contratacion|vacaciones_permisos|bajas_medicas|certificados|acceso_portal_empleado|datos_personales|it_soporte|otros_rrhh",
  "prioridad": "baja|media|alta|critica",
  "accion": "crear_incidencia"
}
`;

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

// === HTTP + WS ===
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
  wss.handleUpgrade(req, socket, head, (ws) =>
    wss.emit("connection", ws, req)
  );
});

wss.on("connection", (ws) => {
  console.log("🟢 Twilio conectado en /ws-media");

  const state = {
    streamSid: null,
    isSpeaking: false,
    greeted: false,
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

  dg.on(LiveTranscriptionEvents.Open, () =>
    console.log("🟣 Deepgram Live conectado")
  );
  dg.on(LiveTranscriptionEvents.Error, (e) =>
    console.log("💥 Deepgram error:", e?.message || e)
  );
  dg.on(LiveTranscriptionEvents.Close, () =>
    console.log("🟣 Deepgram Live cerrado")
  );

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
      data.speech_final ||
      (state.finalTextBuffer && now - state.lastFinalAt > 700);

    // barge-in
    if (!data.is_final && state.isSpeaking && state.streamSid) {
      try {
        ws.send(JSON.stringify({ event: "clear", streamSid: state.streamSid }));
      } catch {}
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

      // Extraer JSON para que luego puedas mandarlo a n8n/DB
      const match = aiText.match(/<json>([\s\S]*?)<\/json>/);
      if (match) {
        try {
          const ticket = JSON.parse(match[1]);
          console.log("🎫 INCIDENCIA JSON:", ticket);
        } catch {
          console.log("⚠️ No pude parsear el JSON de la respuesta");
        }
      } else {
        console.log("⚠️ No vino bloque <json> en la respuesta");
      }

      // Solo voz: quitamos el JSON hablado (para que no lo lea en alto)
      const spoken = aiText.replace(/<json>[\s\S]*?<\/json>/, "").trim();

      console.log("➡️ Llamando a OpenAI TTS...");
      const audioBuf = await openaiTTS(spoken);
      console.log("✅ OpenAI TTS OK, bytes:", audioBuf.length);

      console.log("➡️ ffmpeg -> mulaw 8k...");
      const mulaw = await audioToMulaw8kRaw(audioBuf);
      console.log("✅ mulaw OK, bytes:", mulaw.length);

      console.log("➡️ Enviando audio a Twilio...");
      await playMulawToTwilio({ ws, streamSid: state.streamSid, mulaw });
      console.log("✅ Audio enviado");
    } catch (e) {
      console.log("💥 Error respondiendo:", e?.message || e);
      if (e?.stack)
        console.log("💥 Stack:", e.stack.split("\n").slice(0, 6).join("\n"));
    } finally {
      state.isSpeaking = false;
    }
  });

  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      state.streamSid = data?.start?.streamSid || null;
      console.log("📞 start:", state.streamSid);

      // ✅ Saludo inicial automático de Víctor (una vez)
      if (!state.greeted && state.streamSid) {
        state.greeted = true;
        const greeting =
          "Buenos días, soy Víctor, agente de Recursos Humanos. ¿En qué puedo ayudarte?";
        try {
          console.log("👋 Saludo inicial:", greeting);
          const audioBuf = await openaiTTS(greeting);
          const mulaw = await audioToMulaw8kRaw(audioBuf);
          await playMulawToTwilio({
            ws,
            streamSid: state.streamSid,
            mulaw,
          });
          console.log("✅ Saludo enviado");
        } catch (e) {
          console.log("💥 Error saludo:", e?.message || e);
        }
      }
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
      try {
        dg.finish();
      } catch {}
      return;
    }
  });

  ws.on("close", () => {
    console.log("❌ WS cerrado");
    try {
      dg.finish();
    } catch {}
  });

  ws.on("error", (err) => {
    console.log("💥 WS error:", err?.message || err);
  });
});

server.listen(PORT, () => console.log("✅ Server up on", PORT));