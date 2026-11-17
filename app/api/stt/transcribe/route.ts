import { keyValue, transcribeDictation } from "@/src/server";

export const runtime = "nodejs";

export function POST(request: Request) {
	return transcribeDictation(request, keyValue);
}
