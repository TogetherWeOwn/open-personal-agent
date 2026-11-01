// SPDX-License-Identifier: Apache-2.0
// Attached files on the wire (M3-10 AC2): each adapter's part shape, and the capability flags
// that say which kinds a model may receive at all.
import type { ModelMessage } from "@opa/core";
import { describe, expect, it } from "vitest";
import { messagesBody } from "../src/anthropic-request";
import { chatMessages } from "../src/chat-request";
import { createOpenAIChatProvider } from "../src/openai-chat";
import { createOpenAIResponsesProvider, responsesInput } from "../src/openai-responses";
import { createWorkersAIProvider } from "../src/workers-ai";

const ask: ModelMessage[] = [
  {
    role: "user",
    content: "What is in these?",
    attachments: [
      { kind: "image", mediaType: "image/png", name: "cat.png", data: "QUJD" },
      { kind: "pdf", mediaType: "application/pdf", name: "bill.pdf", data: "REVG" },
      { kind: "text", mediaType: "text/plain", name: "notes.txt", text: "remember this" },
    ],
  },
];

describe("chat-completions shape", () => {
  it("sends parts: text, image_url data URI, file part, labelled text", () => {
    expect(chatMessages(ask)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in these?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
          {
            type: "file",
            file: { filename: "bill.pdf", file_data: "data:application/pdf;base64,REVG" },
          },
          { type: "text", text: 'Attached file "notes.txt":\nremember this' },
        ],
      },
    ]);
  });

  it("leaves a plain message a plain string", () => {
    expect(chatMessages([{ role: "user", content: "hi" }])).toEqual([
      { role: "user", content: "hi" },
    ]);
  });
});

describe("responses shape", () => {
  it("sends input_text, input_image and input_file parts", () => {
    expect(responsesInput(ask, () => false)).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is in these?" },
          { type: "input_image", image_url: "data:image/png;base64,QUJD" },
          {
            type: "input_file",
            filename: "bill.pdf",
            file_data: "data:application/pdf;base64,REVG",
          },
          { type: "input_text", text: 'Attached file "notes.txt":\nremember this' },
        ],
      },
    ]);
  });
});

describe("anthropic-messages shape", () => {
  it("sends image and document blocks by base64", () => {
    const body = messagesBody({ model: "m", messages: ask }, "anthropic");
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in these?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "REVG" },
            title: "bill.pdf",
          },
          { type: "text", text: 'Attached file "notes.txt":\nremember this' },
        ],
      },
    ]);
  });
});

describe("capability flags", () => {
  it("claim only what each adapter knows the model accepts", () => {
    const workers = createWorkersAIProvider({ run: async () => null });
    expect(workers.capabilities("@cf/meta/llama-3.2-11b-vision-instruct").imageInput).toBe(true);
    expect(workers.capabilities("@cf/meta/llama-3.3-70b-instruct-fp8-fast").imageInput).toBe(false);
    expect(workers.capabilities("@cf/meta/llama-3.2-11b-vision-instruct").pdfInput).toBe(false);

    const responses = createOpenAIResponsesProvider({
      providerId: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
    for (const model of [
      "gpt-5",
      "gpt-5.1-mini",
      "gpt-4o-2024-08-06",
      "gpt-4.1-nano",
      "o3",
      "o4-mini",
    ])
      expect(responses.capabilities(model)).toMatchObject({ imageInput: true, pdfInput: true });
    for (const model of [
      "gpt-3.5-turbo",
      "gpt-4",
      "o1-mini",
      "o3-mini",
      "gpt-4o-audio-preview",
      "gpt-4o-mini-search-preview",
      "ft:gpt-4o:me",
      "gpt-6",
    ])
      expect(responses.capabilities(model)).toMatchObject({ imageInput: false, pdfInput: false });

    const chat = createOpenAIChatProvider({
      providerId: "other",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
    });
    expect(chat.capabilities("m")).toMatchObject({ imageInput: false, pdfInput: false });
    const optedIn = createOpenAIChatProvider({
      providerId: "other",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      compat: { supportsImageInput: true },
    });
    expect(optedIn.capabilities("m")).toMatchObject({ imageInput: true, pdfInput: false });
  });
});
