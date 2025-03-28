import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371.js";

const ECPair = ECPairFactory(ecc);

type CreateKeyTweakerArgs = {
	pubkey: Buffer;
	privkey?: Buffer;
}

export function createKeyTweaker({ pubkey, privkey }: CreateKeyTweakerArgs) {
	return {
		pubkey,
		privkey,
		tweakPubkey(tweak: Buffer) {
			const xOnlyPubkey = toXOnly(this.pubkey);

			const tweakedPubkey = ecc.xOnlyPointAddTweak(xOnlyPubkey, tweak);

			if (!tweakedPubkey)
				throw new Error('tweak fail');

			const parityByte = Buffer.from([
				tweakedPubkey.parity === 0 ? 0x02 : 0x03,
			]);

			return Buffer.concat([
				parityByte,
				Buffer.from(tweakedPubkey.xOnlyPubkey),
			]);
		},
		tweakPrivkey(tweak: Buffer) {
			if (!this.privkey)
				throw new Error('private key is not present');

			const pubkey = this.pubkey;

			const hasOddY = pubkey[0] === 3 || (pubkey[0] === 4 && ((pubkey[64] || 0) & 1) === 1);

			const privateKey = hasOddY ? ecc.privateNegate(this.privkey) : this.privkey;

			const tweakedPrivkey = ecc.privateAdd(privateKey, tweak);

			if (!tweakedPrivkey)
				throw new Error('tweak fail');

			return Buffer.from(tweakedPrivkey);
		},
		tweakEcpair(tweak: Buffer) {
			if (this.privkey)
				return ECPair.fromPrivateKey(this.tweakPrivkey(tweak));

			return ECPair.fromPublicKey(this.tweakPubkey(tweak));
		},
	}
}
