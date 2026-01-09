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

function looksLikeGoodbye(t = "") {
  const s = t.toLowerCase();
  return (
    s.includes("adiós") ||
    s.includes("adios") ||
    s.includes("hasta luego") ||
    s.includes("hasta pronto") ||
    s.includes("gracias") ||
    s.includes("vale gracias") ||
    s.includes("ok gracias")
  );
}

function cleanEmployeeIdOrName(raw = "") {
  if (!raw) return "";

  let s = String(raw).trim().replace(/\s+/g, " ");

  // 1) Quitar muletillas/saludos al inicio
  s = s.replace(
    /^(?:hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|oye|eh|vale|mira|a\s+ver|pues|bueno)\b[\s,.-]*/i,
    ""
  );

  // 2) Quitar fórmulas de presentación
  s = s.replace(
    /^(?:(?:hola\s*,?\s*)?(?:yo\s+)?soy|me\s+llamo|mi\s+nombre\s+es|nombre\s+es|le\s+habla|habla|te\s+habla)\b[\s:,-]*/i,
    ""
  );

  // 3) Quitar "soy el/la"
  s = s.replace(/^(?:soy\s+(?:el|la))\b[\s:,-]*/i, "");

  // 4) Quitar prefijos de identificación de empleado
  s = s.replace(
    /^(?:(?:mi\s+)?n[uú]mero\s+(?:de\s+)?empleado\s*(?:es|:)?|n[uú]mero\s+empleado\s*(?:es|:)?|id\s*(?:de\s+)?empleado\s*(?:es|:)?|identificador\s*(?:de\s+)?empleado\s*(?:es|:)?|c[oó]digo\s*(?:de\s+)?empleado\s*(?:es|:)?|legajo\s*(?:es|:)?|matr[ií]cula\s*(?:es|:)?)\s*/i,
    ""
  );

  // 5) Si empieza por "es ..."
  s = s.replace(/^(?:es)\b[\s:,-]*/i, "");

  // 6) Quitar comillas/puntuación sobrante
  s = s
    .replace(/^[\s"'“”‘’()[\]{}:,-]+/, "")
    .replace(/[\s"'“”‘’()[\]{}:,-]+$/, "");

  // 7) Re-limpiar muletilla
  s = s.replace(
    /^(?:hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|oye|eh|vale|mira|a\s+ver|pues|bueno)\b[\s,.-]*/i,
    ""
  );

  // 8) Normalizar espacios
  s = s.replace(/\s+/g, " ").trim();

  return s || String(raw).trim();
}

// ✅ NUEVO: Solo para hablarle por su nombre (primer nombre), sin apellidos
function firstNameForGreeting(full = "") {
  let s = String(full).trim().replace(/\s+/g, " ");
  if (!s) return "";

  // Quitar tratamientos típicos
  s = s.replace(/^(sr\.?|sra\.?|señor|señora|don|doña)\s+/i, "");

  const parts = s.split(" ").filter(Boolean);

  // Si es solo un número (nº empleado), no lo digas en voz
  if (parts.length === 1 && /^\d{3,}$/.test(parts[0])) return "";

  // Si empieza con números, busca la primera palabra no numérica
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return p;
  }

  return parts[0] || "";
}

function looksLikeEmptyReason(raw = "") {
  const s = raw.trim().toLowerCase();

  const emptyPhrases = new Set([
    "llamo porque",
    "porque",
    "pues",
    "a ver",
    "hola",
    "sí",
    "si",
    "vale",
    "ok",
    "buenas",
    "buenos días",
    "buenas tardes",
  ]);

  if (!s) return true;
  if (emptyPhrases.has(s)) return true;

  const wordCount = s.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4) return true;

  return false;
}

// ===== N8N POST =====
async function postTicketToN8N(payload, { timeoutMs = 8000 } = {}) {
  const url = process.env.N8N_TICKET_WEBHOOK_URL;
  if (!url)
    throw new Error("Falta N8N_TICKET_WEBHOOK_URL en variables de entorno");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`POST n8n falló ${res.status} ${res.statusText}: ${txt}`);
    }

    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(t);
  }
}

