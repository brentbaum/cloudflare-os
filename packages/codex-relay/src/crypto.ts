const ENVELOPE_VERSION = 1 as const;

export type EncryptedEnvelope = {
  version: typeof ENVELOPE_VERSION;
  keyId: string;
  iv: string;
  ciphertext: string;
};

type KeySlot = { id: string; key: CryptoKey };

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const unprefixed = value.startsWith("base64:") ? value.slice(7) : value;
  const normalized = unprefixed.replaceAll("-", "+").replaceAll("_", "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized))
    throw new Error("Wrapping key is not valid base64");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function importKey(encoded: string): Promise<KeySlot> {
  const raw = decodeBase64(encoded);
  if (raw.byteLength !== 32) throw new Error("Wrapping key must decode to exactly 32 bytes");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const id = Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { id, key };
}

function additionalData(
  objectId: string,
  stateVersion: number,
  purpose: string,
): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(
    `${objectId}:codex-relay-envelope-v${ENVELOPE_VERSION}:state-v${stateVersion}:${purpose}`,
  );
  const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  copy.set(encoded);
  return copy;
}

/**
 * AES-GCM wrapping keys with one current encryption key and an optional previous decrypt-only key.
 * During rotation, deploy both keys until every live connection has been refreshed/reconnected and
 * rewritten with the current key; only then remove the previous key.
 */
export class WrappingKeyring {
  private constructor(
    private readonly current: KeySlot,
    private readonly previous?: KeySlot,
  ) {}

  static async create(current: string, previous?: string): Promise<WrappingKeyring> {
    const currentKey = await importKey(current);
    const previousKey = previous ? await importKey(previous) : undefined;
    if (previousKey?.id === currentKey.id) return new WrappingKeyring(currentKey);
    return new WrappingKeyring(currentKey, previousKey);
  }

  async encrypt(
    value: unknown,
    objectId: string,
    stateVersion: number,
    purpose: string,
  ): Promise<EncryptedEnvelope> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(objectId, stateVersion, purpose) },
      this.current.key,
      plaintext,
    );
    return {
      version: ENVELOPE_VERSION,
      keyId: this.current.id,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    };
  }

  async decrypt<T>(
    envelope: EncryptedEnvelope,
    objectId: string,
    stateVersion: number,
    purpose: string,
  ): Promise<T> {
    if (envelope.version !== ENVELOPE_VERSION)
      throw new Error("Unsupported encrypted state version");
    const slot = [this.current, this.previous].find(
      (candidate) => candidate?.id === envelope.keyId,
    );
    if (!slot) throw new Error("Encrypted state uses an unavailable wrapping key");
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decodeBase64(envelope.iv),
          additionalData: additionalData(objectId, stateVersion, purpose),
        },
        slot.key,
        decodeBase64(envelope.ciphertext),
      );
      return JSON.parse(new TextDecoder().decode(plaintext)) as T;
    } catch {
      throw new Error("Encrypted state could not be authenticated");
    }
  }
}
