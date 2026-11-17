import { updateStatus } from "@/src/server";

export const dynamic = "force-dynamic";
export async function GET() {
	return Response.json(await updateStatus(), { headers: { "Cache-Control": "no-store" } });
}
