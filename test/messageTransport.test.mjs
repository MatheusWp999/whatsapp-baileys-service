import assert from "node:assert/strict";
import test from "node:test";
import { sendWhatsAppMessage } from "../dist/messageTransport.js";

test("sends text through the shared transport", async () => {
  const calls = [];
  const sock = { sendMessage: async (...args) => { calls.push(args); return { key: { id: "one" } }; } };
  await sendWhatsAppMessage(sock, "5511999998888@s.whatsapp.net", { text: "Hello" });
  assert.deepEqual(calls[0], ["5511999998888@s.whatsapp.net", { text: "Hello" }]);
});

test("sends image content with its caption", async () => {
  const calls = [];
  const data = Buffer.from([0xff, 0xd8, 0xff]);
  const sock = { sendMessage: async (...args) => { calls.push(args); return { key: { id: "two" } }; } };
  await sendWhatsAppMessage(sock, "5511999998888@s.whatsapp.net", {
    text: "Caption",
    media: { type: "image", data, mimeType: "image/jpeg" },
  });
  assert.deepEqual(calls[0], ["5511999998888@s.whatsapp.net", {
    image: data,
    mimetype: "image/jpeg",
    caption: "Caption",
  }]);
});
