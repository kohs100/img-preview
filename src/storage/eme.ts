import { createCipheriv, createDecipheriv, type Cipheriv, type Decipheriv } from "crypto";

const BLOCK_SIZE = 16;
/** EME is only defined for 1..128 blocks (2048 bytes). */
export const EME_MAX_BYTES = 128 * BLOCK_SIZE;

function xorBlocks(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

/** GF(2^128) doubling with the little-endian convention of rfjakob/eme. */
function multByTwo(input: Buffer): Buffer {
  const out = Buffer.alloc(BLOCK_SIZE);
  out[0] = (input[0] << 1) & 0xff;
  if (input[15] >= 0x80) out[0] ^= 0x87;
  for (let j = 1; j < BLOCK_SIZE; j += 1) {
    out[j] = ((input[j] << 1) & 0xff) | (input[j - 1] >> 7);
  }
  return out;
}

function block(data: Buffer, index: number): Buffer {
  return data.subarray(index * BLOCK_SIZE, (index + 1) * BLOCK_SIZE);
}

/**
 * EME (ECB-Mix-ECB) wide-block cipher over AES-256, byte-compatible with
 * github.com/rfjakob/eme as used by rclone crypt and gocryptfs for names.
 * It is deterministic and unauthenticated: equal inputs give equal outputs.
 */
export class Eme {
  // ECB keeps no state between blocks, so one long-lived context is reusable.
  private readonly encryptor: Cipheriv;

  private readonly decryptor: Decipheriv;

  private readonly lTable: Buffer[] = [];

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("EME key must be 32 bytes");
    this.encryptor = createCipheriv("aes-256-ecb", key, null).setAutoPadding(false);
    this.decryptor = createDecipheriv("aes-256-ecb", key, null).setAutoPadding(false);
    let l: Buffer = this.encryptor.update(Buffer.alloc(BLOCK_SIZE));
    for (let i = 0; i < EME_MAX_BYTES / BLOCK_SIZE; i += 1) {
      l = multByTwo(l);
      this.lTable.push(l);
    }
  }

  encrypt(tweak: Buffer, plaintext: Buffer): Buffer {
    return this.transform(tweak, plaintext, true);
  }

  decrypt(tweak: Buffer, ciphertext: Buffer): Buffer {
    return this.transform(tweak, ciphertext, false);
  }

  private aes(data: Buffer, encrypt: boolean): Buffer {
    const out = encrypt ? this.encryptor.update(data) : this.decryptor.update(data);
    if (out.length !== data.length) throw new Error("AES-ECB block length mismatch");
    return out;
  }

  private transform(tweak: Buffer, input: Buffer, encrypt: boolean): Buffer {
    if (tweak.length !== BLOCK_SIZE) throw new Error("EME tweak must be 16 bytes");
    if (input.length === 0 || input.length % BLOCK_SIZE !== 0) {
      throw new Error("EME input must be a non-empty multiple of 16 bytes");
    }
    if (input.length > EME_MAX_BYTES) throw new Error("EME input exceeds 2048 bytes");
    const m = input.length / BLOCK_SIZE;

    // PPPj = AES(Pj xor 2^(j-1)L)
    const pp = Buffer.alloc(input.length);
    for (let j = 0; j < m; j += 1) {
      xorBlocks(block(input, j), this.lTable[j]).copy(pp, j * BLOCK_SIZE);
    }
    const ppp = this.aes(pp, encrypt);

    // MP = (xor of PPPj) xor T, MC = AES(MP), M = MP xor MC
    let mp = xorBlocks(block(ppp, 0), tweak);
    for (let j = 1; j < m; j += 1) mp = xorBlocks(mp, block(ppp, j));
    const mc = this.aes(mp, encrypt);
    let mask = xorBlocks(mp, mc);

    // CCCj = PPPj xor 2^(j-1)M, CCC1 = (xor of CCCj) xor T xor MC
    const ccc = Buffer.from(ppp);
    for (let j = 1; j < m; j += 1) {
      mask = multByTwo(mask);
      xorBlocks(block(ppp, j), mask).copy(ccc, j * BLOCK_SIZE);
    }
    let ccc1 = xorBlocks(mc, tweak);
    for (let j = 1; j < m; j += 1) ccc1 = xorBlocks(ccc1, block(ccc, j));
    ccc1.copy(ccc, 0);

    // Cj = AES(CCCj) xor 2^(j-1)L
    const cc = this.aes(ccc, encrypt);
    const out = Buffer.alloc(input.length);
    for (let j = 0; j < m; j += 1) {
      xorBlocks(block(cc, j), this.lTable[j]).copy(out, j * BLOCK_SIZE);
    }
    return out;
  }
}
