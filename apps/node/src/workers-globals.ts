// SPDX-License-Identifier: Apache-2.0
// Workers APIs the app uses that Node lacks, filled in before the app handles a request.
import { timingSafeEqual } from "node:crypto";

const subtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView) => boolean;
};
const bytes = (v: ArrayBuffer | ArrayBufferView) =>
  ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);

// Like workerd's, it throws on different lengths instead of returning false.
subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(bytes(a), bytes(b));
