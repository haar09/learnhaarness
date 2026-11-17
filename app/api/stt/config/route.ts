import { keyValue, sttConfig } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(sttConfig(keyValue), { headers: { "Cache-Control": "no-store" } });
}
