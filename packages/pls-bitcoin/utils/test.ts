const API_URL = process.env.API_URL || "http://localhost:3000";

export async function takeFromFaucet(address: string) {
	const res = await fetch(`${API_URL}/faucet`, {
		method: "POST",
		body: JSON.stringify({
			address,
		}),
	});

	if (!res.ok) throw new Error(await res.text());

	return (await res.json()).txId;
}

export async function getTransactionHexById(txid: string) {
	const res = await fetch(`${API_URL}/tx/${txid}/hex`);

	if (!res.ok) throw new Error(await res.text());

	return await res.text();
}

export async function publishTransaction(hex: string) {
	const res = await fetch(`${API_URL}/tx`, {
		method: "POST",
		body: hex,
	});

	if (!res.ok) throw new Error(await res.text());

	return await res.text();
}

export async function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function retryWithDelay<T extends any>(
	func: () => Promise<T>,
	ms: number,
	tries: number
) {
	let i = 0;

	while (i < tries) {
		try {
			return await func();
		} catch (error) {
			await sleep(ms);
		}
		i++;
	}

	throw new Error(`Failed after ${tries} retries`);
}
