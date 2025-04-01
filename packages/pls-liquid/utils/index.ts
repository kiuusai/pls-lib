import { bip341, crypto } from "liquidjs-lib";
import secp256k1 from "@vulpemventures/secp256k1-zkp/lib/index.js";

// @ts-expect-error I have no idea
export const zkpLib: secp256k1 = await secp256k1();

export const combine = <T>(items: Array<T>, size: number): Array<Array<T>> => {
	const intCombine = (
		acc: Array<T>,
		rem: Array<T>,
		curr: number
	): Array<any> => {
		if (curr === 0) return acc;
		return rem.map((i, idx) => {
			return intCombine([...acc, i], rem.slice(idx + 1), curr - 1);
		});
	};

	return intCombine([], items, size).flat(size - 1);
};

// @ionio-lang/ionio
export const H: Buffer = Buffer.from(
	"0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
	"hex"
);

export function tweakScriptPublicKey(
	publicKey: Buffer,
	hash: Buffer,
	ecc = zkpLib.ecc
): bip341.XOnlyPointAddTweakResult {
	const XOnlyPubKey = publicKey.slice(1, 33);
	const toTweak = Buffer.concat([XOnlyPubKey, hash]);
	const tweakHash = crypto.taggedHash("TapTweak/elements", toTweak);
	const tweaked = ecc.xOnlyPointAddTweak(XOnlyPubKey, tweakHash);
	if (!tweaked) throw new Error("Invalid tweaked key");
	return tweaked;
}

// bip341API.taprootOutputScript
export function taprootOutputScript(
	internalPublicKey: Buffer,
	tree?: bip341.HashTree | undefined
) {
	let treeHash = Buffer.alloc(0);
	if (tree) {
		treeHash = tree.hash;
	}

	const { xOnlyPubkey } = tweakScriptPublicKey(internalPublicKey, treeHash);
	return Buffer.concat([Buffer.from([0x51, 0x20]), xOnlyPubkey]);
}

export const serializeSchnnorrSig = (sig: Buffer, hashtype: number) =>
	Buffer.concat([
		sig,
		hashtype !== 0x00 ? Buffer.of(hashtype) : Buffer.alloc(0),
	]);

export function toReversed<T>(arr: T[]): T[] {
	return [...arr].reverse();
}
