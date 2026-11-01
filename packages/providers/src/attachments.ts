// SPDX-License-Identifier: Apache-2.0
// How an attached file reads on the wire (M3-10 AC2), shared by the adapters: a text file rides
// as labelled text, and binary files as a data URI in each API's own part shape.
import type { ModelAttachment } from "@opa/core";

/** A text attachment as the model reads it: its name, then its content. */
export const attachmentText = (a: ModelAttachment): string =>
  `Attached file "${a.name}":\n${a.text ?? ""}`;

/** The file's bytes as a data URI, under the sniffed type. */
export const dataUri = (a: ModelAttachment): string => `data:${a.mediaType};base64,${a.data ?? ""}`;
