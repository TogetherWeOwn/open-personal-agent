// SPDX-License-Identifier: Apache-2.0
// M4-06 coverage: ssh-vm entry validation (AC1), credential binding shape and domain separation
// (AC1), and the honest capabilities (AC2).
import { describe, expect, it } from "vitest";
import { assertComputerCapabilities } from "../src/computer-provider";
import {
  assertSshVmEntry,
  SSH_VM_DEFAULT_PORT,
  SSH_VM_PROFILES,
  SSH_VM_PROVIDER_ID,
  type SshVmProviderEntry,
  sshCredentialBinding,
  sshVmCapabilities,
} from "../src/computer-ssh-entry";

function entry(overrides: Partial<SshVmProviderEntry> = {}): SshVmProviderEntry {
  return {
    id: "lab-vm",
    host: "vm.example.com",
    username: "opa",
    hostKeyPins: ["SHA256:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="],
    credentialSecretId: "ssh-lab-vm",
    ...overrides,
  };
}

describe("assertSshVmEntry", () => {
  it("accepts a complete entry", () => {
    expect(() => assertSshVmEntry(entry())).not.toThrow();
    expect(() =>
      assertSshVmEntry(entry({ port: 2222, baseDir: "/srv/opa/computers" })),
    ).not.toThrow();
  });

  it("rejects malformed entries (AC1)", () => {
    const bad: unknown[] = [
      null,
      {},
      entry({ id: "Two-2064" }),
      entry({ id: "" }),
      entry({ id: "x".repeat(64) }),
      entry({ host: "" }),
      entry({ host: "has space.example" }),
      entry({ host: "user@host" }),
      entry({ host: "a|b" }),
      entry({ port: 0 }),
      entry({ port: 65536 }),
      entry({ port: 22.5 }),
      entry({ username: "" }),
      entry({ username: "a|b" }),
      entry({ username: "a:b" }),
      entry({ hostKeyPins: [] }),
      entry({ hostKeyPins: ["md5:aa:bb"] }),
      entry({ hostKeyPins: ["SHA256:!!!"] }),
      entry({ credentialSecretId: "" }),
      entry({ credentialSecretId: "a|b" }),
      entry({ baseDir: "" }),
    ];
    for (const candidate of bad) {
      expect(() => assertSshVmEntry(candidate), JSON.stringify(candidate)).toThrow(
        "invalid ssh-vm provider entry",
      );
    }
  });
});

describe("sshCredentialBinding", () => {
  it("binds entry, lowercased host, explicit port and user (AC1)", () => {
    expect(sshCredentialBinding(entry())).toBe("ssh:lab-vm|vm.example.com:22|opa");
    expect(sshCredentialBinding(entry({ port: 2222 }))).toBe("ssh:lab-vm|vm.example.com:2222|opa");
    expect(sshCredentialBinding(entry({ host: "VM.EXAMPLE.COM" }))).toBe(
      "ssh:lab-vm|vm.example.com:22|opa",
    );
  });

  it("separates domains: any field change binds a different secret", () => {
    const base = sshCredentialBinding(entry());
    for (const changed of [
      entry({ id: "other-vm" }),
      entry({ host: "other.example.com" }),
      entry({ port: 2222 }),
      entry({ username: "root" }),
    ]) {
      expect(sshCredentialBinding(changed)).not.toBe(base);
    }
  });
});

describe("sshVmCapabilities", () => {
  it("declares the honest ssh-vm shape (AC2)", () => {
    const capabilities = sshVmCapabilities();
    expect(SSH_VM_PROVIDER_ID).toBe("ssh-vm");
    expect(capabilities.credentialDelivery).toBe("proxy-token");
    expect(capabilities.egressControl).toBe("none");
    expect(capabilities.profiles).toEqual(["standard", "persistent"]);
    expect(SSH_VM_PROFILES).toEqual(["standard", "persistent"]);
    expect(capabilities.persistentDisk).toBe(true);
    expect(capabilities.surfaces).toEqual({
      execStream: true,
      files: true,
      browser: false,
      desktop: false,
      snapshot: false,
      preview: false,
    });
    expect(() => assertComputerCapabilities(capabilities)).not.toThrow();
    expect(SSH_VM_DEFAULT_PORT).toBe(22);
  });

  it("returns a fresh copy per call", () => {
    const first = sshVmCapabilities();
    first.surfaces.execStream = false;
    expect(sshVmCapabilities().surfaces.execStream).toBe(true);
  });
});
