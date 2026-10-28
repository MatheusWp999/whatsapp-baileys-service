import assert from "node:assert/strict";
import test from "node:test";
import { deriveOutboundMime } from "../dist/outboundMedia.js";

test("detects campaign PDF content independently of its file name", () => {
  assert.equal(deriveOutboundMime(Buffer.from("%PDF-1.7"), "invoice.bin", "private/file"), "application/pdf");
});

test("detects common image signatures", () => {
  assert.equal(deriveOutboundMime(Buffer.from([0xff, 0xd8, 0xff, 0x00]), "image.bin", "image.bin"), "image/jpeg");
  assert.equal(deriveOutboundMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image.bin", "image.bin"), "image/png");
});

test("rejects unsupported campaign media", () => {
  assert.equal(deriveOutboundMime(Buffer.from("not media"), "payload.exe", "payload.exe"), null);
  assert.equal(deriveOutboundMime(Buffer.from("not a PDF"), "payload.pdf", "payload.pdf"), null);
});
