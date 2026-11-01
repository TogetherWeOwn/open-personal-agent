// SPDX-License-Identifier: Apache-2.0
// The `/c/:conversationId` address (M3-13 AC2): a task's conversation link names its chat, so
// the address selects it once the list holding it loads, waits while the list is still
// loading, and falls back when the loaded list has no such chat.
import { describe, expect, it } from "vitest";
import { resolveChatAddress } from "../src/router";

const chats = [{ id: "a" }, { id: "b" }];

describe("resolveChatAddress", () => {
  it("selects the named chat once it has loaded", () => {
    expect(resolveChatAddress("b", chats, "a", true)).toEqual({ action: "select", id: "b" });
  });

  it("does nothing when the named chat is already open", () => {
    expect(resolveChatAddress("b", chats, "b", true)).toEqual({ action: "none" });
  });

  it("waits while the list is still loading instead of misjudging the chat unknown", () => {
    expect(resolveChatAddress("zzz", [], "a", false)).toEqual({ action: "wait" });
  });

  it("falls back once the loaded list has no such chat", () => {
    expect(resolveChatAddress("zzz", chats, "a", true)).toEqual({ action: "redirect" });
  });
});
