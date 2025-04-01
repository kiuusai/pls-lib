import { ECPairInterface } from "ecpair";
import { Transaction, confidential } from "liquidjs-lib";
import { zkpLib } from "./utils/index.js";

const Confidential = new confidential.Confidential(zkpLib);

type GetUmblindedUtxoValue = {
	utxo: {
		value?: number;
		vout: number;
		hex: string;
	};
	index?: number;
	blindingKeypair: ECPairInterface;
}

export function getUnblindedUtxoValue({
	utxo,
	index = 0,
	blindingKeypair,
}: GetUmblindedUtxoValue) {
	if (utxo.value) {
		return utxo.value;
	} else {
		try {
			const unblinded = Confidential.unblindOutputWithKey(
				Transaction.fromHex(utxo.hex).outs[utxo.vout]!,
				blindingKeypair.privateKey!
			);

			return Number(unblinded.value);
		} catch (error) {
			console.error(error)
			console.log(`couldn't unblind UTXO ${index}`);

			return null;
		}
	}
}
