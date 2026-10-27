import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJid, contactPhoneFromJid, conversationJid, deliveryStatusFromCode, messageTimestampToIso } from "../dist/whatsappIdentity.js";

test("canonicalizes device-qualified WhatsApp JIDs", () => {
  assert.equal(canonicalJid("5511999998888:12@s.whatsapp.net"), "5511999998888@s.whatsapp.net");
});

test("keeps unrelated JID namespaces out of direct conversations", () => {
  assert.equal(contactPhoneFromJid("120363000000000000@g.us"), "");
  assert.equal(contactPhoneFromJid("status@broadcast"), "");
});

test("resolves LID conversations through contact aliases", () => {
  const aliases = new Map([["123456789@lid", { phone: "5511999998888", name: "Cliente" }]]);
  assert.equal(contactPhoneFromJid("123456789@lid", aliases), "5511999998888");
});

test("uses the phone JID as the canonical identity for LID conversations", () => {
  assert.equal(conversationJid("123456789@lid", "+55 (11) 99999-8888"), "5511999998888@s.whatsapp.net");
});

test("preserves protobuf Long timestamps after durable serialization", () => {
  assert.equal(messageTimestampToIso({ low: 1_700_000_000, high: 0, unsigned: true }), "2023-11-14T22:13:20.000Z");
});

test("rejects timestamps outside the JavaScript date range", () => {
  assert.equal(messageTimestampToIso(9_000_000_000_000_000), null);
});

test("maps WhatsApp acknowledgements to monotonic delivery states", () => {
  assert.equal(deliveryStatusFromCode(1), "pending");
  assert.equal(deliveryStatusFromCode(3), "delivered");
  assert.equal(deliveryStatusFromCode(4), "read");
  assert.equal(deliveryStatusFromCode(5), "played");
});
