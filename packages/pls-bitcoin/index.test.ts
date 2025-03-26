import { describe, expect } from "vitest"
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import * as bitcoin from "bitcoinjs-lib";
import { createKeyTweaker } from "./index.js";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";

const ECPair = ECPairFactory(ecc);

describe(
  "createkeyTweaker test",
  (it) => {
    bitcoin.initEccLib(ecc);

    const initialEcpair = ECPair.makeRandom();

    const contentToTweak = "Some content to tweak";
    const tweak = bitcoin.crypto.sha256(Buffer.from(contentToTweak));

    const contentToSign = "Some content to sign";
    const contentHash = bitcoin.crypto.sha256(Buffer.from(contentToSign));

    it("create tweaker preserving initial keypair", () => {
      const tweaker = createKeyTweaker({
        pubkey: initialEcpair.publicKey,
        privkey: initialEcpair.privateKey,
      });

      expect(tweaker.pubkey).toEqual(initialEcpair.publicKey);
      expect(tweaker.privkey).toEqual(initialEcpair.privateKey);
    });

    it("tweak public key correctly", () => {
      const tweaker = createKeyTweaker({
        pubkey: initialEcpair.publicKey,
      });

      const xOnlyPubkey = toXOnly(initialEcpair.publicKey);

      const expectedTweakedXOnlyPubkey = ecc.xOnlyPointAddTweak(xOnlyPubkey, tweak);

      if (!expectedTweakedXOnlyPubkey)
        throw new TypeError("tweak test key is undefined");

      const parityByte = Buffer.from([
        expectedTweakedXOnlyPubkey.parity === 0 ? 0x02 : 0x03,
      ]);

      const expectedTweakedPubkey = Buffer.concat([
        parityByte,
        expectedTweakedXOnlyPubkey.xOnlyPubkey,
      ]);

      const tweakedPubkey = tweaker.tweakPubkey(tweak);

      expect(tweakedPubkey).toEqual(expectedTweakedPubkey);

      expect(tweakedPubkey).not.toEqual(initialEcpair.publicKey);
    });

    it("tweak private key correctly", () => {
      const tweaker = createKeyTweaker({
        pubkey: initialEcpair.publicKey,
        privkey: initialEcpair.privateKey,
      });

      const pubkey = initialEcpair.publicKey;

      if (!initialEcpair.privateKey)
        throw new TypeError("test private key is undefined");

      const hasOddY = pubkey[0] === 3 || (pubkey[0] === 4 && ((pubkey[64] || 0) & 1) === 1);

      const privateKey = hasOddY ? ecc.privateNegate(initialEcpair.privateKey) : initialEcpair.privateKey;

      const privkeyAdd = ecc.privateAdd(privateKey, tweak);

      if (!privkeyAdd)
        throw new TypeError("privkeyAdd is null");

      const expectedTweakedPrivkey = Buffer.from(privkeyAdd);

      const tweakedPrivkey = tweaker.tweakPrivkey(tweak);

      expect(tweakedPrivkey).toEqual(expectedTweakedPrivkey);

      expect(tweakedPrivkey).not.toEqual(initialEcpair.privateKey);
    });

    it("tweak ecpair correctly", () => {
      const tweaker = createKeyTweaker({
        pubkey: initialEcpair.publicKey,
        privkey: initialEcpair.privateKey,
      });

      const tweakedPubkey = tweaker.tweakPubkey(tweak);
      const tweakedPrivkey = tweaker.tweakPrivkey(tweak);

      const tweakedEcpair = tweaker.tweakEcpair(tweak);

      expect(tweakedEcpair.publicKey).toEqual(tweakedPubkey);
      expect(tweakedEcpair.privateKey).toEqual(tweakedPrivkey);
    });

    it("Sign message correctly", () => {
      const tweaker = createKeyTweaker({
        pubkey: initialEcpair.publicKey,
        privkey: initialEcpair.privateKey,
      });

      const tweakedEcpair = tweaker.tweakEcpair(tweak);

      const schnorrSign = tweakedEcpair.signSchnorr(contentHash);

      const validSchnorrSign = tweakedEcpair.verifySchnorr(contentHash, schnorrSign);

      expect(validSchnorrSign).toBeTruthy();

      const ecpairSign = tweakedEcpair.sign(contentHash);

      const validEcpairSign = tweakedEcpair.verify(contentHash, ecpairSign);

      expect(validEcpairSign).toBeTruthy();
    })
  },
)