// ===== DEEPGRAM TTS =====
async function deepgramTTS(text) {
  const model = process.env.DEEPGRAM_TTS_MODEL || "aura-2-nestor-es";

  const resp = await fetch(
    `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "audio/wav",
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
            `ffmpeg exit ${code}: ${Buffer.concat(err).toString("utf8")}`
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

// ===== PLAY AUDIO A TWILIO =====
async function playMulawToTwilio({ ws, streamSid, mulaw }) {
  const FRAME = 160;
  let offset = 0;

  while (offset < mulaw.length) {
    if (ws.readyState !== 1) break;
    if (!streamSid) break;

    const frame = mulaw.subarray(offset, offset + FRAME);
    offset += FRAME;

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

// ===== HABLAR =====
async function speak(ws, state, text) {
  if (!state.streamSid) return;
  const wav = await deepgramTTS(text);
  const mulaw = await audioToMulaw8kRaw(wav);
  await playMulawToTwilio({ ws, streamSid: state.streamSid, mulaw });
}

// ===== OPENAI CHAT =====
async function getAIResponse(userText, state) {
  const system = `
Eres Víctor, agente de Recursos Humanos de Alerta y Control. Atiendes llamadas reales.
Hablas en español (España), tono humano, cercano y profesional.

REGLA PRINCIPAL:
- Máximo 1 pregunta por turno.
- Respuestas cortas (1–2 frases).
- No repitas lo que dice el usuario.
- No menciones IA, modelos, OpenAI, Deepgram.

ETAPAS (estricto):
A) IDENTIFY: pedir nombre completo o número de empleado (solo eso).
B) REASON: pedir el motivo (solo eso).
C) DONE: cuando ya tienes motivo, crea incidencia, asigna departamento y prioridad, y CIERRA:
   1) Confirmación de ticket (muy breve)
   2) Frase final exacta:
      "He creado la incidencia y la voy a mandar ahora mismo al departamento de {departamento} para que un compañero la gestione."
   3) Despedida:
      "Gracias por contactar con nosotros. Espero te lo solucionen lo antes posible. Hasta entonces, que pases un buen día."

Regla extra:
- Si el estado dice Identificado: sí, está PROHIBIDO volver a pedir nombre o número de empleado.
- Si ya tienes motivo, está PROHIBIDO pedir más datos: solo clasifica y cierra.

Departamentos posibles (elige 1):
- nominas
- contratacion
- vacaciones_permisos
- bajas_medicas
- certificados
- datos_personales
- portal_empleado_acceso
- it_soporte
- otros_rrhh

Prioridad:
- critica: bloqueo total
- alta: nómina/baja con urgencia o plazo hoy
- media: 24–48h
- baja: consulta informativa

Clasificación rápida:
- nómina/pago/retención/IRPF -> nominas
- contrato/alta/fin/horario -> contratacion
- vacaciones/permiso/días -> vacaciones_permisos
- baja médica/parte/IT -> bajas_medicas
- certificados/vida laboral/empresa -> certificados
- cambio IBAN/dirección/datos -> datos_personales
- no puedo entrar/contraseña/portal -> portal_empleado_acceso (o it_soporte si es técnico)
- si no encaja -> otros_rrhh
`;

  const context = `
Estado:
- etapa: ${state.stage}
- Identificado: ${state.employeeIdOrName ? "sí" : "no"}
- empleado: ${state.employeeIdOrName || "no informado"}
- motivo: ${state.motivo || "no"}
`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
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

    // estado callcenter
    stage: "IDENTIFY",
    employeeIdOrName: null,
    motivo: null,
    ackedGoodbye: false,

    // ===== N8N POST =====
    callerPhone: null,
    ticketSent: false,
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

    if (state.stage === "DONE") {
      if (!state.ackedGoodbye && looksLikeGoodbye(userText)) {
        state.ackedGoodbye = true;
        state.speaking = true;
        try {
          await speak(ws, state, "Gracias, hasta luego.");
        } catch (e) {
          console.log("💥 Error despedida:", e?.message || e);
        } finally {
          state.speaking = false;
        }
      }
      return;
    }

    state.speaking = true;

    try {
      console.log("🧠 USUARIO:", userText);

      if (state.stage === "IDENTIFY") {
        const clean = cleanEmployeeIdOrName(userText);
        state.employeeIdOrName = clean;
        state.stage = "REASON";
        console.log("🪪 Identificación capturada:", state.employeeIdOrName);

        // ✅ AQUÍ el cambio: saludar solo con el primer nombre (si es nombre)
        const firstName = firstNameForGreeting(state.employeeIdOrName);
        const msg = firstName
          ? `Perfecto, ${firstName}. ¿Cuál es el motivo de tu llamada?`
          : "Perfecto. ¿Cuál es el motivo de tu llamada?";

        console.log("🤖 VÍCTOR:", msg);
        await speak(ws, state, msg);
        return;
      }

      if (state.stage === "REASON") {
        if (looksLikeEmptyReason(userText)) {
          const msg = "De acuerdo. Dime brevemente cuál es el problema.";
          console.log("🤖 VÍCTOR:", msg);
          await speak(ws, state, msg);
          return;
        }

        state.motivo = userText;
        console.log("📝 Motivo capturado:", state.motivo);

        const aiText = await getAIResponse(userText, state);
        console.log("🤖 VÍCTOR:", aiText);

        await speak(ws, state, aiText);

        // ===== N8N POST (enviar ticket 1 sola vez) =====
        // ===== N8N POST (enviar ticket 1 sola vez) =====
        if (!state.ticketSent) {
          state.ticketSent = true;

          // 1) Pedimos al modelo SOLO la clasificación (departamento + urgencia)
          const classify = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0,
            messages: [
              {
                role: "system",
                content: `
