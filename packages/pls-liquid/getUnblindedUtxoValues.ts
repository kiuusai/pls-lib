import type { ECPairInterface } from "ecpair";
import { getUnblindedUtxoValue } from "./getUnblindedUtxoValue.js";

type GetUnblindedUtxoValues = {
	utxos: {
		value?: number;
		vout: number;
		hex: string;
	}[];
	blindingKeypair: ECPairInterface;
}

export function getUnblindedUtxoValues({
	utxos,
	blindingKeypair,
}: GetUnblindedUtxoValues) {
	return utxos.map((utxo, index) => getUnblindedUtxoValue({
		utxo,
		index,
		blindingKeypair,
	}));
}
