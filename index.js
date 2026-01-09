import http from "http";
import { WebSocketServer } from "ws";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import OpenAI from "openai";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";

const PORT = process.env.PORT || 3000;

// ===== CLIENTES =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// ===== UTILS =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== DEEPGRAM TTS (ESPAÑOL REAL) =====
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

// ===== AUDIO → MULAW 8K =====
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
        reject(
          new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString("utf8")}`)
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

// ===== PLAY AUDIO A TWILIO =====
async function playMulawToTwilio({ ws, streamSid, mulaw }) {
  const FRAME = 160; // 20ms @ 8kHz
  let offset = 0;

  while (offset < mulaw.length) {
    if (ws.readyState !== 1) break;

    const frame = mulaw.subarray(offset, offset + FRAME);
    offset += FRAME;

    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: frame.toString("base64") },
    }));

    await sleep(20);
  }
}

// ===== OPENAI CHAT (VÍCTOR RRHH) =====
async function getAIResponse(userText, state) {
  const system = `
Eres Víctor, agente de Recursos Humanos de Alerta y Control. Atiendes llamadas reales.
Hablas en español (España), tono humano, cercano y profesional.

Estilo:
- Respuestas MUY cortas (1–2 frases).
- Cero relleno. No repitas lo que dice el usuario.
- Máximo 1 pregunta si falta un dato imprescindible.

Objetivo:
1) Entender el motivo de la llamada.
2) Clasificar la incidencia y asignar departamento.
3) Confirmar que has creado la incidencia y que la envías al departamento adecuado.

Departamentos posibles (elige 1):
- nominas
- contratacion
- vacaciones_permisos
- bajas_medicas
- certificados
- datos_personales
- portal_empleado_acceso
- it_soporte (solo si es acceso/contraseña/portal)
- otros_rrhh

Prioridad:
- critica: bloqueo total / no pueden trabajar / caída total del servicio (si aplica a RRHH, “bloqueo total de nómina/portal”)
- alta: afecta a nómina o baja médica con urgencia / plazo hoy
- media: afecta pero puede esperar 24–48h
- baja: consulta informativa

Reglas:
- Si el motivo es claro (nómina, baja, vacaciones, contrato, certificado, cambio de datos, acceso al portal):
  -> NO preguntes más: crea la incidencia, asigna departamento y prioridad, y confirma.
- Si el motivo es vago:
  -> Haz SOLO 1 pregunta: “¿Es sobre nómina, bajas, vacaciones, contrato, certificados, datos personales o acceso al portal?”
- Si preguntan “¿me oyes?” o saludan:
  -> “Sí, te escucho. Dime el motivo y lo gestiono ahora.”

Formato de respuesta:
- No digas que eres IA.
- No menciones OpenAI/Deepgram/modelos.
- Responde como humano.
`;

  const context = `
Estado:
- Empleado: ${state.employee || "no identificado"}
- Empresa: ${state.company || "desconocida"}
`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "system", content: context },
      { role: "user", content: userText },
    ],
  });

  return r.choices[0].message.content.trim();
}

// ===== HTTP + WS =====
const server = http.createServer((_, res) => {
  res.writeHead(200);
  res.end("OK");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws-media") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws) => {
  console.log("🟢 Twilio conectado");

  const state = {
    streamSid: null,
    speaking: false,
    greeted: false,
    buffer: "",
    lastFinal: 0,
    employee: null,
    company: null,
  };

  const dg = deepgram.listen.live({
    model: "nova-2",
    language: "es",
    encoding: "mulaw",
    sample_rate: 8000,
    interim_results: true,
    endpointing: 200,
    vad_events: true,
  });

  dg.on(LiveTranscriptionEvents.Open, () =>
    console.log("🟣 Deepgram STT conectado")
  );

  dg.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const text = data.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text) return;

    if (data.is_final) {
      state.buffer += (state.buffer ? " " : "") + text;
      state.lastFinal = Date.now();
      console.log("✅ FINAL:", text);
    }

    const end =
      data.speech_final || (state.buffer && Date.now() - state.lastFinal > 700);

    if (!end || state.speaking) return;

    const userText = state.buffer;
    state.buffer = "";
    state.speaking = true;

    try {
      console.log("🧠 USUARIO:", userText);
      const aiText = await getAIResponse(userText, state);
      console.log("🤖 VÍCTOR:", aiText);

      const wav = await deepgramTTS(aiText);
      const mulaw = await audioToMulaw8kRaw(wav);

      await playMulawToTwilio({ ws, streamSid: state.streamSid, mulaw });
    } catch (e) {
      console.log("💥 Error:", e?.message || e);
    } finally {
      state.speaking = false;
    }
  });

  ws.on("message", async (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      state.streamSid = data.start.streamSid;
      console.log("📞 start:", state.streamSid);

      // ✅ Saludo inicial: empieza hablando él
      if (!state.greeted && state.streamSid) {
        state.greeted = true;

        const greeting =
          "Buenos días, soy Víctor, agente de Recursos Humanos. Dime el motivo de tu llamada y lo gestiono ahora mismo.";

        // Marcamos speaking para que no responda a STT mientras suena el saludo
        state.speaking = true;
        try {
          console.log("👋 SALUDO:", greeting);
          const wav = await deepgramTTS(greeting);
          const mulaw = await audioToMulaw8kRaw(wav);
          await playMulawToTwilio({ ws, streamSid: state.streamSid, mulaw });
          console.log("✅ Saludo enviado");
        } catch (e) {
          console.log("💥 Error saludo:", e?.message || e);
        } finally {
          state.speaking = false;
        }
      }
    }

    if (data.event === "media") {
      dg.send(Buffer.from(data.media.payload, "base64"));
    }

    if (data.event === "stop") {
      console.log("🔴 stop");
      dg.finish();
    }
  });

  ws.on("close", () => {
    console.log("❌ WS cerrado");
    dg.finish();
  });
});

server.listen(PORT, () => console.log("✅ Server up on", PORT));