Eres un clasificador de incidencias de RRHH.
Devuelve ÚNICAMENTE JSON válido, sin texto extra ni markdown.

Departamentos posibles (elige 1):
- nominas
- contratacion
- vacaciones_permisos
- bajas_medicas
- certificados
- datos_personales
- portal_empleado_acceso
- it_soporte
- otros_rrhh

Urgencia (elige 1):
- critica
- alta
- media
- baja

Reglas rápidas:
- nómina/pago/retención/IRPF -> nominas
- contrato/alta/fin/horario -> contratacion
- vacaciones/permiso/días -> vacaciones_permisos
- baja médica/parte/IT -> bajas_medicas
- certificados/vida laboral/empresa -> certificados
- cambio IBAN/dirección/datos -> datos_personales
- no puedo entrar/contraseña/portal -> portal_empleado_acceso (o it_soporte si es técnico)
- si no encaja -> otros_rrhh

Devuelve:
{"categoria":"...","urgencia":"..."}
        `.trim(),
              },
              {
                role: "user",
                content: `Empleado: ${
                  state.employeeIdOrName || "No identificado"
                }\nTeléfono: ${state.callerPhone || "No informado"}\nMotivo: ${
                  state.motivo || ""
                }`,
              },
            ],
          });

          const raw = classify.choices?.[0]?.message?.content?.trim() || "{}";

          // 2) Parse robusto (por si viniera con basura)
          let parsed = {};
          try {
            const cleaned = raw
              .replace(/^```json\s*/i, "")
              .replace(/^```\s*/i, "")
              .replace(/```$/i, "")
              .trim();

            const first = cleaned.indexOf("{");
            const last = cleaned.lastIndexOf("}");
            const jsonStr =
              first !== -1 && last !== -1 && last > first
                ? cleaned.slice(first, last + 1)
                : cleaned;

            parsed = JSON.parse(jsonStr);
          } catch (e) {
            parsed = {};
          }

          // 3) Normaliza y valida
          const allowedCats = new Set([
            "nominas",
            "contratacion",
            "vacaciones_permisos",
            "bajas_medicas",
            "certificados",
            "datos_personales",
            "portal_empleado_acceso",
            "it_soporte",
            "otros_rrhh",
          ]);
          const allowedUrg = new Set(["critica", "alta", "media", "baja"]);

          const categoria = String(parsed.categoria || "")
            .toLowerCase()
            .trim();
          const urgencia = String(parsed.urgencia || "")
            .toLowerCase()
            .trim();

          const payload = {
            nombre_completo: state.employeeIdOrName || "No identificado",
            telefono: state.callerPhone || "No informado",
            categoria: allowedCats.has(categoria) ? categoria : "otros_rrhh",
            urgencia: allowedUrg.has(urgencia) ? urgencia : "media",
            mensaje_ia: state.motivo || "",
          };

          try {
            const resp = await postTicketToN8N(payload);
            console.log("✅ Ticket enviado a n8n:", resp);
          } catch (e) {
            console.log("💥 Error enviando ticket a n8n:", e?.message || e);
          }
        }

        state.stage = "DONE";
        return;
      }

      const aiText = await getAIResponse(userText, state);
      console.log("🤖 VÍCTOR:", aiText);
      await speak(ws, state, aiText);
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

      const cp = data.start?.customParameters || {};
      state.callerPhone =
        cp.from || cp.caller || cp.telefono || data.start?.from || null;

      if (state.callerPhone) {
        console.log("📱 callerPhone:", state.callerPhone);
      } else {
        console.log(
          "📱 callerPhone: (no recibido) — pásalo como <Parameter> en TwiML"
        );
      }

      if (!state.greeted && state.streamSid) {
        state.greeted = true;

        const greeting =
          "Buenas, soy Víctor, agente de Recursos Humanos. Antes de nada, dime tu nombre completo o tu número de empleado para identificarte.";

        state.speaking = true;
        try {
          console.log("👋 SALUDO:", greeting);
          await speak(ws, state, greeting);
          console.log("✅ Saludo enviado");
        } catch (e) {
          console.log("💥 Error saludo:", e?.message || e);
        } finally {
          state.speaking = false;
        }
      }
      return;
    }

    if (data.event === "media") {
      dg.send(Buffer.from(data.media.payload, "base64"));
      return;
    }

    if (data.event === "stop") {
      console.log("🔴 stop");
      dg.finish();
      return;
    }
  });

  ws.on("close", () => {
    console.log("❌ WS cerrado");
    dg.finish();
  });
});

server.listen(PORT, () => console.log("✅ Server up on", PORT));
