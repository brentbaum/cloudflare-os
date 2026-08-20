import { describe, expect, it } from "vitest";
import { WrappingKeyring } from "../src/crypto.js";

function fakeKey(seed: number): string {
  return btoa(
    String.fromCharCode(...Array.from({ length: 32 }, (_, index) => (seed + index) % 256)),
  );
}

describe("credential wrapping", () => {
  it("round-trips with authenticated object and purpose binding", async () => {
    const keyring = await WrappingKeyring.create(fakeKey(1));
    const envelope = await keyring.encrypt(
      { accessToken: "access_unmistakably_fake", refreshToken: "refresh_unmistakably_fake" },
      "object-fake-1",
      1,
      "credential",
    );
    expect(envelope).toMatchObject({ version: 1 });
    expect(JSON.stringify(envelope)).not.toContain("unmistakably_fake");
    await expect(keyring.decrypt(envelope, "object-fake-1", 1, "credential")).resolves.toEqual({
      accessToken: "access_unmistakably_fake",
      refreshToken: "refresh_unmistakably_fake",
    });
    await expect(keyring.decrypt(envelope, "object-fake-2", 1, "credential")).rejects.toThrow(
      "could not be authenticated",
    );
    await expect(keyring.decrypt(envelope, "object-fake-1", 1, "pending")).rejects.toThrow(
      "could not be authenticated",
    );
    await expect(keyring.decrypt(envelope, "object-fake-1", 2, "credential")).rejects.toThrow(
      "could not be authenticated",
    );
  });

  it("decrypts with the previous key but always encrypts with the current key", async () => {
    const oldKeyring = await WrappingKeyring.create(fakeKey(2));
    const oldEnvelope = await oldKeyring.encrypt(
      { value: "fake-old" },
      "object-fake",
      1,
      "credential",
    );
    const rotated = await WrappingKeyring.create(fakeKey(3), fakeKey(2));
    await expect(rotated.decrypt(oldEnvelope, "object-fake", 1, "credential")).resolves.toEqual({
      value: "fake-old",
    });
    const newEnvelope = await rotated.encrypt(
      { value: "fake-new" },
      "object-fake",
      1,
      "credential",
    );
    expect(newEnvelope.keyId).not.toBe(oldEnvelope.keyId);
  });

  it("rejects tampering and unavailable key ids", async () => {
    const keyring = await WrappingKeyring.create(fakeKey(4));
    const envelope = await keyring.encrypt({ value: "fake" }, "object-fake", 1, "credential");
    await expect(
      keyring.decrypt(
        { ...envelope, ciphertext: `${envelope.ciphertext}A` },
        "object-fake",
        1,
        "credential",
      ),
    ).rejects.toThrow("could not be authenticated");
    await expect(
      WrappingKeyring.create(fakeKey(5)).then((other) =>
        other.decrypt(envelope, "object-fake", 1, "credential"),
      ),
    ).rejects.toThrow("unavailable wrapping key");
  });
});
