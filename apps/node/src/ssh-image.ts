// SPDX-License-Identifier: Apache-2.0
// The same build inputs as docker-local. A local tag is only a discovery/cache key: the
// SSH adapter resolves it to an immutable image Id before launching, with --pull=never.
import pins from "../../../computers/image/pins.json";

export const SSH_COMPUTER_IMAGE_TAG = `opa-computer:${pins.baseDigest.slice(7, 19)}`;
export const SSH_COMPUTER_UID = String(pins.computerUser.uid);

export interface SshVmProviderOptions {
  /** A preloaded shared image, by immutable local Id or registry digest; never a tag. */
  imageRef?: string;
}

export function assertSshImageRef(ref: string): void {
  if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(ref)) {
    throw new Error("ssh-vm imageRef must be an immutable sha256 image Id or registry digest");
  }
}
