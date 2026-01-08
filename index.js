import http from "http";
import WebSocket from "ws";
import { OpenAI } from "openai";  // O cualquier librería de IA que uses
import fetch from "node-fetch";   // Para TTS

// Configuración OpenAI (por ejemplo, GPT)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,  // Asegúrate de usar tu API Key
});

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws-media") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  console.log("🟢 Twilio conectado al WS");

  ws.on("message", async (msg) => {
    const data = JSON.parse(msg.toString());
    console.log("📩 Evento recibido:", data.event);

    if (data.event === "start") {
      console.log("📞 Stream iniciado:", data.start.streamSid);
    }

    if (data.event === "media") {
      // Aquí procesas el audio recibido (STT)
      const transcribedText = await convertAudioToText(data.media.payload);

      // Genera una respuesta usando IA (OpenAI, etc.)
      const aiResponse = await getAIResponse(transcribedText);

      // Envía la respuesta al usuario (TTS)
      await sendTextToSpeech(aiResponse);

      console.log("📩 Respuesta generada:", aiResponse);
    }

    if (data.event === "stop") {
      console.log("🔴 Stream finalizado");
    }
  });

  ws.on("close", () => console.log("❌ WS cerrado"));
});

// Start the server on the port
server.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server up");
});

// Función de STT (Speech to Text) - ejemplo
async function convertAudioToText(audioBase64) {
  const response = await fetch("https://api.deepgram.com/v1/listen", {
    method: "POST",
    headers: {
      "Authorization": process.env.DEEPGRAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ audio: audioBase64 }),
  });

  const data = await response.json();
  return data.transcript;  // O el formato adecuado según el servicio STT
}

// Función para generar una respuesta de IA (OpenAI)
async function getAIResponse(inputText) {
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: inputText }],
  });

  return response.choices[0].message.content; // Respuesta generada por IA
}

// Función para TTS (Text to Speech) - ejemplo
async function sendTextToSpeech(text) {
  const ttsResponse = await fetch("https://api.elevenlabs.io/synthesize", {
    method: "POST",
    headers: {
      "Authorization": process.env.EVENLABS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: text, voice: "manuela" }),  // Puedes cambiar la voz
  });

  const audioData = await ttsResponse.json();
  // Aquí, enviarías el audio de vuelta a Twilio para que se reproduzca
}
